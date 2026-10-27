"""Терминальные вкладки: локальная оболочка или SSH-сессия на системном OpenSSH."""

from __future__ import annotations

import os
import re
import time
from typing import Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("Vte", "3.91")

from gi.repository import Adw, Gdk, Gio, GLib, GObject, Gtk, Pango, Vte  # noqa: E402

from termuxx import sshcmd  # noqa: E402
from termuxx.settings import Settings  # noqa: E402
from termuxx.store import Server, Store  # noqa: E402
from termuxx.themes import apply_theme, theme_by_id  # noqa: E402

PCRE2_CASELESS = 0x00000008
PCRE2_MULTILINE = 0x00000400

URL_REGEX = r"(?:https?|ftp|ssh|sftp)://[^\s<>\"'`]+[^\s<>\"'`.,;:!?)\]}]"

CURSOR_SHAPES = {
    "block": Vte.CursorShape.BLOCK,
    "ibeam": Vte.CursorShape.IBEAM,
    "underline": Vte.CursorShape.UNDERLINE,
}


def spawn_in(terminal: Vte.Terminal, cwd: str, argv: list, env: list, callback=None) -> None:
    """Vte.Terminal.spawn_async с учётом разных версий PyGObject (child_setup_data есть не везде)."""
    flags = GLib.SpawnFlags.SEARCH_PATH
    try:
        terminal.spawn_async(Vte.PtyFlags.DEFAULT, cwd, argv, env, flags, None, None, -1, None, callback, None)
    except TypeError:
        terminal.spawn_async(Vte.PtyFlags.DEFAULT, cwd, argv, env, flags, None, -1, None, callback, None)


_FAMILIES: Optional[set] = None


def font_family_available(family: Optional[str]) -> bool:
    """Есть ли шрифт в системе (иначе Pango подставит немоноширинный и буквы «разъедутся»)."""
    global _FAMILIES
    if not family:
        return False
    if _FAMILIES is None:
        try:
            gi.require_version("PangoCairo", "1.0")
            from gi.repository import PangoCairo

            _FAMILIES = {f.get_name().lower() for f in PangoCairo.FontMap.get_default().list_families()}
        except Exception:
            return True
    names = {name.strip().lower() for name in family.split(",")}
    return bool(names & (_FAMILIES | {"monospace", "mono", "sans", "serif"}))


def user_shell() -> str:
    try:
        shell = Vte.get_user_shell()
    except Exception:
        shell = None
    return shell or os.environ.get("SHELL") or "/bin/bash"


class TerminalPane(Gtk.Box):
    """Один терминал (Vte) + баннер состояния подключения."""

    __gsignals__ = {
        "finished": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "title-changed": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "state-changed": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "bell": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "focused": (GObject.SignalFlags.RUN_FIRST, None, ()),
    }

    def __init__(self, kind: str = "local", server: Optional[Server] = None, password: Optional[str] = None,
                 cwd: Optional[str] = None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.kind = kind
        self.server = server
        self.password = password
        self.cwd = cwd
        self.store = Store.get()
        self.settings = Settings.get()
        self.child_pid = -1
        self.state = "idle"  # idle | running | exited | failed
        self.exit_code: Optional[int] = None
        self.retries = 0
        self.spawned_at = 0.0
        self.got_output = False
        self.spawn_error: Optional[str] = None
        self._ssh_cmd: Optional[sshcmd.SSHCommand] = None
        self._retry_source = 0
        self._font_scale = 1.0

        self.banner = Adw.Banner()
        self.banner.connect("button-clicked", self._on_banner_button)
        self.append(self.banner)

        self.terminal = Vte.Terminal()
        self.terminal.set_hexpand(True)
        self.terminal.set_vexpand(True)
        self.terminal.set_mouse_autohide(True)
        self.terminal.set_allow_hyperlink(True)
        self.terminal.set_bold_is_bright(False)
        self.terminal.set_scroll_on_keystroke(True)
        self.terminal.set_scroll_on_output(False)
        self.terminal.add_css_class("termuxx-terminal")

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_child(self.terminal)
        scrolled.set_hexpand(True)
        scrolled.set_vexpand(True)
        self.append(scrolled)

        self.terminal.connect("child-exited", self._on_child_exited)
        self.terminal.connect("bell", lambda *_: self.emit("bell"))
        self.terminal.connect("contents-changed", self._on_contents_changed)
        self.terminal.connect("selection-changed", self._on_selection_changed)
        if GObject.signal_lookup("window-title-changed", Vte.Terminal):
            self.terminal.connect("window-title-changed", lambda *_: self.emit("title-changed"))

        focus = Gtk.EventControllerFocus()
        focus.connect("enter", lambda *_: self.emit("focused"))
        self.terminal.add_controller(focus)

        click = Gtk.GestureClick()
        click.set_button(Gdk.BUTTON_PRIMARY)
        click.connect("pressed", self._on_click)
        self.terminal.add_controller(click)

        try:
            regex = Vte.Regex.new_for_match(URL_REGEX, -1, PCRE2_MULTILINE | PCRE2_CASELESS)
            tag = self.terminal.match_add_regex(regex, 0)
            self.terminal.match_set_cursor_name(tag, "pointer")
        except GLib.Error as e:
            print("termuxx: url regex:", e)

        if hasattr(self.terminal, "set_context_menu_model"):
            menu = Gio.Menu()
            section = Gio.Menu()
            section.append("Копировать", "win.copy")
            section.append("Вставить", "win.paste")
            section.append("Выделить всё", "win.select-all")
            menu.append_section(None, section)
            section = Gio.Menu()
            section.append("Найти…", "win.search")
            section.append("Разделить экран", "win.split")
            section.append("Закрыть панель", "win.close-pane")
            menu.append_section(None, section)
            self.terminal.set_context_menu_model(menu)

        self.apply_settings()
        self.settings.subscribe(self._on_setting_changed)
        self.connect("destroy", lambda *_: self._cleanup())

    # --- оформление -------------------------------------------------------------

    def apply_settings(self) -> None:
        s = self.settings
        apply_theme(self.terminal, theme_by_id(s["themeID"]))
        desc = Pango.FontDescription.from_string(s["font"] or "Monospace 11")
        if not font_family_available(desc.get_family()):
            desc.set_family("Monospace")
        self.terminal.set_font(desc)
        self.terminal.set_font_scale(self._font_scale)
        self.terminal.set_scrollback_lines(int(s["scrollback"]))
        self.terminal.set_cursor_shape(CURSOR_SHAPES.get(s["cursorShape"], Vte.CursorShape.BLOCK))
        self.terminal.set_cursor_blink_mode(Vte.CursorBlinkMode.ON if s["cursorBlink"] else Vte.CursorBlinkMode.OFF)
        self.terminal.set_audible_bell(bool(s["audibleBell"]))

    def _on_setting_changed(self, key: str) -> None:
        self.apply_settings()

    def zoom(self, delta: Optional[float]) -> None:
        if delta is None:
            self._font_scale = 1.0
        else:
            self._font_scale = max(0.5, min(3.0, self._font_scale + delta))
        self.terminal.set_font_scale(self._font_scale)

    # --- свойства ---------------------------------------------------------------

    @property
    def title(self) -> str:
        t = None
        try:
            t = self.terminal.get_window_title()
        except Exception:
            pass
        if self.kind == "ssh" and self.server is not None:
            return self.server.title
        return t or os.path.basename(user_shell())

    @property
    def window_title(self) -> Optional[str]:
        try:
            return self.terminal.get_window_title()
        except Exception:
            return None

    @property
    def is_alive(self) -> bool:
        return self.state == "running"

    def current_directory(self) -> Optional[str]:
        try:
            uri = self.terminal.get_current_directory_uri()
        except Exception:
            uri = None
        if uri:
            try:
                path, _ = GLib.filename_from_uri(uri)
                return path
            except GLib.Error:
                return None
        return None

    # --- запуск -----------------------------------------------------------------

    def spawn(self) -> None:
        self._cancel_retry()
        self.banner.set_revealed(False)
        self.got_output = False
        self.spawn_error = None
        env = ["TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=Termuxx"]
        if self.kind == "ssh" and self.server is not None:
            if self._ssh_cmd is not None:
                self._ssh_cmd.cleanup()
            self._ssh_cmd = sshcmd.build(self.store, self.server, password=self.password)
            argv = self._ssh_cmd.argv
            env += [f"{k}={v}" for k, v in self._ssh_cmd.env.items()]
            cwd = os.path.expanduser("~")
            if self.retries == 0:
                self.terminal.feed(f"\x1b[2m→ {self.server.subtitle}\x1b[0m\r\n".encode())
            self.store.mark_connected(self.server)
        else:
            shell = user_shell()
            argv = [shell]
            cwd = self.cwd if self.cwd and os.path.isdir(self.cwd) else os.path.expanduser("~")
        self.state = "running"
        self.spawned_at = time.monotonic()
        self.emit("state-changed")
        try:
            spawn_in(self.terminal, cwd, argv, env, self._on_spawned)
        except Exception as e:  # некорректный argv и т.п.
            self._spawn_failed(str(e))

    def _on_spawned(self, terminal, pid, error, *args) -> None:
        if error is not None:
            message = error.message if hasattr(error, "message") else str(error)
            self._spawn_failed(message)
            return
        self.child_pid = pid
        if self._ssh_cmd is not None and self._ssh_cmd.temp_files:
            cmd = self._ssh_cmd
            GLib.timeout_add_seconds(60, lambda: (cmd.cleanup(), False)[1])

    def _spawn_failed(self, message: str) -> None:
        self.state = "failed"
        self.spawn_error = message
        self.terminal.feed(f"\r\n\x1b[31m✗ Не удалось запустить: {message}\x1b[0m\r\n".encode())
        self.banner.set_title("Не удалось запустить процесс")
        self.banner.set_button_label("Повторить" if self.kind == "ssh" else "")
        self.banner.set_revealed(True)
        self.emit("state-changed")

    def _on_contents_changed(self, *_):
        if not self.got_output and self.state == "running":
            self.got_output = True
            self.emit("state-changed")

    def _on_selection_changed(self, *_):
        if self.settings["copyOnSelect"] and self.terminal.get_has_selection():
            self.copy()

    def _on_click(self, gesture, n_press, x, y):
        state = gesture.get_current_event_state()
        if not (state & Gdk.ModifierType.CONTROL_MASK):
            return
        uri = None
        try:
            uri = self.terminal.check_hyperlink_at(x, y)
        except Exception:
            pass
        if not uri:
            try:
                uri, _tag = self.terminal.check_match_at(x, y)
            except Exception:
                uri = None
        if uri:
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)
            launcher = Gtk.UriLauncher.new(uri) if hasattr(Gtk, "UriLauncher") else None
            if launcher:
                launcher.launch(self.get_root(), None, None, None)
            else:
                Gio.AppInfo.launch_default_for_uri(uri, None)

    def _on_child_exited(self, terminal, status) -> None:
        try:
            code = os.waitstatus_to_exitcode(status)
        except ValueError:
            code = status
        self.child_pid = -1
        self.exit_code = code
        lived = time.monotonic() - self.spawned_at
        if self._ssh_cmd is not None:
            self._ssh_cmd.cleanup()

        if self.kind != "ssh":
            self.state = "exited"
            self.emit("state-changed")
            self.emit("finished")
            return

        self.state = "exited"
        if code == 0:
            self.terminal.feed("\r\n\x1b[2m— Сессия завершена —\x1b[0m\r\n".encode())
            self._show_banner("Сессия завершена", "Подключиться снова")
        elif code == 255 or (code in (5,) and self._ssh_cmd and self._ssh_cmd.uses_sshpass):
            if code == 5:
                self._show_banner("Неверный пароль — проверьте настройки сервера", "Повторить")
            elif lived > 8 and self.server is not None and self.server.auto_reconnect and self.retries < 3:
                self.retries += 1
                delay = 2 * self.retries
                self.terminal.feed(
                    f"\r\n\x1b[33m⚠ Соединение потеряно. Переподключение через {delay} с…\x1b[0m\r\n".encode()
                )
                self._show_banner(f"Соединение потеряно — переподключение через {delay} с", "Сейчас")
                self._retry_source = GLib.timeout_add_seconds(delay, self._retry)
            else:
                text = "Соединение потеряно" if lived > 8 else "Не удалось подключиться"
                self._show_banner(text, "Переподключить")
        else:
            self._show_banner(f"Сессия завершена (код {code})", "Подключиться снова")
        self.emit("state-changed")

    def _show_banner(self, title: str, button: str) -> None:
        self.banner.set_title(title)
        self.banner.set_button_label(button)
        self.banner.set_revealed(True)

    def _retry(self) -> bool:
        self._retry_source = 0
        self.terminal.feed("\r\n\x1b[2m— переподключение —\x1b[0m\r\n".encode())
        self.spawn()
        return False

    def _cancel_retry(self) -> None:
        if self._retry_source:
            GLib.source_remove(self._retry_source)
            self._retry_source = 0

    def _on_banner_button(self, *_):
        if self.state == "running":
            return
        self.reconnect()

    def reconnect(self) -> None:
        if self.kind != "ssh":
            return
        if self.state == "running" and self.child_pid > 0:
            try:
                os.kill(self.child_pid, 15)
            except OSError:
                pass
            return
        self.retries = 0
        self.terminal.feed("\r\n\x1b[2m— переподключение —\x1b[0m\r\n".encode())
        self.spawn()

    def terminate(self) -> None:
        self._cancel_retry()
        if self.child_pid > 0:
            try:
                os.kill(self.child_pid, 1)  # SIGHUP, как при закрытии окна терминала
            except OSError:
                pass

    def _cleanup(self) -> None:
        self.settings.unsubscribe(self._on_setting_changed)
        self._cancel_retry()
        if self._ssh_cmd is not None:
            self._ssh_cmd.cleanup()

    # --- действия ---------------------------------------------------------------

    def copy(self) -> None:
        if self.terminal.get_has_selection():
            self.terminal.copy_clipboard_format(Vte.Format.TEXT)

    def paste(self) -> None:
        self.terminal.paste_clipboard()

    def select_all(self) -> None:
        self.terminal.select_all()

    def send_text(self, text: str) -> None:
        data = text.encode("utf-8")
        try:
            self.terminal.feed_child(data)
        except TypeError:
            self.terminal.feed_child(text, len(data))
        self.terminal.grab_focus()


class TerminalPage(Gtk.Box):
    """Содержимое вкладки: один или несколько терминалов (разделение экрана) + поиск."""

    __gsignals__ = {
        "empty": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "changed": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "bell": (GObject.SignalFlags.RUN_FIRST, None, ()),
    }

    def __init__(self, kind: str = "local", server: Optional[Server] = None, password: Optional[str] = None,
                 cwd: Optional[str] = None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.kind = kind
        self.server = server
        self.password = password
        self.panes: list[TerminalPane] = []
        self.focused: Optional[TerminalPane] = None

        # Поиск
        self.search_entry = Gtk.SearchEntry(placeholder_text="Поиск в терминале")
        self.search_entry.set_hexpand(True)
        self.search_entry.connect("search-changed", self._on_search_changed)
        self.search_entry.connect("activate", lambda *_: self.search(False))
        prev_btn = Gtk.Button(icon_name="go-up-symbolic", tooltip_text="Предыдущее")
        prev_btn.connect("clicked", lambda *_: self.search(True))
        next_btn = Gtk.Button(icon_name="go-down-symbolic", tooltip_text="Следующее")
        next_btn.connect("clicked", lambda *_: self.search(False))
        box = Gtk.Box(spacing=6)
        box.add_css_class("linked")
        box.append(self.search_entry)
        box.append(prev_btn)
        box.append(next_btn)
        clamp = Adw.Clamp(maximum_size=520, child=box)
        self.search_bar = Gtk.SearchBar(child=clamp)
        self.search_bar.connect_entry(self.search_entry)
        self.append(self.search_bar)

        self.container = Gtk.Box()
        self.container.set_hexpand(True)
        self.container.set_vexpand(True)
        self.append(self.container)

        first = self._make_pane(cwd)
        self.container.append(first)

    # --- панели -----------------------------------------------------------------

    def _make_pane(self, cwd: Optional[str] = None) -> TerminalPane:
        pane = TerminalPane(self.kind, self.server, self.password, cwd)
        pane.connect("finished", self._on_pane_finished)
        pane.connect("focused", self._on_pane_focused)
        pane.connect("title-changed", lambda *_: self.emit("changed"))
        pane.connect("state-changed", lambda *_: self.emit("changed"))
        pane.connect("bell", lambda *_: self.emit("bell"))
        self.panes.append(pane)
        if self.focused is None:
            self.focused = pane
        return pane

    def start(self) -> None:
        for pane in self.panes:
            if pane.state == "idle":
                pane.spawn()

    @property
    def terminal(self) -> Optional[Vte.Terminal]:
        return self.focused.terminal if self.focused else None

    @property
    def title(self) -> str:
        if self.kind == "ssh" and self.server is not None:
            wt = self.focused.window_title if self.focused else None
            return self.server.title if not wt else f"{self.server.title}: {wt}"
        return self.focused.title if self.focused else "Терминал"

    @property
    def subtitle(self) -> str:
        if self.kind == "ssh" and self.server is not None:
            return self.server.subtitle
        return "Локальный терминал"

    @property
    def is_alive(self) -> bool:
        return any(p.is_alive for p in self.panes)

    @property
    def is_connecting(self) -> bool:
        return self.kind == "ssh" and any(p.state == "running" and not p.got_output for p in self.panes)

    @property
    def is_disconnected(self) -> bool:
        return self.kind == "ssh" and bool(self.panes) and all(p.state in ("exited", "failed") for p in self.panes)

    def focus_terminal(self) -> None:
        if self.focused:
            self.focused.terminal.grab_focus()

    def _on_pane_focused(self, pane: TerminalPane) -> None:
        self.focused = pane
        self.emit("changed")

    def split(self, orientation: Gtk.Orientation = Gtk.Orientation.HORIZONTAL) -> None:
        if self.focused is None:
            return
        old = self.focused
        cwd = old.current_directory() if self.kind == "local" else None
        new = self._make_pane(cwd)
        paned = Gtk.Paned(orientation=orientation)
        paned.set_wide_handle(True)
        paned.set_shrink_start_child(False)
        paned.set_shrink_end_child(False)
        self._replace(old, paned)
        paned.set_start_child(old)
        paned.set_end_child(new)

        def center():
            size = paned.get_width() if orientation == Gtk.Orientation.HORIZONTAL else paned.get_height()
            if size > 0:
                paned.set_position(size // 2)
            return False

        GLib.idle_add(center)
        self.focused = new
        new.spawn()
        GLib.idle_add(lambda: (new.terminal.grab_focus(), False)[1])
        self.emit("changed")

    def close_pane(self, pane: Optional[TerminalPane] = None) -> None:
        pane = pane or self.focused
        if pane is None:
            return
        pane.terminate()
        self._remove_pane(pane)

    def _on_pane_finished(self, pane: TerminalPane) -> None:
        self._remove_pane(pane)

    def _remove_pane(self, pane: TerminalPane) -> None:
        if pane not in self.panes:
            return
        self.panes.remove(pane)
        parent = pane.get_parent()
        if isinstance(parent, Gtk.Paned):
            sibling = parent.get_end_child() if parent.get_start_child() is pane else parent.get_start_child()
            parent.set_start_child(None)
            parent.set_end_child(None)
            self._replace(parent, sibling)
        elif parent is not None:
            parent.remove(pane)
        pane._cleanup()
        if self.focused is pane:
            self.focused = self.panes[-1] if self.panes else None
            if self.focused:
                GLib.idle_add(lambda: (self.focused and self.focused.terminal.grab_focus(), False)[1])
        if not self.panes:
            self.emit("empty")
        else:
            self.emit("changed")

    @staticmethod
    def _replace(old: Gtk.Widget, new: Gtk.Widget) -> None:
        parent = old.get_parent()
        if isinstance(parent, Gtk.Paned):
            if parent.get_start_child() is old:
                parent.set_start_child(None)
                parent.set_start_child(new)
            else:
                parent.set_end_child(None)
                parent.set_end_child(new)
        elif parent is not None:
            parent.remove(old)
            parent.append(new)

    def terminate(self) -> None:
        for pane in list(self.panes):
            pane.terminate()
            pane._cleanup()

    def reconnect(self) -> None:
        for pane in self.panes:
            if pane.kind == "ssh" and not pane.is_alive:
                pane.reconnect()

    # --- поиск ------------------------------------------------------------------

    def toggle_search(self) -> None:
        mode = not self.search_bar.get_search_mode()
        self.search_bar.set_search_mode(mode)
        if mode:
            self.search_entry.grab_focus()
        else:
            self.focus_terminal()

    def _on_search_changed(self, entry) -> None:
        text = entry.get_text()
        for pane in self.panes:
            if not text:
                pane.terminal.search_set_regex(None, 0)
                continue
            try:
                regex = Vte.Regex.new_for_search(re.escape(text), -1,
                                                 PCRE2_CASELESS | PCRE2_MULTILINE)
                pane.terminal.search_set_regex(regex, 0)
                pane.terminal.search_set_wrap_around(True)
            except GLib.Error:
                pass
        if text:
            self.search(True)

    def search(self, backwards: bool) -> None:
        term = self.terminal
        if term is None:
            return
        if backwards:
            term.search_find_previous()
        else:
            term.search_find_next()
