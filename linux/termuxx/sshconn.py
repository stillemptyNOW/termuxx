"""SSH-подключения Termuxx для ПК: ключи и пароли, jump host, SOCKS5, keep-alive и known_hosts.

Модуль не зависит от GTK, кроме вспомогательных функций ask_trust / connect_interactive,
которые импортируют Gtk/Adw лениво.
"""

from __future__ import annotations

import base64
import hashlib
import io
import ipaddress
import os
import shlex
import socket
import struct
import threading
from typing import Callable, Optional

import paramiko

KNOWN_HOSTS = os.path.expanduser("~/.ssh/known_hosts")

__all__ = [
    "SSHError",
    "UnknownHostKey",
    "HostKeyChanged",
    "AuthFailed",
    "NoPassword",
    "ProxyError",
    "Connection",
    "connect",
    "trust_host_key",
    "fingerprint",
    "describe_error",
    "ask_trust",
    "connect_interactive",
    "run_in_thread",
]


# ---------------------------------------------------------------------------
# Ошибки
# ---------------------------------------------------------------------------


class SSHError(Exception):
    """Базовая ошибка Termuxx с понятным сообщением на русском."""


def host_label(hostname: str, port: int) -> str:
    return hostname if int(port) == 22 else f"{hostname}:{port}"


def known_hosts_entry(hostname: str, port: int) -> str:
    """Имя хоста в формате known_hosts: `host` для 22-го порта, `[host]:port` для остальных."""
    return hostname if int(port) == 22 else f"[{hostname}]:{port}"


def fingerprint(key: paramiko.PKey) -> str:
    """Отпечаток как у OpenSSH: `ssh-ed25519 SHA256:…`."""
    digest = hashlib.sha256(key.asbytes()).digest()
    b64 = base64.b64encode(digest).decode().rstrip("=")
    return f"{key.get_name()} SHA256:{b64}"


class UnknownHostKey(SSHError):
    """Сервер ещё не известен — нужно подтвердить отпечаток его ключа."""

    def __init__(self, hostname: str, port: int, key: paramiko.PKey):
        self.hostname = hostname
        self.port = int(port)
        self.key = key
        self.key_type = key.get_name()
        self.fingerprint = fingerprint(key)
        super().__init__(
            f"Новый сервер {host_label(hostname, port)}. Проверьте отпечаток ключа: {self.fingerprint}"
        )


class HostKeyChanged(SSHError):
    """Ключ сервера не совпадает с сохранённым в known_hosts — возможна подмена."""

    def __init__(self, hostname: str, port: int, expected: Optional[str], got: Optional[str]):
        self.hostname = hostname
        self.port = int(port)
        self.expected = expected
        self.got = got
        super().__init__(
            "Ключ сервера изменился!\n"
            f"Сервер: {host_label(hostname, port)}\n"
            f"Было: {expected or '—'}\nСейчас: {got or '—'}\n"
            "Если вы переустанавливали сервер, удалите старую запись: "
            f"ssh-keygen -R '{known_hosts_entry(hostname, port)}'"
        )


class AuthFailed(SSHError):
    pass


class NoPassword(SSHError):
    def __init__(self, server_title: str):
        self.server_title = server_title
        super().__init__(f"Не указан пароль для {server_title}.")


class ProxyError(SSHError):
    pass


# ---------------------------------------------------------------------------
# known_hosts
# ---------------------------------------------------------------------------


def _load_known_hosts() -> paramiko.HostKeys:
    keys = paramiko.HostKeys()
    if os.path.exists(KNOWN_HOSTS):
        try:
            keys.load(KNOWN_HOSTS)
        except (IOError, paramiko.SSHException):
            pass
    return keys


def trust_host_key(err: UnknownHostKey) -> None:
    """Добавляет ключ сервера в ~/.ssh/known_hosts (как `ssh` после ответа «yes»)."""
    os.makedirs(os.path.dirname(KNOWN_HOSTS), mode=0o700, exist_ok=True)
    entry = known_hosts_entry(err.hostname, err.port)
    line = f"{entry} {err.key.get_name()} {err.key.get_base64()}\n"
    needs_newline = False
    if os.path.exists(KNOWN_HOSTS) and os.path.getsize(KNOWN_HOSTS) > 0:
        with open(KNOWN_HOSTS, "rb") as f:
            f.seek(-1, os.SEEK_END)
            needs_newline = f.read(1) != b"\n"
    fd = os.open(KNOWN_HOSTS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as f:
        if needs_newline:
            f.write("\n")
        f.write(line)


class _RaiseUnknownPolicy(paramiko.MissingHostKeyPolicy):
    def __init__(self, hostname: str, port: int):
        self.hostname = hostname
        self.port = port

    def missing_host_key(self, client, hostname, key):
        raise UnknownHostKey(self.hostname, self.port, key)


# ---------------------------------------------------------------------------
# Ключи
# ---------------------------------------------------------------------------


def _key_classes():
    classes = []
    for name in ("Ed25519Key", "ECDSAKey", "RSAKey", "DSSKey"):
        cls = getattr(paramiko, name, None)
        if cls is not None:
            classes.append(cls)
    return classes


def load_private_key(pem: str, passphrase: Optional[str] = None) -> paramiko.PKey:
    """Разбирает приватный ключ OpenSSH/PEM (Ed25519, ECDSA, RSA), в том числе защищённый паролем."""
    text = pem.strip() + "\n"
    password = passphrase or None
    needs_password = False
    last_error: Optional[Exception] = None
    for cls in _key_classes():
        try:
            return cls.from_private_key(io.StringIO(text), password=password)
        except paramiko.PasswordRequiredException as e:
            needs_password = True
            last_error = e
        except (paramiko.SSHException, ValueError, TypeError, IndexError, AssertionError) as e:
            msg = str(e).lower()
            if any(w in msg for w in ("password", "decrypt", "checkint", "passphrase")):
                needs_password = needs_password or bool(password)
            last_error = e
    if needs_password and not password:
        raise AuthFailed("Ключ защищён паролем (passphrase). Укажите его в настройках ключа.")
    if needs_password:
        raise AuthFailed("Неверный пароль от ключа.")
    raise AuthFailed(f"Не удалось прочитать приватный ключ: {last_error}")


# ---------------------------------------------------------------------------
# SOCKS5
# ---------------------------------------------------------------------------


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ProxyError("SOCKS5-прокси закрыл соединение.")
        data += chunk
    return data


_SOCKS_REASONS = {
    1: "общая ошибка",
    2: "запрещено правилами прокси",
    3: "сеть недоступна",
    4: "хост недоступен",
    5: "соединение отклонено",
    6: "истёк TTL",
    7: "команда не поддерживается",
    8: "тип адреса не поддерживается",
}


def _builtin_socks5(proxy_host, proxy_port, username, password, target_host, target_port, timeout):
    """Минимальный клиент SOCKS5 (RFC 1928 + RFC 1929)."""
    sock = socket.create_connection((proxy_host, int(proxy_port)), timeout=timeout)
    try:
        if username:
            sock.sendall(b"\x05\x02\x00\x02")
        else:
            sock.sendall(b"\x05\x01\x00")
        ver, method = _recv_exact(sock, 2)
        if ver != 5:
            raise ProxyError("SOCKS5-прокси ответил непонятно.")
        if method == 0x02:
            user = (username or "").encode()[:255]
            pw = (password or "").encode()[:255]
            sock.sendall(bytes([1, len(user)]) + user + bytes([len(pw)]) + pw)
            _, status = _recv_exact(sock, 2)
            if status != 0:
                raise ProxyError("SOCKS5-прокси: неверный логин или пароль.")
        elif method != 0x00:
            raise ProxyError("SOCKS5-прокси не принял способ авторизации.")

        try:
            ip = ipaddress.ip_address(target_host)
            if ip.version == 4:
                addr = b"\x01" + ip.packed
            else:
                addr = b"\x04" + ip.packed
        except ValueError:
            host = target_host.encode("idna")[:255]
            addr = b"\x03" + bytes([len(host)]) + host
        sock.sendall(b"\x05\x01\x00" + addr + struct.pack(">H", int(target_port)))
        head = _recv_exact(sock, 4)
        if head[1] != 0:
            raise ProxyError(
                "SOCKS5-прокси не смог подключиться к серверу: "
                + _SOCKS_REASONS.get(head[1], f"код {head[1]}")
            )
        atyp = head[3]
        if atyp == 1:
            _recv_exact(sock, 4 + 2)
        elif atyp == 3:
            length = _recv_exact(sock, 1)[0]
            _recv_exact(sock, length + 2)
        elif atyp == 4:
            _recv_exact(sock, 16 + 2)
        else:
            raise ProxyError("SOCKS5-прокси ответил непонятно.")
        sock.settimeout(None)
        return sock
    except Exception:
        sock.close()
        raise


def _socks5_socket(proxy, proxy_password, target_host, target_port, timeout):
    host = getattr(proxy, "host", "") or ""
    port = int(getattr(proxy, "port", 1080) or 1080)
    username = getattr(proxy, "username", "") or ""
    try:
        import socks  # PySocks

        s = socks.socksocket()
        s.settimeout(timeout)
        s.set_proxy(socks.SOCKS5, host, port, rdns=True, username=username or None,
                    password=proxy_password or None)
        try:
            s.connect((target_host, int(target_port)))
        except socks.ProxyError as e:  # type: ignore[attr-defined]
            s.close()
            raise ProxyError(f"SOCKS5-прокси: {e}") from e
        s.settimeout(None)
        return s
    except ImportError:
        return _builtin_socks5(host, port, username, proxy_password, target_host, target_port, timeout)


# ---------------------------------------------------------------------------
# Подключение
# ---------------------------------------------------------------------------


class Connection:
    """Живое SSH-подключение (и, если был, промежуточный сервер)."""

    def __init__(self, client: paramiko.SSHClient, server, jump: Optional["Connection"] = None):
        self.client = client
        self.server = server
        self.jump = jump
        self._closed = False

    @property
    def transport(self) -> Optional[paramiko.Transport]:
        return self.client.get_transport()

    @property
    def is_active(self) -> bool:
        t = self.transport
        return bool(t is not None and t.is_active())

    def exec(self, cmd: str, timeout: float = 30, stdin: Optional[str] = None) -> tuple[int, str]:
        """Выполняет команду, возвращает (код выхода, stdout+stderr)."""
        transport = self.transport
        if transport is None or not transport.is_active():
            raise SSHError("SSH-соединение закрыто.")
        chan = transport.open_session(timeout=timeout)
        try:
            chan.settimeout(timeout)
            chan.set_combine_stderr(True)
            chan.exec_command(cmd)
            if stdin is not None:
                chan.sendall(stdin.encode())
                chan.shutdown_write()
            chunks = []
            while True:
                try:
                    data = chan.recv(65536)
                except socket.timeout as e:
                    raise SSHError(f"Команда не завершилась за {int(timeout)} с.") from e
                if not data:
                    break
                chunks.append(data)
            code = chan.recv_exit_status()
            return code, b"".join(chunks).decode("utf-8", errors="replace")
        finally:
            chan.close()

    def run_script(self, script: str, timeout: float = 30) -> tuple[int, str]:
        """Запускает shell-скрипт через `sh -s` — не зависит от оболочки пользователя (fish и т. п.)."""
        return self.exec("sh -s", timeout=timeout, stdin=script)

    def open_sftp(self) -> paramiko.SFTPClient:
        return self.client.open_sftp()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.client.close()
        except Exception:
            pass
        if self.jump is not None:
            self.jump.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def _attr(obj, *names, default=None):
    for name in names:
        if obj is not None and hasattr(obj, name):
            value = getattr(obj, name)
            if value is not None:
                return value
    return default


def _server_title(server) -> str:
    title = _attr(server, "title", default=None)
    if title:
        return title
    return _attr(server, "name", default=None) or _attr(server, "hostname", default="сервер")


def _auth_kwargs(store, server, password: Optional[str]) -> dict:
    auth = _attr(server, "auth", default="password")
    if auth == "key":
        key_id = _attr(server, "key_id", "keyID")
        pem = store.private_key(key_id) if key_id else None
        if not pem:
            raise AuthFailed("Для этого сервера не выбран SSH-ключ.")
        passphrase = store.passphrase(key_id) if hasattr(store, "passphrase") else None
        pkey = load_private_key(pem, passphrase)
        return {"pkey": pkey, "look_for_keys": False, "allow_agent": False}
    pw = password if password else store.password(server)
    if not pw:
        raise NoPassword(_server_title(server))
    return {"password": pw, "look_for_keys": False, "allow_agent": False}


def connect(store, server, password: Optional[str] = None, timeout: float = 15,
            _depth: int = 0) -> Connection:
    """Подключается к серверу. Бросает UnknownHostKey / HostKeyChanged / AuthFailed / NoPassword / SSHError."""
    hostname = str(_attr(server, "hostname", default="")).strip()
    port = int(_attr(server, "port", default=22) or 22)
    username = str(_attr(server, "username", default="root") or "root")
    if not hostname:
        raise SSHError("Не указан адрес сервера.")

    auth_kwargs = _auth_kwargs(store, server, password)

    jump_conn: Optional[Connection] = None
    sock = None
    jump_id = _attr(server, "jump_host_id", "jumpHostID")
    try:
        if jump_id and _depth == 0:
            jump_server = store.server(jump_id)
            if jump_server is None or _attr(jump_server, "id") == _attr(server, "id"):
                raise SSHError("Промежуточный сервер не найден. Выберите его заново в настройках сервера.")
            jump_conn = connect(store, jump_server, None, timeout=timeout, _depth=1)
            try:
                sock = jump_conn.transport.open_channel(
                    "direct-tcpip", (hostname, port), ("127.0.0.1", 0), timeout=timeout
                )
            except paramiko.ChannelException as e:
                raise SSHError(
                    f"Промежуточный сервер {_server_title(jump_server)} не смог подключиться к "
                    f"{host_label(hostname, port)}: {e}"
                ) from e
        else:
            proxy = _attr(server, "proxy")
            if proxy is not None and (_attr(proxy, "host", default="") or "").strip():
                proxy_password = store.proxy_password(server) if hasattr(store, "proxy_password") else None
                try:
                    sock = _socks5_socket(proxy, proxy_password, hostname, port, timeout)
                except ProxyError:
                    raise
                except OSError as e:
                    raise ProxyError(f"Не удалось подключиться к SOCKS5-прокси: {e}") from e

        client = paramiko.SSHClient()
        if os.path.exists(KNOWN_HOSTS):
            try:
                client.load_system_host_keys(KNOWN_HOSTS)
            except (IOError, paramiko.SSHException):
                pass
        client.set_missing_host_key_policy(_RaiseUnknownPolicy(hostname, port))
        try:
            client.connect(
                hostname,
                port=port,
                username=username,
                timeout=timeout,
                banner_timeout=timeout,
                auth_timeout=timeout,
                sock=sock,
                **auth_kwargs,
            )
        except paramiko.BadHostKeyException as e:
            client.close()
            raise HostKeyChanged(
                hostname, port,
                fingerprint(e.expected_key) if e.expected_key is not None else None,
                fingerprint(e.key) if e.key is not None else None,
            ) from e
        except UnknownHostKey:
            client.close()
            raise
        except paramiko.AuthenticationException as e:
            client.close()
            raise AuthFailed(describe_error(e)) from e
        except Exception:
            client.close()
            raise

        transport = client.get_transport()
        if transport is not None and _attr(server, "keep_alive", "keepAlive", default=True):
            transport.set_keepalive(30)
        if _depth == 0 and hasattr(store, "mark_connected"):
            try:
                store.mark_connected(server)
            except Exception:
                pass
        return Connection(client, server, jump_conn)
    except Exception:
        if jump_conn is not None:
            jump_conn.close()
        elif sock is not None:
            try:
                sock.close()
            except Exception:
                pass
        raise


def describe_error(e: BaseException) -> str:
    """Человеческое описание ошибки подключения на русском."""
    if isinstance(e, SSHError):
        return str(e)
    if isinstance(e, paramiko.PasswordRequiredException):
        return "Ключ защищён паролем (passphrase)."
    if isinstance(e, paramiko.BadAuthenticationType):
        allowed = ", ".join(getattr(e, "allowed_types", []) or [])
        if "password" not in allowed:
            return "Сервер не разрешает вход по паролю — используйте ключ." + (f" Доступно: {allowed}." if allowed else "")
        return f"Сервер не принимает этот способ входа. Доступно: {allowed}."
    if isinstance(e, paramiko.AuthenticationException):
        return "Неверный логин, пароль или ключ."
    if isinstance(e, paramiko.ssh_exception.NoValidConnectionsError):
        return "Соединение отклонено. Проверьте адрес и порт."
    if isinstance(e, ConnectionRefusedError):
        return "Соединение отклонено. Проверьте адрес и порт."
    if isinstance(e, socket.gaierror):
        return "Не удалось найти сервер по имени. Проверьте адрес."
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "Сервер не отвечает (таймаут)."
    if isinstance(e, paramiko.ChannelException):
        return f"Сервер отклонил канал: {e}"
    if isinstance(e, paramiko.SSHException):
        text = str(e)
        if "banner" in text.lower():
            return "Сервер не ответил по протоколу SSH (возможно, порт занят другим сервисом или соединение режется)."
        if "Unable to connect" in text:
            return "Не удалось подключиться к серверу."
        return f"Ошибка SSH: {text}"
    if isinstance(e, OSError):
        if e.errno in (101, 113):
            return "Сеть недоступна."
        if e.errno == 111:
            return "Соединение отклонено. Проверьте адрес и порт."
        if e.errno in (104, 32):
            return "Соединение сброшено."
        return f"Сетевая ошибка: {e.strerror or e}"
    return str(e) or e.__class__.__name__


def shell_quote(text: str) -> str:
    return shlex.quote(text)


# ---------------------------------------------------------------------------
# Помощники для GTK-окон
# ---------------------------------------------------------------------------


def run_in_thread(fn: Callable, on_success: Optional[Callable] = None,
                  on_error: Optional[Callable] = None) -> threading.Thread:
    """Запускает fn() в фоне; результат/ошибку передаёт в главный поток через GLib.idle_add."""
    from gi.repository import GLib

    def worker():
        try:
            result = fn()
        except BaseException as e:  # noqa: BLE001 — показываем любую ошибку пользователю
            if on_error is not None:
                GLib.idle_add(_call_once, on_error, e)
            return
        if on_success is not None:
            GLib.idle_add(_call_once, on_success, result)

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return t


def _call_once(fn, arg):
    fn(arg)
    return False


def ask_trust(parent, err: UnknownHostKey, on_trust: Callable[[], None],
              on_cancel: Optional[Callable[[], None]] = None) -> None:
    """Диалог «Доверять новому серверу?» с отпечатком ключа."""
    import gi

    gi.require_version("Adw", "1")
    from gi.repository import Adw, GLib

    label = host_label(err.hostname, err.port)
    body = (
        f"Вы подключаетесь к <b>{GLib.markup_escape_text(label)}</b> впервые.\n\n"
        f"<tt>{GLib.markup_escape_text(err.fingerprint)}</tt>\n\n"
        "Сверьте отпечаток на сервере командой\n"
        "<tt>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</tt>"
    )

    def handle(response: str):
        if response == "trust":
            try:
                trust_host_key(err)
            except OSError as e:
                if on_cancel:
                    on_cancel()
                _show_error(parent, "Не удалось записать known_hosts", str(e))
                return
            on_trust()
        elif on_cancel:
            on_cancel()

    if hasattr(Adw, "AlertDialog"):
        dialog = Adw.AlertDialog(heading="Новый сервер", body=body, body_use_markup=True)
        dialog.add_response("cancel", "Отмена")
        dialog.add_response("trust", "Доверять и подключиться")
        dialog.set_response_appearance("trust", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("trust")
        dialog.set_close_response("cancel")
        dialog.connect("response", lambda _d, r: handle(r))
        dialog.present(parent)
    else:
        dialog = Adw.MessageDialog(transient_for=parent, heading="Новый сервер", body=body,
                                   body_use_markup=True)
        dialog.add_response("cancel", "Отмена")
        dialog.add_response("trust", "Доверять и подключиться")
        dialog.set_response_appearance("trust", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("trust")
        dialog.set_close_response("cancel")
        dialog.connect("response", lambda _d, r: handle(r))
        dialog.present()


def _show_error(parent, heading: str, body: str) -> None:
    from gi.repository import Adw

    if hasattr(Adw, "AlertDialog"):
        d = Adw.AlertDialog(heading=heading, body=body)
        d.add_response("ok", "OK")
        d.present(parent)
    else:
        d = Adw.MessageDialog(transient_for=parent, heading=heading, body=body)
        d.add_response("ok", "OK")
        d.present()


def connect_interactive(parent, store, server, password: Optional[str],
                        on_connected: Callable[[Connection], None],
                        on_error: Callable[[BaseException], None],
                        timeout: float = 15) -> None:
    """Подключается в фоне; на неизвестный ключ показывает диалог доверия и повторяет попытку."""

    def failed(e: BaseException):
        if isinstance(e, UnknownHostKey):
            ask_trust(
                parent, e,
                on_trust=lambda: connect_interactive(parent, store, server, password,
                                                     on_connected, on_error, timeout),
                on_cancel=lambda: on_error(SSHError("Подключение отменено: ключ сервера не подтверждён.")),
            )
            return
        on_error(e)

    run_in_thread(lambda: connect(store, server, password, timeout=timeout), on_connected, failed)
