"""Хранилище серверов, ключей и сниппетов.

Метаданные лежат в ~/.config/termuxx/termuxx.json (ключи JSON — как в iOS-версии, camelCase),
секреты — в системном хранилище паролей (libsecret / GNOME Keyring / KWallet),
а если его нет — в ~/.local/share/termuxx/secrets.json с правами 0600.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

CONFIG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "termuxx")
DATA_DIR = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "termuxx")
STORE_PATH = os.path.join(CONFIG_DIR, "termuxx.json")
KEYS_DIR = os.path.join(DATA_DIR, "keys")
SECRETS_FILE = os.path.join(DATA_DIR, "secrets.json")

HOST_COLORS = ["#3DDC97", "#4EA8FF", "#B48CFF", "#FF7AA2", "#FFB454", "#FF5C5C", "#5CE1E6", "#C7D0DA"]


def new_id() -> str:
    return str(uuid.uuid4()).upper()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_id(value) -> Optional[str]:
    if value is None or value == "":
        return None
    return str(value).upper()


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Модели
# ---------------------------------------------------------------------------


@dataclass
class ProxyConfig:
    host: str = ""
    port: int = 1080
    username: str = ""

    def to_json(self) -> dict:
        return {"host": self.host, "port": self.port, "username": self.username}

    @classmethod
    def from_json(cls, d: Optional[dict]) -> Optional["ProxyConfig"]:
        if not isinstance(d, dict):
            return None
        return cls(host=str(d.get("host") or ""), port=_int(d.get("port"), 1080), username=str(d.get("username") or ""))


@dataclass
class PortForward:
    id: str = field(default_factory=new_id)
    name: str = ""
    local_port: int = 8080
    remote_host: str = "127.0.0.1"
    remote_port: int = 80
    auto_start: bool = True

    @property
    def title(self) -> str:
        if self.name:
            return self.name
        return f"localhost:{self.local_port} → {self.remote_host}:{self.remote_port}"

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "localPort": self.local_port,
            "remoteHost": self.remote_host,
            "remotePort": self.remote_port,
            "autoStart": self.auto_start,
        }

    @classmethod
    def from_json(cls, d: dict) -> "PortForward":
        return cls(
            id=norm_id(d.get("id")) or new_id(),
            name=str(d.get("name") or ""),
            local_port=_int(d.get("localPort"), 8080),
            remote_host=str(d.get("remoteHost") or "127.0.0.1"),
            remote_port=_int(d.get("remotePort"), 80),
            auto_start=bool(d.get("autoStart", True)),
        )


@dataclass
class Server:
    id: str = field(default_factory=new_id)
    name: str = ""
    hostname: str = ""
    port: int = 22
    username: str = "root"
    auth: str = "password"  # "password" | "key"
    key_id: Optional[str] = None
    startup_snippet_id: Optional[str] = None
    color_hex: str = HOST_COLORS[0]
    last_connected: Optional[str] = None
    use_tmux: bool = False
    auto_reconnect: bool = True
    keep_alive: bool = True
    jump_host_id: Optional[str] = None
    proxy: Optional[ProxyConfig] = None
    forwards: list = field(default_factory=list)

    @property
    def title(self) -> str:
        return self.name or self.hostname

    @property
    def subtitle(self) -> str:
        s = f"{self.username}@{self.hostname}"
        if self.port != 22:
            s += f":{self.port}"
        return s

    @property
    def known_hosts_key(self) -> str:
        return f"{self.hostname.lower()}:{self.port}"

    def copy(self) -> "Server":
        return Server.from_json(self.to_json())

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "hostname": self.hostname,
            "port": self.port,
            "username": self.username,
            "auth": self.auth,
            "keyID": self.key_id,
            "startupSnippetID": self.startup_snippet_id,
            "colorHex": self.color_hex,
            "lastConnected": self.last_connected,
            "useTmux": self.use_tmux,
            "autoReconnect": self.auto_reconnect,
            "keepAlive": self.keep_alive,
            "jumpHostID": self.jump_host_id,
            "proxy": self.proxy.to_json() if self.proxy else None,
            "forwards": [f.to_json() for f in self.forwards],
        }

    @classmethod
    def from_json(cls, d: dict) -> "Server":
        auth = d.get("auth") or "password"
        if auth not in ("password", "key"):
            auth = "password"
        last = d.get("lastConnected")
        if isinstance(last, (int, float)):
            # iOS JSONEncoder по умолчанию пишет секунды от 2001-01-01.
            last = datetime.fromtimestamp(978307200 + float(last), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return cls(
            id=norm_id(d.get("id")) or new_id(),
            name=str(d.get("name") or ""),
            hostname=str(d.get("hostname") or ""),
            port=_int(d.get("port"), 22),
            username=str(d.get("username") or "root"),
            auth=auth,
            key_id=norm_id(d.get("keyID")),
            startup_snippet_id=norm_id(d.get("startupSnippetID")),
            color_hex=str(d.get("colorHex") or HOST_COLORS[0]),
            last_connected=last if isinstance(last, str) else None,
            use_tmux=bool(d.get("useTmux", False)),
            auto_reconnect=bool(d.get("autoReconnect", True)),
            keep_alive=bool(d.get("keepAlive", True)),
            jump_host_id=norm_id(d.get("jumpHostID")),
            proxy=ProxyConfig.from_json(d.get("proxy")),
            forwards=[PortForward.from_json(f) for f in (d.get("forwards") or []) if isinstance(f, dict)],
        )

    @classmethod
    def quick(cls, raw: str) -> Optional["Server"]:
        """Разбирает строку вида `user@host:port`, `ssh user@host -p 2222` или `ssh://user@host:port`."""
        text = (raw or "").strip()
        if not text:
            return None
        if text.startswith("ssh://"):
            text = text[len("ssh://"):].rstrip("/")
        port = None
        if text.startswith("ssh "):
            parts = text.split()[1:]
            rest = []
            i = 0
            while i < len(parts):
                if parts[i] == "-p" and i + 1 < len(parts):
                    port = _int(parts[i + 1], 22)
                    i += 2
                    continue
                rest.append(parts[i])
                i += 1
            text = rest[0] if rest else ""
        server = cls()
        if "@" in text:
            user, text = text.rsplit("@", 1)
            server.username = user or "root"
        if text.startswith("[") and "]" in text:  # [ipv6]:port
            host, _, tail = text[1:].partition("]")
            text = host
            if tail.startswith(":"):
                port = _int(tail[1:], 22)
        elif text.count(":") == 1:
            host, _, p = text.partition(":")
            if p.isdigit():
                text, port = host, int(p)
        if not text:
            return None
        server.hostname = text
        if port:
            server.port = port
        return server


@dataclass
class KeyItem:
    id: str = field(default_factory=new_id)
    name: str = ""
    type: str = "ED25519"
    public_key: str = ""
    created: str = field(default_factory=now_iso)
    encrypted: Optional[bool] = None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "publicKey": self.public_key,
            "created": self.created,
            "encrypted": self.encrypted,
        }

    @classmethod
    def from_json(cls, d: dict) -> "KeyItem":
        created = d.get("created")
        if isinstance(created, (int, float)):
            created = datetime.fromtimestamp(978307200 + float(created), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        enc = d.get("encrypted")
        return cls(
            id=norm_id(d.get("id")) or new_id(),
            name=str(d.get("name") or ""),
            type=str(d.get("type") or "ED25519"),
            public_key=str(d.get("publicKey") or ""),
            created=created if isinstance(created, str) else now_iso(),
            encrypted=bool(enc) if enc is not None else None,
        )


@dataclass
class Snippet:
    id: str = field(default_factory=new_id)
    name: str = ""
    command: str = ""
    run_immediately: bool = True

    def to_json(self) -> dict:
        return {"id": self.id, "name": self.name, "command": self.command, "runImmediately": self.run_immediately}

    @classmethod
    def from_json(cls, d: dict) -> "Snippet":
        return cls(
            id=norm_id(d.get("id")) or new_id(),
            name=str(d.get("name") or ""),
            command=str(d.get("command") or ""),
            run_immediately=bool(d.get("runImmediately", True)),
        )


DEFAULT_SNIPPETS = [
    Snippet(name="Нагрузка", command="htop || top"),
    Snippet(name="Место на диске", command="df -h"),
    Snippet(name="Память", command="free -h"),
    Snippet(name="Обновить систему", command="sudo pacman -Syu || (sudo apt update && sudo apt upgrade -y)", run_immediately=False),
    Snippet(name="Сервисы с ошибками", command="systemctl --failed"),
    Snippet(name="Открытые порты", command="ss -tulpn"),
]


# ---------------------------------------------------------------------------
# Секреты
# ---------------------------------------------------------------------------


class _FileSecrets:
    """Запасной вариант: JSON-файл с правами 0600."""

    name = "file"

    def __init__(self):
        self._data = {}
        try:
            with open(SECRETS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._data = {str(k): str(v) for k, v in data.items()}
        except (OSError, ValueError):
            pass

    def get(self, account: str) -> Optional[str]:
        return self._data.get(account)

    def set(self, account: str, value: Optional[str]) -> None:
        if value:
            self._data[account] = value
        else:
            self._data.pop(account, None)
        os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
        tmp = SECRETS_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, SECRETS_FILE)
        os.chmod(SECRETS_FILE, 0o600)


class _LibSecret:
    """GNOME Keyring / KWallet через libsecret (Secret Service API)."""

    name = "libsecret"

    def __init__(self):
        import gi

        gi.require_version("Secret", "1")
        from gi.repository import Secret

        self.Secret = Secret
        self.schema = Secret.Schema.new(
            "com.stillempty.termuxx",
            Secret.SchemaFlags.NONE,
            {"account": Secret.SchemaAttributeType.STRING},
        )
        # Проверяем, что служба доступна (бросит GLib.Error, если её нет).
        Secret.password_lookup_sync(self.schema, {"account": "__probe__"}, None)

    def get(self, account: str) -> Optional[str]:
        return self.Secret.password_lookup_sync(self.schema, {"account": account}, None)

    def set(self, account: str, value: Optional[str]) -> None:
        if value:
            self.Secret.password_store_sync(
                self.schema, {"account": account}, self.Secret.COLLECTION_DEFAULT, f"Termuxx: {account}", value, None
            )
        else:
            self.Secret.password_clear_sync(self.schema, {"account": account}, None)


def _make_secret_backend():
    if os.environ.get("TERMUXX_SECRETS") == "file" or not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        return _FileSecrets()
    try:
        return _LibSecret()
    except Exception:
        return _FileSecrets()


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class Store:
    _instance: Optional["Store"] = None

    @classmethod
    def get(cls) -> "Store":
        if cls._instance is None:
            cls._instance = Store()
        return cls._instance

    def __init__(self, path: str = STORE_PATH):
        self.path = path
        self.servers: list[Server] = []
        self.keys: list[KeyItem] = []
        self.snippets: list[Snippet] = []
        self.known_hosts: dict[str, str] = {}
        self._listeners: list[Callable[[], None]] = []
        self._secrets = None
        self._secret_cache: dict[str, Optional[str]] = {}
        self._lock = threading.RLock()
        self.load()

    # --- загрузка / сохранение -------------------------------------------------

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = None
        if not isinstance(data, dict):
            self.servers, self.keys = [], []
            self.snippets = [Snippet(name=s.name, command=s.command, run_immediately=s.run_immediately) for s in DEFAULT_SNIPPETS]
            self.known_hosts = {}
            return
        self.servers = [Server.from_json(d) for d in data.get("hosts") or [] if isinstance(d, dict)]
        self.keys = [KeyItem.from_json(d) for d in data.get("keys") or [] if isinstance(d, dict)]
        self.snippets = [Snippet.from_json(d) for d in data.get("snippets") or [] if isinstance(d, dict)]
        kh = data.get("knownHosts")
        self.known_hosts = {str(k): str(v) for k, v in kh.items()} if isinstance(kh, dict) else {}

    def to_json(self) -> dict:
        return {
            "format": "termuxx-store",
            "version": 1,
            "hosts": [s.to_json() for s in self.servers],
            "keys": [k.to_json() for k in self.keys],
            "snippets": [s.to_json() for s in self.snippets],
            "knownHosts": self.known_hosts,
        }

    def save(self) -> None:
        with self._lock:
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.to_json(), f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        self._notify()

    def subscribe(self, callback: Callable[[], None]) -> None:
        self._listeners.append(callback)

    def unsubscribe(self, callback: Callable[[], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def _notify(self) -> None:
        try:
            from gi.repository import GLib
        except Exception:  # без GLib (тесты) — вызываем сразу
            for cb in list(self._listeners):
                cb()
            return

        def run():
            for cb in list(self._listeners):
                try:
                    cb()
                except Exception as e:  # слушатель не должен ронять приложение
                    print("termuxx: listener error:", e)
            return False

        GLib.idle_add(run)

    # --- серверы ---------------------------------------------------------------

    def server(self, server_id) -> Optional[Server]:
        sid = norm_id(server_id)
        return next((s for s in self.servers if s.id == sid), None)

    def upsert_server(self, server: Server) -> None:
        for i, s in enumerate(self.servers):
            if s.id == server.id:
                self.servers[i] = server
                break
        else:
            self.servers.append(server)
        self.save()

    def delete_server(self, server: Server) -> None:
        self.servers = [s for s in self.servers if s.id != server.id]
        for s in self.servers:
            if s.jump_host_id == server.id:
                s.jump_host_id = None
        self._set_secret(f"pw.{server.id}", None)
        self._set_secret(f"proxy.{server.id}", None)
        self.save()

    def duplicate_server(self, server: Server) -> Server:
        copy = server.copy()
        copy.id = new_id()
        copy.name = f"{server.title} (копия)"
        copy.last_connected = None
        for f in copy.forwards:
            f.id = new_id()
        self.servers.append(copy)
        pw = self.password(server)
        if pw:
            self.set_password(copy, pw)
        ppw = self.proxy_password(server)
        if ppw:
            self.set_proxy_password(copy, ppw)
        self.save()
        return copy

    def mark_connected(self, server: Server) -> None:
        s = self.server(server.id)
        if s is not None:
            s.last_connected = now_iso()
            self.save()

    def sorted_servers(self) -> list[Server]:
        return sorted(self.servers, key=lambda s: (s.last_connected or "", s.title.lower()), reverse=True)

    # --- ключи -----------------------------------------------------------------

    def key(self, key_id) -> Optional[KeyItem]:
        kid = norm_id(key_id)
        return next((k for k in self.keys if k.id == kid), None)

    def add_key(self, item: KeyItem, private_key: str, passphrase: Optional[str] = None) -> None:
        self._set_secret(f"key.{item.id}", private_key)
        self._set_secret(f"keypass.{item.id}", passphrase or None)
        self.keys.append(item)
        self.save()

    def delete_key(self, item: KeyItem) -> None:
        self._set_secret(f"key.{item.id}", None)
        self._set_secret(f"keypass.{item.id}", None)
        self.keys = [k for k in self.keys if k.id != item.id]
        for s in self.servers:
            if s.key_id == item.id:
                s.key_id = None
        try:
            os.remove(os.path.join(KEYS_DIR, item.id))
        except OSError:
            pass
        self.save()

    def private_key(self, key_id) -> Optional[str]:
        kid = norm_id(key_id)
        return self._get_secret(f"key.{kid}") if kid else None

    def passphrase(self, key_id) -> Optional[str]:
        kid = norm_id(key_id)
        return self._get_secret(f"keypass.{kid}") if kid else None

    def set_passphrase(self, key_id, value: Optional[str]) -> None:
        kid = norm_id(key_id)
        if kid:
            self._set_secret(f"keypass.{kid}", value or None)

    def key_file(self, key_id) -> Optional[str]:
        """Пишет приватный ключ в файл 0600 (нужно системному ssh) и возвращает путь."""
        kid = norm_id(key_id)
        pem = self.private_key(kid) if kid else None
        if not pem:
            return None
        text = pem.strip().replace("\r\n", "\n") + "\n"
        os.makedirs(KEYS_DIR, mode=0o700, exist_ok=True)
        os.chmod(KEYS_DIR, 0o700)
        path = os.path.join(KEYS_DIR, kid)
        try:
            with open(path, "r", encoding="utf-8") as f:
                if f.read() == text:
                    os.chmod(path, 0o600)
                    return path
        except OSError:
            pass
        fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(path + ".tmp", path)
        os.chmod(path, 0o600)
        return path

    # --- сниппеты --------------------------------------------------------------

    def snippet(self, snippet_id) -> Optional[Snippet]:
        sid = norm_id(snippet_id)
        return next((s for s in self.snippets if s.id == sid), None)

    def upsert_snippet(self, snippet: Snippet) -> None:
        for i, s in enumerate(self.snippets):
            if s.id == snippet.id:
                self.snippets[i] = snippet
                break
        else:
            self.snippets.append(snippet)
        self.save()

    def delete_snippet(self, snippet: Snippet) -> None:
        self.snippets = [s for s in self.snippets if s.id != snippet.id]
        for s in self.servers:
            if s.startup_snippet_id == snippet.id:
                s.startup_snippet_id = None
        self.save()

    # --- пароли ----------------------------------------------------------------

    def password(self, server: Server) -> Optional[str]:
        return self._get_secret(f"pw.{server.id}")

    def set_password(self, server: Server, password: Optional[str]) -> None:
        self._set_secret(f"pw.{server.id}", password or None)

    def proxy_password(self, server: Server) -> Optional[str]:
        return self._get_secret(f"proxy.{server.id}")

    def set_proxy_password(self, server: Server, password: Optional[str]) -> None:
        self._set_secret(f"proxy.{server.id}", password or None)

    @property
    def secrets_backend(self) -> str:
        return self._backend().name

    def _backend(self):
        if self._secrets is None:
            self._secrets = _make_secret_backend()
        return self._secrets

    def _get_secret(self, account: str) -> Optional[str]:
        with self._lock:
            if account in self._secret_cache:
                return self._secret_cache[account]
            try:
                value = self._backend().get(account)
            except Exception as e:
                print("termuxx: secret lookup failed:", e)
                value = None
            self._secret_cache[account] = value
            return value

    def _set_secret(self, account: str, value: Optional[str]) -> None:
        with self._lock:
            self._secret_cache[account] = value or None
            try:
                self._backend().set(account, value or None)
            except Exception as e:
                print("termuxx: secret store failed, falling back to file:", e)
                self._secrets = _FileSecrets()
                self._secrets.set(account, value or None)
