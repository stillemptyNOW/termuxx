"""Точка входа: Adw.Application, стили, глобальные действия, смоук-тест для CI."""

from __future__ import annotations

import sys
import traceback

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("Vte", "3.91")

from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from termuxx import ACCENT, APP_ID, APP_NAME, VERSION, WEBSITE  # noqa: E402
from termuxx.settings import Settings  # noqa: E402
from termuxx.store import HOST_COLORS, Server  # noqa: E402

BASE_CSS = """
@define-color accent_bg_color %(accent)s;
@define-color accent_color %(accent)s;
@define-color accent_fg_color #04140d;

.server-badge {
  border-radius: 10px;
  color: rgba(0, 0, 0, 0.72);
}
.status-dot {
  min-width: 8px;
  min-height: 8px;
  border-radius: 999px;
  background: %(accent)s;
  box-shadow: 0 0 6px alpha(%(accent)s, 0.8);
}
.status-dot.offline {
  background: #FF5C5C;
  box-shadow: 0 0 6px alpha(#FF5C5C, 0.7);
}
checkbutton.color-swatch check {
  min-width: 22px;
  min-height: 22px;
  border-radius: 999px;
  border: none;
  -gtk-icon-source: none;
  box-shadow: inset 0 0 0 1px alpha(white, 0.15);
}
checkbutton.color-swatch check:checked {
  box-shadow: inset 0 0 0 3px alpha(white, 0.85);
}
.theme-preview {
  border-radius: 6px;
}
.theme-cell:first-child { border-top-left-radius: 3px; border-bottom-left-radius: 3px; }
.theme-cell:last-child { border-top-right-radius: 3px; border-bottom-right-radius: 3px; }
.termuxx-empty image {
  color: %(accent)s;
}
"""

MODERN_CSS = """
:root {
  --accent-bg-color: %(accent)s;
  --accent-color: %(accent)s;
  --accent-fg-color: #04140d;
}
"""


def _swatch_css() -> str:
    rules = []
    for i, c in enumerate(HOST_COLORS):
        rules.append(f".swatch-{i}, checkbutton.swatch-{i} check {{ background: {c}; }}")
    return "\n".join(rules)


SHORTCUT_HELP = [
    ("Вкладки", [
        ("Ctrl+Shift+T", "Новая вкладка (локальный терминал)"),
        ("Ctrl+Shift+W", "Закрыть вкладку"),
        ("Ctrl+PgUp / Ctrl+PgDn", "Предыдущая / следующая вкладка"),
        ("Alt+1…9", "Перейти к вкладке"),
        ("Ctrl+Shift+E", "Разделить экран"),
        ("Ctrl+Shift+O", "Разделить по вертикали"),
        ("Ctrl+Shift+X", "Закрыть панель"),
    ]),
    ("Терминал", [
        ("Ctrl+Shift+C / Ctrl+Shift+V", "Копировать / вставить"),
        ("Ctrl+Shift+A", "Выделить всё"),
        ("Ctrl+Shift+F", "Поиск"),
        ("Ctrl+= / Ctrl+- / Ctrl+0", "Крупнее / мельче / обычный размер"),
        ("Ctrl+щелчок по ссылке", "Открыть ссылку"),
        ("Ctrl+Shift+R", "Переподключить SSH"),
        ("Ctrl+Shift+S", "Сниппеты"),
    ]),
    ("Окно", [
        ("Ctrl+Shift+K", "Быстрое подключение"),
        ("Ctrl+Shift+N", "Новое окно"),
        ("F9", "Показать / скрыть серверы"),
        ("F11", "Во весь экран"),
        ("Ctrl+,", "Параметры"),
        ("Ctrl+Q", "Выход"),
    ]),
]


class TermuxxApplication(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID,
                         flags=Gio.ApplicationFlags.HANDLES_OPEN | Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.smoke_test = False
        self.smoke_failed = False
        self.add_main_option("smoke-test", 0, GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             "Создать главное окно, открыть терминал и выйти (для CI)", None)
        self.add_main_option("version", ord("v"), GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             "Показать версию", None)
        self.add_main_option("ssh", 0, GLib.OptionFlags.NONE, GLib.OptionArg.STRING,
                             "Подключиться: user@host:port", "АДРЕС")
        self.add_main_option("new-window", 0, GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             "Открыть новое окно", None)

    # --- запуск ---------------------------------------------------------------------------

    def do_handle_local_options(self, options):
        d = options.end().unpack()
        if d.get("version"):
            print(f"{APP_NAME} {VERSION}")
            return 0
        if d.get("smoke-test"):
            self.smoke_test = True
            self.set_flags(self.get_flags() | Gio.ApplicationFlags.NON_UNIQUE)
        return -1

    def do_startup(self):
        Adw.Application.do_startup(self)
        self._apply_color_scheme()
        Settings.get().subscribe(lambda key: key == "colorScheme" and self._apply_color_scheme())
        self._load_css()
        for name, cb, accels in (
            ("quit", self._quit, ["<Control>q"]),
            ("preferences", self._preferences, ["<Control>comma"]),
            ("about", self._about, []),
            ("shortcuts", self._shortcuts, ["<Control>question", "<Control>F1"]),
            ("new-window", self._new_window, ["<Control><Shift>n"]),
        ):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", lambda *_a, f=cb: f())
            self.add_action(action)
            if accels:
                self.set_accels_for_action(f"app.{name}", accels)

    def do_command_line(self, command_line):
        options = command_line.get_options_dict().end().unpack()
        args = command_line.get_arguments()[1:]
        if options.get("new-window") and self.get_active_window() is not None:
            from termuxx.window import MainWindow

            window = MainWindow(self, open_local=True)
        else:
            window = self._window()
        target = options.get("ssh")
        if target:
            self._open_ssh_uri(window, target)
        for arg in args:
            if arg.startswith("ssh://") or "@" in arg:
                self._open_ssh_uri(window, arg)
        window.present()
        if self.smoke_test:
            self._run_smoke(window)
        return 0

    def do_activate(self):
        self._window().present()

    def do_open(self, files, n_files, hint):
        window = self._window()
        for f in files:
            self._open_ssh_uri(window, f.get_uri())
        window.present()

    def _window(self):
        from termuxx.window import MainWindow

        window = self.get_active_window()
        if window is None:
            window = MainWindow(self, open_local=True if self.smoke_test else None)
        return window

    def _open_ssh_uri(self, window, uri: str) -> None:
        server = Server.quick(uri)
        if server is None:
            return
        from termuxx.store import Store

        store = Store.get()
        for s in store.servers:
            if s.hostname == server.hostname and s.port == server.port and s.username == server.username:
                server = s
                break
        window.open_server(server)

    # --- смоук-тест -----------------------------------------------------------------------

    def _run_smoke(self, window) -> None:
        def check():
            try:
                n = window.tab_view.get_n_pages()
                assert n >= 1, "нет вкладок"
                page = window.current_page
                assert page is not None and page.focused is not None, "нет терминала"
                pane = page.focused
                assert pane.spawn_error is None, f"терминал не запустился: {pane.spawn_error}"
                assert pane.child_pid > 0, "оболочка не запущена"
                assert window.split_view.get_sidebar() is not None, "нет боковой панели"
                print(f"SMOKE OK: tabs={n} pid={pane.child_pid} servers={len(window.store.servers)}")
            except Exception:
                traceback.print_exc()
                self.smoke_failed = True
            window._allow_close = True
            self.quit()
            return False

        GLib.timeout_add(2000, check)

    # --- оформление -----------------------------------------------------------------------

    def _apply_color_scheme(self) -> None:
        scheme = Settings.get()["colorScheme"]
        manager = Adw.StyleManager.get_default()
        manager.set_color_scheme({
            "dark": Adw.ColorScheme.FORCE_DARK,
            "light": Adw.ColorScheme.FORCE_LIGHT,
        }.get(scheme, Adw.ColorScheme.DEFAULT))

    def _load_css(self) -> None:
        from termuxx.prefs import theme_css

        display = Gdk.Display.get_default()
        if display is None:
            return
        css = BASE_CSS % {"accent": ACCENT} + "\n" + _swatch_css() + "\n" + theme_css()
        provider = Gtk.CssProvider()
        self._load_css_string(provider, css)
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        if (Adw.get_major_version(), Adw.get_minor_version()) >= (1, 6):
            modern = Gtk.CssProvider()
            self._load_css_string(modern, MODERN_CSS % {"accent": ACCENT})
            Gtk.StyleContext.add_provider_for_display(display, modern, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)

    @staticmethod
    def _load_css_string(provider: Gtk.CssProvider, css: str) -> None:
        if hasattr(provider, "load_from_string"):
            provider.load_from_string(css)
        else:
            provider.load_from_data(css, -1)

    # --- действия -------------------------------------------------------------------------

    def _quit(self) -> None:
        for window in list(self.get_windows()):
            window.close()

    def _new_window(self) -> None:
        from termuxx.window import MainWindow

        MainWindow(self, open_local=True).present()

    def _preferences(self) -> None:
        from termuxx.prefs import PreferencesDialog

        PreferencesDialog(self.get_active_window())

    def _about(self) -> None:
        about = Adw.AboutDialog(
            application_name=APP_NAME,
            application_icon=APP_ID,
            version=VERSION,
            developer_name="stillemptyNOW",
            website=WEBSITE,
            issue_url=WEBSITE + "/issues",
            license_type=Gtk.License.MIT_X11,
            comments="Терминал с вкладками и менеджер SSH-серверов: SFTP, мониторинг, туннели, ключи и сниппеты. "
                     "Резервная копия совместима с Termuxx для iPhone.",
            copyright="© 2026 stillemptyNOW",
        )
        about.add_credit_section("Сделано на", ["GTK 4", "libadwaita", "VTE", "OpenSSH", "Paramiko"])
        about.present(self.get_active_window())

    def _shortcuts(self) -> None:
        dialog = Adw.Dialog(title="Горячие клавиши", content_width=560, content_height=620)
        view = Adw.ToolbarView()
        view.add_top_bar(Adw.HeaderBar())
        page = Adw.PreferencesPage()
        for title, items in SHORTCUT_HELP:
            group = Adw.PreferencesGroup(title=title)
            for keys, text in items:
                row = Adw.ActionRow(title=text)
                label = Gtk.Label(label=keys)
                label.add_css_class("dim-label")
                label.add_css_class("monospace")
                row.add_suffix(label)
                group.add(row)
            page.add(group)
        view.set_content(page)
        dialog.set_child(view)
        dialog.present(self.get_active_window())


def main(argv=None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = TermuxxApplication()
    original_hook = sys.excepthook

    def hook(exc_type, exc, tb):
        if app.smoke_test:
            app.smoke_failed = True
        original_hook(exc_type, exc, tb)

    sys.excepthook = hook
    code = app.run(argv)
    if app.smoke_test and app.smoke_failed:
        return 1
    return code
