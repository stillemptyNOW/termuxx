"""Проброс портов для Termuxx: 127.0.0.1:local_port → remote_host:remote_port через SSH.

Одно SSH-подключение на сервер используется всеми его пробросами.
"""

from __future__ import annotations

import errno
import select
import socket
import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import sshconn
from .sshconn import Connection, describe_error


@dataclass
class TunnelStatus:
    forward_id: str
    server_id: str
    server_title: str
    forward: object
    state: str = "starting"  # starting | active | error | stopped
    error: str = ""
    connections: int = 0
    total_connections: int = 0
    bytes_in: int = 0
    bytes_out: int = 0

    @property
    def title(self) -> str:
        return _forward_title(self.forward)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{_fattr(self.forward, 'local_port', 0)}"


def _fattr(obj, name, default=None):
    value = getattr(obj, name, default)
    return default if value is None else value


def _forward_title(forward) -> str:
    title = getattr(forward, "title", None)
    if isinstance(title, str) and title:
        return title
    name = _fattr(forward, "name", "")
    if name:
        return name
    return (f"localhost:{_fattr(forward, 'local_port', 0)} → "
            f"{_fattr(forward, 'remote_host', '127.0.0.1')}:{_fattr(forward, 'remote_port', 0)}")


@dataclass
class TempForward:
    """Временный проброс (не сохраняется в настройках сервера)."""

    local_port: int
    remote_host: str
    remote_port: int
    name: str = ""
    auto_start: bool = False
    id: str = field(default_factory=lambda: str(uuid.uuid4()).upper())

    @property
    def title(self) -> str:
        return self.name or f"localhost:{self.local_port} → {self.remote_host}:{self.remote_port}"


class _Forwarder:
    def __init__(self, manager: "TunnelManager", status: TunnelStatus, server, forward):
        self.manager = manager
        self.status = status
        self.server = server
        self.forward = forward
        self.stop_event = threading.Event()
        self.listener: Optional[socket.socket] = None
        self.thread: Optional[threading.Thread] = None
        self.clients: set = set()
        self.lock = threading.Lock()

    def bind(self):
        port = int(_fattr(self.forward, "local_port", 0))
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as e:
            sock.close()
            if e.errno == errno.EADDRINUSE:
                raise sshconn.SSHError(f"Порт {port} уже занят другой программой.") from e
            if e.errno == errno.EACCES:
                raise sshconn.SSHError(f"Нет прав на порт {port} — используйте порт больше 1024.") from e
            raise
        sock.listen(32)
        sock.settimeout(0.5)
        self.listener = sock

    def start(self):
        self.thread = threading.Thread(target=self._accept_loop, daemon=True,
                                       name=f"termuxx-forward-{self.status.forward_id}")
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.listener is not None:
            try:
                self.listener.close()
            except OSError:
                pass
        with self.lock:
            clients = list(self.clients)
        for s in clients:
            try:
                s.close()
            except OSError:
                pass

    def _accept_loop(self):
        while not self.stop_event.is_set():
            try:
                client, addr = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(client, addr), daemon=True).start()

    def _handle(self, client: socket.socket, addr):
        remote_host = str(_fattr(self.forward, "remote_host", "127.0.0.1"))
        remote_port = int(_fattr(self.forward, "remote_port", 0))
        chan = None
        try:
            conn = self.manager._ensure_connection(self.server, None)
            chan = conn.transport.open_channel("direct-tcpip", (remote_host, remote_port), addr, timeout=15)
        except Exception as e:  # noqa: BLE001
            client.close()
            self.status.error = f"Сервер не открыл канал к {remote_host}:{remote_port}: {describe_error(e)}"
            self.manager._notify()
            return
        with self.lock:
            self.clients.add(client)
            self.status.connections += 1
            self.status.total_connections += 1
        if self.status.error:
            self.status.error = ""
        self.manager._notify()
        try:
            client.setblocking(True)
            while not self.stop_event.is_set():
                readable, _w, _x = select.select([client, chan], [], [], 1.0)
                if client in readable:
                    data = client.recv(65536)
                    if not data:
                        break
                    chan.sendall(data)
                    self.status.bytes_out += len(data)
                if chan in readable:
                    data = chan.recv(65536)
                    if not data:
                        break
                    client.sendall(data)
                    self.status.bytes_in += len(data)
                if chan.closed:
                    break
        except (OSError, EOFError):
            pass
        finally:
            for s in (chan, client):
                try:
                    if s is not None:
                        s.close()
                except Exception:
                    pass
            with self.lock:
                self.clients.discard(client)
                self.status.connections = max(0, self.status.connections - 1)
            self.manager._notify()


class TunnelManager:
    _instance: Optional["TunnelManager"] = None
    _instance_lock = threading.Lock()

    @classmethod
    def get(cls, store=None) -> "TunnelManager":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = TunnelManager()
        if store is not None:
            cls._instance.store = store
        return cls._instance

    def __init__(self):
        self.store = None
        self._lock = threading.RLock()
        self._conns: dict[str, Connection] = {}
        self._passwords: dict[str, Optional[str]] = {}
        self._forwarders: dict[str, _Forwarder] = {}
        self._statuses: dict[str, TunnelStatus] = {}
        self._subscribers: list[Callable[[], None]] = []

    # ---------------- общедоступное API ----------------

    def subscribe(self, callback: Callable[[], None]) -> None:
        self._subscribers.append(callback)

    def unsubscribe(self, callback: Callable[[], None]) -> None:
        if callback in self._subscribers:
            self._subscribers.remove(callback)

    def is_active(self, forward_id) -> bool:
        st = self._statuses.get(str(forward_id))
        return bool(st and st.state in ("starting", "active"))

    def status(self, forward_id) -> Optional[TunnelStatus]:
        return self._statuses.get(str(forward_id))

    def active(self) -> list[TunnelStatus]:
        return [s for s in self._statuses.values() if s.state in ("starting", "active")]

    def all(self) -> list[TunnelStatus]:
        return list(self._statuses.values())

    def start(self, server, forward, password: Optional[str] = None, store=None,
              on_error: Optional[Callable[[BaseException], None]] = None) -> None:
        """Запускает проброс в фоне. Ошибка — в статусе и (если передан) в on_error (в главном потоке)."""
        if store is not None:
            self.store = store
        fid = str(_fattr(forward, "id", ""))
        if not fid:
            raise ValueError("forward.id is required")
        with self._lock:
            if self.is_active(fid):
                return
            status = TunnelStatus(fid, str(_fattr(server, "id", "")), _server_title(server), forward)
            self._statuses[fid] = status
        if password:
            self._passwords[status.server_id] = password
        self._notify()
        threading.Thread(target=self._start_worker, args=(server, forward, status, password, on_error),
                         daemon=True).start()

    def stop(self, forward_id) -> None:
        fid = str(forward_id)
        with self._lock:
            fw = self._forwarders.pop(fid, None)
            st = self._statuses.get(fid)
            if st is not None:
                st.state = "stopped"
                st.connections = 0
        if fw is not None:
            fw.stop()
        if st is not None:
            self._release_connection(st.server_id)
        self._notify()

    def stop_all_for_server(self, server_id) -> None:
        sid = str(server_id)
        for st in list(self._statuses.values()):
            if st.server_id == sid and st.state in ("starting", "active"):
                self.stop(st.forward_id)
        self._release_connection(sid, force=True)

    def stop_all(self) -> None:
        for st in list(self._statuses.values()):
            if st.state in ("starting", "active"):
                self.stop(st.forward_id)

    def start_auto(self, server, password: Optional[str] = None, store=None) -> None:
        """Запускает все пробросы сервера с auto_start."""
        for fw in list(_fattr(server, "forwards", []) or []):
            if _fattr(fw, "auto_start", False) and not self.is_active(_fattr(fw, "id", "")):
                self.start(server, fw, password, store=store)

    # ---------------- внутреннее ----------------

    def _notify(self):
        try:
            from gi.repository import GLib
        except Exception:  # без GLib (тесты)
            for cb in list(self._subscribers):
                cb()
            return

        def run():
            for cb in list(self._subscribers):
                try:
                    cb()
                except Exception as e:  # noqa: BLE001
                    print("termuxx: tunnel listener error:", e)
            return False

        GLib.idle_add(run)

    def _get_store(self):
        if self.store is not None:
            return self.store
        from . import store as store_module

        cls = getattr(store_module, "Store")
        getter = getattr(cls, "get", None)
        self.store = getter() if callable(getter) else cls()
        return self.store

    def _ensure_connection(self, server, password: Optional[str]) -> Connection:
        sid = str(_fattr(server, "id", ""))
        with self._lock:
            conn = self._conns.get(sid)
            if conn is not None and conn.is_active:
                return conn
            if conn is not None:
                conn.close()
                self._conns.pop(sid, None)
        pw = password or self._passwords.get(sid)
        conn = sshconn.connect(self._get_store(), server, pw)
        with self._lock:
            existing = self._conns.get(sid)
            if existing is not None and existing.is_active:
                conn.close()
                return existing
            self._conns[sid] = conn
        return conn

    def _release_connection(self, server_id: str, force: bool = False):
        with self._lock:
            still_used = any(st.server_id == server_id and st.state in ("starting", "active")
                             for st in self._statuses.values())
            if still_used and not force:
                return
            conn = self._conns.pop(server_id, None)
        if conn is not None:
            threading.Thread(target=conn.close, daemon=True).start()

    def _start_worker(self, server, forward, status: TunnelStatus, password, on_error):
        forwarder = _Forwarder(self, status, server, forward)
        try:
            forwarder.bind()
            self._ensure_connection(server, password)
        except BaseException as e:  # noqa: BLE001
            error = e
            forwarder.stop()
            status.state = "error"
            status.error = describe_error(error)
            self._release_connection(status.server_id)
            self._notify()
            if on_error is not None:
                try:
                    from gi.repository import GLib

                    GLib.idle_add(lambda err=error: (on_error(err), False)[1])
                except ImportError:
                    on_error(error)
            return
        with self._lock:
            if status.state == "stopped":
                forwarder.stop()
                self._release_connection(status.server_id)
                return
            self._forwarders[status.forward_id] = forwarder
            status.state = "active"
            status.error = ""
        forwarder.start()
        self._notify()


def _server_title(server) -> str:
    return getattr(server, "title", None) or _fattr(server, "name", "") or _fattr(server, "hostname", "")


# ---------------------------------------------------------------------------
# Окно
# ---------------------------------------------------------------------------

try:
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("Adw", "1")
    from gi.repository import Adw, Gio, GLib, Gtk

    _HAVE_GTK = True
except (ImportError, ValueError):  # модуль менеджера можно использовать без GTK
    _HAVE_GTK = False


if _HAVE_GTK:

    class TunnelsWindow(Adw.Window):
        def __init__(self, application, store, server, password=None):
            super().__init__(application=application)
            self.store = store
            self.server = server
            self.password = password
            self.manager = TunnelManager.get(store)
            self.temp_forwards: list[TempForward] = []
            self.rows: dict[str, tuple] = {}

            self.set_default_size(680, 560)
            self.set_title(f"Туннели — {getattr(server, 'title', '')}")

            self.toasts = Adw.ToastOverlay()
            toolbar = Adw.ToolbarView()
            self.toasts.set_child(toolbar)
            self.set_content(self.toasts)

            header = Adw.HeaderBar()
            header.set_title_widget(Adw.WindowTitle(title="Проброс портов",
                                                    subtitle=getattr(server, "subtitle", "")))
            add = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="Временный проброс")
            add.connect("clicked", lambda *_: self._add_temp())
            header.pack_start(add)
            toolbar.add_top_bar(header)

            self.page = Adw.PreferencesPage()
            self.group = Adw.PreferencesGroup(
                title="Пробросы",
                description="Порт на этом компьютере → адрес со стороны сервера. "
                            "Постоянные пробросы настраиваются в параметрах сервера.",
            )
            self.page.add(self.group)
            self.empty = Adw.StatusPage(
                icon_name="network-transmit-receive-symbolic",
                title="Нет пробросов",
                description="Добавьте их в настройках сервера или создайте временный кнопкой «+».",
            )
            self.stack = Gtk.Stack()
            self.stack.add_named(self.page, "list")
            self.stack.add_named(self.empty, "empty")
            toolbar.set_content(self.stack)

            self._listener = lambda: self._refresh()
            self.manager.subscribe(self._listener)
            self.connect("close-request", self._on_close)
            self._rebuild()
            self._timer = GLib.timeout_add_seconds(1, self._tick)
            self.present()

        def toast(self, text, timeout=4):
            self.toasts.add_toast(Adw.Toast(title=GLib.markup_escape_text(text), timeout=timeout))

        def _forwards(self) -> list:
            current = self.store.server(getattr(self.server, "id", None)) if hasattr(self.store, "server") else None
            server = current or self.server
            return list(getattr(server, "forwards", []) or []) + list(self.temp_forwards)

        def _rebuild(self):
            for row, *_ in self.rows.values():
                self.group.remove(row)
            self.rows.clear()
            forwards = self._forwards()
            self.stack.set_visible_child_name("list" if forwards else "empty")
            for fw in forwards:
                fid = str(_fattr(fw, "id", ""))
                row = Adw.ActionRow(title=GLib.markup_escape_text(_forward_title(fw)))
                row.set_subtitle_lines(2)
                icon = Gtk.Image(icon_name="network-transmit-receive-symbolic")
                row.add_prefix(icon)
                open_btn = Gtk.Button(icon_name="web-browser-symbolic", tooltip_text="Открыть в браузере",
                                      valign=Gtk.Align.CENTER, css_classes=["flat"])
                open_btn.connect("clicked", lambda _b, fw=fw: self._open(fw))
                copy_btn = Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text="Скопировать адрес",
                                      valign=Gtk.Align.CENTER, css_classes=["flat"])
                copy_btn.connect("clicked", lambda _b, fw=fw: self._copy(fw))
                switch = Gtk.Switch(valign=Gtk.Align.CENTER)
                switch.set_active(self.manager.is_active(fid))
                handler = switch.connect("notify::active", self._on_switch, fw)
                row.add_suffix(copy_btn)
                row.add_suffix(open_btn)
                row.add_suffix(switch)
                if isinstance(fw, TempForward):
                    remove = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Убрать",
                                        valign=Gtk.Align.CENTER, css_classes=["flat"])
                    remove.connect("clicked", lambda _b, fw=fw: self._remove_temp(fw))
                    row.add_suffix(remove)
                self.group.add(row)
                self.rows[fid] = (row, switch, handler, open_btn)
            self._refresh()

        def _refresh(self):
            for fid, (row, switch, handler, open_btn) in self.rows.items():
                st = self.manager.status(fid)
                active = self.manager.is_active(fid)
                if switch.get_active() != active:
                    switch.handler_block(handler)
                    switch.set_active(active)
                    switch.handler_unblock(handler)
                open_btn.set_sensitive(bool(st and st.state == "active"))
                if st is None or st.state == "stopped":
                    text = "Выключен"
                elif st.state == "starting":
                    text = "Подключение…"
                elif st.state == "error":
                    text = f"Ошибка: {st.error}"
                else:
                    text = (f"Работает · {st.url} · соединений: {st.connections}"
                            f" · ↓ {GLib.format_size(st.bytes_in)} ↑ {GLib.format_size(st.bytes_out)}")
                    if st.error:
                        text += f"\n{st.error}"
                row.set_subtitle(GLib.markup_escape_text(text))
            return False

        def _tick(self):
            self._refresh()
            return True

        def _on_switch(self, switch, _pspec, fw):
            fid = str(_fattr(fw, "id", ""))
            if switch.get_active():
                self._start(fw)
            else:
                self.manager.stop(fid)

        def _start(self, fw):
            def failed(e):
                if isinstance(e, sshconn.UnknownHostKey):
                    sshconn.ask_trust(self, e, on_trust=lambda: self._start(fw),
                                      on_cancel=lambda: self.manager.stop(_fattr(fw, "id", "")))
                    return
                if isinstance(e, sshconn.NoPassword):
                    self._ask_password(fw)
                    return
                self.toast(describe_error(e), 6)

            self.manager.start(self.server, fw, self.password, store=self.store, on_error=failed)

        def _ask_password(self, fw):
            from .sftp_window import prompt_text

            def got(pw):
                self.password = pw
                self._start(fw)

            prompt_text(self, "Пароль", f"Пароль для {getattr(self.server, 'subtitle', '')}", "", "Подключиться",
                        got, select_stem=False)

        def _open(self, fw):
            uri = f"http://127.0.0.1:{_fattr(fw, 'local_port', 0)}"
            try:
                launcher_cls = getattr(Gtk, "UriLauncher", None)
                if launcher_cls is not None:
                    launcher_cls.new(uri).launch(self, None, None, None)
                else:
                    Gio.AppInfo.launch_default_for_uri(uri, None)
            except GLib.Error as e:
                self.toast(f"Не удалось открыть браузер: {e.message}")

        def _copy(self, fw):
            from gi.repository import Gdk

            Gdk.Display.get_default().get_clipboard().set(f"127.0.0.1:{_fattr(fw, 'local_port', 0)}")
            self.toast("Адрес скопирован")

        def _add_temp(self):
            dialog = Adw.AlertDialog(heading="Временный проброс",
                                     body="Работает, пока открыто приложение. Не сохраняется.") \
                if hasattr(Adw, "AlertDialog") else Adw.MessageDialog(transient_for=self, heading="Временный проброс")
            grid = Gtk.Grid(column_spacing=8, row_spacing=8)
            local = Gtk.SpinButton.new_with_range(1, 65535, 1)
            local.set_value(8080)
            host = Gtk.Entry(text="127.0.0.1", hexpand=True)
            remote = Gtk.SpinButton.new_with_range(1, 65535, 1)
            remote.set_value(80)
            for i, (label, widget) in enumerate((("Локальный порт", local), ("Хост на сервере", host),
                                                  ("Порт на сервере", remote))):
                grid.attach(Gtk.Label(label=label, xalign=0), 0, i, 1, 1)
                grid.attach(widget, 1, i, 1, 1)
            dialog.set_extra_child(grid)
            dialog.add_response("cancel", "Отмена")
            dialog.add_response("add", "Запустить")
            dialog.set_response_appearance("add", Adw.ResponseAppearance.SUGGESTED)
            dialog.set_default_response("add")
            dialog.set_close_response("cancel")

            def response(_d, r):
                if r != "add":
                    return
                fw = TempForward(int(local.get_value()), host.get_text().strip() or "127.0.0.1",
                                 int(remote.get_value()))
                self.temp_forwards.append(fw)
                self._rebuild()
                self._start(fw)

            dialog.connect("response", response)
            if hasattr(Adw, "AlertDialog") and isinstance(dialog, Adw.AlertDialog):
                dialog.present(self)
            else:
                dialog.present()

        def _remove_temp(self, fw):
            self.manager.stop(fw.id)
            self.temp_forwards = [f for f in self.temp_forwards if f.id != fw.id]
            self._rebuild()

        def _on_close(self, *_):
            self.manager.unsubscribe(self._listener)
            if self._timer:
                GLib.source_remove(self._timer)
                self._timer = 0
            # Временные пробросы живут только с окном; постоянные продолжают работать.
            for fw in self.temp_forwards:
                self.manager.stop(fw.id)
            return False
