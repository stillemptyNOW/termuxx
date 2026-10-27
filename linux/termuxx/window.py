"""Главное окно: список серверов слева, вкладки терминалов справа."""

from __future__ import annotations

import importlib
import os
from typing import Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("Vte", "3.91")

from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from termuxx import APP_NAME, sshcmd  # noqa: E402
from termuxx.dialogs import ServerEditor, ask_password, confirm, quick_connect, show_error  # noqa: E402
from termuxx.settings import Settings  # noqa: E402
from termuxx.store import HOST_COLORS, KeyItem, Server, Store  # noqa: E402
from termuxx.terminal import TerminalPage  # noqa: E402


def _color_index(hex_color: str) -> int:
    try:
        return [c.upper() for c in HOST_COLORS].index((hex_color or "").upper())
    except ValueError:
        return 0


class ServerRow(Gtk.ListBoxRow):
    def __init__(self, server: Server, window: "MainWindow"):
        super().__init__()
        self.server = server
        self.window = window
        box = Gtk.Box(spacing=12)
        box.set_margin_top(8)
        box.set_margin_bottom(8)
        box.set_margin_start(6)
        box.set_margin_end(6)

        badge = Gtk.Box()
        badge.add_css_class("server-badge")
        badge.add_css_class(f"swatch-{_color_index(server.color_hex)}")
        badge.set_size_request(34, 34)
        badge.set_valign(Gtk.Align.CENTER)
        icon = Gtk.Image(icon_name="network-server-symbolic")
        icon.set_hexpand(True)
        icon.set_halign(Gtk.Align.CENTER)
        badge.append(icon)
        box.append(badge)

        labels = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        labels.set_hexpand(True)
        labels.set_valign(Gtk.Align.CENTER)
        title = Gtk.Label(label=server.title, xalign=0, ellipsize=3)
        title.add_css_class("heading")
        subtitle = Gtk.Label(label=server.subtitle, xalign=0, ellipsize=3)
        subtitle.add_css_class("caption")
        subtitle.add_css_class("dim-label")
        subtitle.add_css_class("monospace")
        labels.append(title)
        labels.append(subtitle)
        box.append(labels)

        self.status = Gtk.Box()
        self.status.add_css_class("status-dot")
        self.status.set_valign(Gtk.Align.CENTER)
        self.status.set_visible(False)
        box.append(self.status)

        auth_icon = Gtk.Image(icon_name="dialog-password-symbolic" if server.auth == "key" else "system-lock-screen-symbolic")
        auth_icon.add_css_class("dim-label")
        auth_icon.set_pixel_size(12)
        box.append(auth_icon)

        self.set_child(box)
        self.set_tooltip_text(f"{server.title}\n{server.subtitle}\nДвойной щелчок или Enter — подключиться")

        click = Gtk.GestureClick(button=Gdk.BUTTON_SECONDARY)
        click.connect("pressed", self._on_context)
        self.add_controller(click)
        long_press = Gtk.GestureLongPress()
        long_press.connect("pressed", lambda g, x, y: self._show_menu(x, y))
        self.add_controller(long_press)

    def set_active(self, active: bool, disconnected: bool = False) -> None:
        self.status.set_visible(active or disconnected)
        if disconnected:
            self.status.add_css_class("offline")
        else:
            self.status.remove_css_class("offline")

    def _on_context(self, gesture, n, x, y):
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        self._show_menu(x, y)

    def _show_menu(self, x, y):
        sid = self.server.id
        menu = Gio.Menu()
        section = Gio.Menu()
        section.append("Терминал", f"win.server-terminal::{sid}")
        section.append("Файлы (SFTP)", f"win.server-sftp::{sid}")
        section.append("Мониторинг", f"win.server-monitor::{sid}")
        section.append("Туннели", f"win.server-tunnels::{sid}")
        menu.append_section(None, section)
        section = Gio.Menu()
        section.append("Изменить…", f"win.server-edit::{sid}")
        section.append("Дублировать", f"win.server-duplicate::{sid}")
        section.append("Скопировать команду ssh", f"win.server-copy-cmd::{sid}")
        menu.append_section(None, section)
        section = Gio.Menu()
        section.append("Удалить", f"win.server-delete::{sid}")
        menu.append_section(None, section)
        popover = Gtk.PopoverMenu.new_from_model(menu)
        popover.set_parent(self)
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        popover.set_pointing_to(rect)
        popover.set_has_arrow(False)
        popover.connect("closed", lambda p: GLib.idle_add(lambda: (p.unparent(), False)[1]))
        popover.popup()


class MainWindow(Adw.ApplicationWindow):
    def __init__(self, app: Adw.Application, open_local: Optional[bool] = None):
        super().__init__(application=app, title=APP_NAME)
        self.set_default_size(1240, 780)
        self.set_size_request(360, 360)
        self.store = Store.get()
        self.settings = Settings.get()
        self.server_rows: dict[str, ServerRow] = {}

        self.toast_overlay = Adw.ToastOverlay()
        self.split_view = Adw.OverlaySplitView()
        self.split_view.set_min_sidebar_width(250)
        self.split_view.set_max_sidebar_width(340)
        self.split_view.set_sidebar_width_fraction(0.24)

        self.split_view.set_sidebar(self._build_sidebar())
        self.split_view.set_content(self._build_content())
        self.toast_overlay.set_child(self.split_view)
        self.set_content(self.toast_overlay)

        bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 760sp"))
        bp.add_setter(self.split_view, "collapsed", True)
        self.add_breakpoint(bp)

        self._install_actions()
        self._install_shortcuts()
        self.store.subscribe(self._reload_servers)
        self._reload_servers()
        self.connect("close-request", self._on_close_request)
        self._allow_close = False

        if open_local if open_local is not None else self.settings["openLocalOnStart"]:
            self.open_local()
        self._update_state()

    # ------------------------------------------------------------------------------------------------
    # Построение интерфейса
    # ------------------------------------------------------------------------------------------------

    def _build_sidebar(self) -> Gtk.Widget:
        view = Adw.ToolbarView()
        header = Adw.HeaderBar()
        header.set_show_end_title_buttons(False)
        title = Adw.WindowTitle(title=APP_NAME, subtitle="SSH и терминал")
        header.set_title_widget(title)

        add = Gtk.MenuButton(icon_name="list-add-symbolic", tooltip_text="Добавить")
        add_menu = Gio.Menu()
        add_menu.append("Новый сервер…", "win.add-server")
        add_menu.append("Быстрое подключение…", "win.quick-connect")
        add_menu.append("Локальный терминал", "win.new-tab")
        add.set_menu_model(add_menu)
        header.pack_start(add)

        main_menu = Gtk.MenuButton(icon_name="open-menu-symbolic", tooltip_text="Главное меню")
        menu = Gio.Menu()
        section = Gio.Menu()
        section.append("Ключи", "win.keys")
        section.append("Сниппеты", "win.snippets")
        menu.append_section(None, section)
        section = Gio.Menu()
        section.append("Новое окно", "app.new-window")
        section.append("Параметры", "app.preferences")
        section.append("Горячие клавиши", "app.shortcuts")
        section.append("О Termuxx", "app.about")
        menu.append_section(None, section)
        main_menu.set_menu_model(menu)
        main_menu.set_primary(True)
        header.pack_end(main_menu)
        view.add_top_bar(header)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.search = Gtk.SearchEntry(placeholder_text="Поиск серверов")
        self.search.set_margin_start(10)
        self.search.set_margin_end(10)
        self.search.set_margin_top(6)
        self.search.set_margin_bottom(6)
        self.search.connect("search-changed", lambda *_: self.server_list.invalidate_filter())
        box.append(self.search)

        local_list = Gtk.ListBox()
        local_list.add_css_class("navigation-sidebar")
        local_list.set_selection_mode(Gtk.SelectionMode.NONE)
        local_row = Adw.ActionRow(title="Локальный терминал", subtitle=os.path.basename(os.environ.get("SHELL", "bash")),
                                  activatable=True)
        local_row.add_prefix(Gtk.Image(icon_name="utilities-terminal-symbolic"))
        local_row.connect("activated", lambda *_: self.open_local())
        local_list.append(local_row)
        box.append(local_list)

        label = Gtk.Label(label="Серверы", xalign=0)
        label.add_css_class("heading")
        label.add_css_class("dim-label")
        label.set_margin_start(18)
        label.set_margin_top(10)
        label.set_margin_bottom(2)
        box.append(label)

        self.server_list = Gtk.ListBox()
        self.server_list.add_css_class("navigation-sidebar")
        self.server_list.set_selection_mode(Gtk.SelectionMode.NONE)
        self.server_list.set_filter_func(self._filter_row)
        self.server_list.connect("row-activated", lambda _l, row: self.open_server(row.server))

        self.empty_servers = Adw.StatusPage(icon_name="network-server-symbolic", title="Нет серверов",
                                            description="Добавьте свой VPS — пароль или ключ сохранятся в системном хранилище.")
        self.empty_servers.add_css_class("compact")
        empty_btn = Gtk.Button(label="Добавить сервер")
        empty_btn.add_css_class("pill")
        empty_btn.add_css_class("suggested-action")
        empty_btn.set_halign(Gtk.Align.CENTER)
        empty_btn.set_action_name("win.add-server")
        self.empty_servers.set_child(empty_btn)

        self.sidebar_stack = Gtk.Stack()
        scrolled = Gtk.ScrolledWindow(child=self.server_list, vexpand=True)
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.sidebar_stack.add_named(scrolled, "list")
        self.sidebar_stack.add_named(self.empty_servers, "empty")
        self.sidebar_stack.set_vexpand(True)
        box.append(self.sidebar_stack)

        quick = Gtk.Button()
        quick.set_child(Adw.ButtonContent(icon_name="network-transmit-receive-symbolic", label="Быстрое подключение"))
        quick.add_css_class("flat")
        quick.set_margin_start(8)
        quick.set_margin_end(8)
        quick.set_margin_bottom(8)
        quick.set_margin_top(4)
        quick.set_action_name("win.quick-connect")
        box.append(quick)

        view.set_content(box)
        return view

    def _build_content(self) -> Gtk.Widget:
        self.tab_view = Adw.TabView()
        self.tab_view.connect("notify::selected-page", lambda *_: self._update_state())
        self.tab_view.connect("close-page", self._on_close_page)
        self.tab_view.connect("page-detached", lambda *_: self._update_state())
        self.tab_view.connect("page-attached", lambda *_: self._update_state())
        self.tab_view.connect("create-window", self._on_create_window)
        self.tab_view.connect("setup-menu", self._on_setup_menu)

        tab_menu = Gio.Menu()
        section = Gio.Menu()
        section.append("Переподключить", "win.reconnect")
        section.append("Разделить экран", "win.split")
        menu_section_close = Gio.Menu()
        menu_section_close.append("Закрыть вкладку", "win.close-tab")
        tab_menu.append_section(None, section)
        tab_menu.append_section(None, menu_section_close)
        self.tab_view.set_menu_model(tab_menu)

        self.tab_bar = Adw.TabBar(view=self.tab_view)
        self.tab_bar.set_autohide(True)

        header = Adw.HeaderBar()
        self.window_title = Adw.WindowTitle(title=APP_NAME)
        header.set_title_widget(self.window_title)

        sidebar_btn = Gtk.ToggleButton(icon_name="sidebar-show-symbolic", tooltip_text="Панель серверов (F9)")
        sidebar_btn.bind_property("active", self.split_view, "show-sidebar",
                                  GObject_binding_flags())
        sidebar_btn.set_active(True)
        header.pack_start(sidebar_btn)

        new_tab = Gtk.Button(icon_name="tab-new-symbolic", tooltip_text="Новая вкладка (Ctrl+Shift+T)")
        new_tab.set_action_name("win.new-tab")
        header.pack_start(new_tab)

        self.tab_menu_button = Gtk.MenuButton(icon_name="view-more-symbolic", tooltip_text="Действия с вкладкой")
        menu = Gio.Menu()
        section = Gio.Menu()
        section.append("Файлы (SFTP)", "win.tab-sftp")
        section.append("Мониторинг сервера", "win.tab-monitor")
        section.append("Туннели", "win.tab-tunnels")
        menu.append_section(None, section)
        section = Gio.Menu()
        section.append("Найти…", "win.search")
        section.append("Разделить экран", "win.split")
        section.append("Разделить по вертикали", "win.split-vertical")
        section.append("Переподключить", "win.reconnect")
        menu.append_section(None, section)
        section = Gio.Menu()
        section.append("Крупнее", "win.zoom-in")
        section.append("Мельче", "win.zoom-out")
        section.append("Обычный размер", "win.zoom-reset")
        section.append("Во весь экран", "win.fullscreen")
        menu.append_section(None, section)
        section = Gio.Menu()
        section.append("Закрыть вкладку", "win.close-tab")
        menu.append_section(None, section)
        self.tab_menu_button.set_menu_model(menu)
        header.pack_end(self.tab_menu_button)

        self.snippets_button = Gtk.MenuButton(icon_name="insert-text-symbolic", tooltip_text="Сниппеты")
        self.snippets_popover = Gtk.Popover()
        self.snippets_popover.connect("show", lambda *_: self._fill_snippets_popover())
        self.snippets_button.set_popover(self.snippets_popover)
        header.pack_end(self.snippets_button)

        overview_btn = Adw.TabButton(view=self.tab_view)
        overview_btn.set_action_name("overview.open")
        header.pack_end(overview_btn)

        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(header)
        toolbar.add_top_bar(self.tab_bar)
        toolbar.set_top_bar_style(Adw.ToolbarStyle.RAISED_BORDER)

        self.content_stack = Gtk.Stack()
        self.content_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.content_stack.add_named(self.tab_view, "tabs")
        self.content_stack.add_named(self._build_empty_page(), "empty")
        toolbar.set_content(self.content_stack)

        self.overview = Adw.TabOverview(view=self.tab_view, child=toolbar)
        self.overview.set_enable_new_tab(True)
        self.overview.connect("create-tab", lambda *_: self.open_local(select=True))
        return self.overview

    def _build_empty_page(self) -> Gtk.Widget:
        page = Adw.StatusPage(icon_name="utilities-terminal-symbolic", title=APP_NAME,
                              description="Откройте локальный терминал или выберите сервер слева.")
        page.add_css_class("termuxx-empty")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, halign=Gtk.Align.CENTER)
        b1 = Gtk.Button(label="Локальный терминал")
        b1.add_css_class("pill")
        b1.add_css_class("suggested-action")
        b1.set_action_name("win.new-tab")
        b2 = Gtk.Button(label="Добавить сервер")
        b2.add_css_class("pill")
        b2.set_action_name("win.add-server")
        b3 = Gtk.Button(label="Быстрое подключение")
        b3.add_css_class("pill")
        b3.set_action_name("win.quick-connect")
        for b in (b1, b2, b3):
            box.append(b)
        page.set_child(box)
        return page

    # ------------------------------------------------------------------------------------------------
    # Действия и горячие клавиши
    # ------------------------------------------------------------------------------------------------

    def _install_actions(self) -> None:
        simple = {
            "new-tab": lambda: self.open_local(select=True),
            "close-tab": self.close_current_tab,
            "close-pane": lambda: self.current_page and self.current_page.close_pane(),
            "next-tab": lambda: self._cycle_tab(1),
            "prev-tab": lambda: self._cycle_tab(-1),
            "copy": lambda: self.current_pane and self.current_pane.copy(),
            "paste": lambda: self.current_pane and self.current_pane.paste(),
            "select-all": lambda: self.current_pane and self.current_pane.select_all(),
            "zoom-in": lambda: self.current_pane and self.current_pane.zoom(0.1),
            "zoom-out": lambda: self.current_pane and self.current_pane.zoom(-0.1),
            "zoom-reset": lambda: self.current_pane and self.current_pane.zoom(None),
            "search": lambda: self.current_page and self.current_page.toggle_search(),
            "split": lambda: self.current_page and self.current_page.split(Gtk.Orientation.HORIZONTAL),
            "split-vertical": lambda: self.current_page and self.current_page.split(Gtk.Orientation.VERTICAL),
            "reconnect": lambda: self.current_page and self.current_page.reconnect(),
            "fullscreen": self._toggle_fullscreen,
            "toggle-sidebar": lambda: self.split_view.set_show_sidebar(not self.split_view.get_show_sidebar()),
            "add-server": lambda: ServerEditor(self, None),
            "quick-connect": lambda: quick_connect(self, self._quick_connect_done),
            "keys": self.show_keys,
            "snippets": self.show_snippets,
            "tab-sftp": lambda: self._tab_tool("sftp"),
            "tab-monitor": lambda: self._tab_tool("monitor"),
            "tab-tunnels": lambda: self._tab_tool("tunnels"),
        }
        for name, cb in simple.items():
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", lambda *_a, f=cb: f())
            self.add_action(action)

        with_server = {
            "server-terminal": self.open_server,
            "server-sftp": lambda s: self.open_tool("sftp", s),
            "server-monitor": lambda s: self.open_tool("monitor", s),
            "server-tunnels": lambda s: self.open_tool("tunnels", s),
            "server-edit": lambda s: ServerEditor(self, s),
            "server-duplicate": lambda s: (self.store.duplicate_server(s), self.toast("Сервер скопирован")),
            "server-copy-cmd": self._copy_ssh_command,
            "server-delete": self._delete_server,
        }
        for name, cb in with_server.items():
            action = Gio.SimpleAction.new(name, GLib.VariantType.new("s"))

            def activate(_action, param, f=cb):
                server = self.store.server(param.get_string())
                if server is not None:
                    f(server)

            action.connect("activate", activate)
            self.add_action(action)

    SHORTCUTS = [
        ("<Control><Shift>t", "win.new-tab"),
        ("<Control><Shift>w", "win.close-tab"),
        ("<Control>Page_Down", "win.next-tab"),
        ("<Control>Page_Up", "win.prev-tab"),
        ("<Control><Shift>c", "win.copy"),
        ("<Control><Shift>v", "win.paste"),
        ("<Control><Shift>a", "win.select-all"),
        ("<Control>equal", "win.zoom-in"),
        ("<Control>plus", "win.zoom-in"),
        ("<Control>KP_Add", "win.zoom-in"),
        ("<Control>minus", "win.zoom-out"),
        ("<Control>KP_Subtract", "win.zoom-out"),
        ("<Control>0", "win.zoom-reset"),
        ("<Control><Shift>f", "win.search"),
        ("<Control><Shift>e", "win.split"),
        ("<Control><Shift>o", "win.split-vertical"),
        ("<Control><Shift>x", "win.close-pane"),
        ("<Control><Shift>r", "win.reconnect"),
        ("<Control><Shift>k", "win.quick-connect"),
        ("<Control><Shift>s", "win.snippets"),
        ("F11", "win.fullscreen"),
        ("F9", "win.toggle-sidebar"),
    ]

    def _install_shortcuts(self) -> None:
        # Захватываем клавиши раньше Vte, иначе терминал «съест» Ctrl+Shift+… .
        controller = Gtk.ShortcutController()
        controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        controller.set_scope(Gtk.ShortcutScope.LOCAL)
        for accel, action in self.SHORTCUTS:
            trigger = Gtk.ShortcutTrigger.parse_string(accel)
            if trigger is None:
                continue
            controller.add_shortcut(Gtk.Shortcut.new(trigger, Gtk.NamedAction.new(action)))
        for i in range(1, 10):
            trigger = Gtk.ShortcutTrigger.parse_string(f"<Alt>{i}")
            callback = Gtk.CallbackAction.new(lambda *_a, n=i: self._select_tab(n - 1))
            controller.add_shortcut(Gtk.Shortcut.new(trigger, callback))
        self.add_controller(controller)

    # ------------------------------------------------------------------------------------------------
    # Свойства текущей вкладки
    # ------------------------------------------------------------------------------------------------

    @property
    def current_page(self) -> Optional[TerminalPage]:
        page = self.tab_view.get_selected_page()
        return page.get_child() if page else None

    @property
    def current_pane(self):
        page = self.current_page
        return page.focused if page else None

    def _pages(self) -> list:
        return [self.tab_view.get_nth_page(i) for i in range(self.tab_view.get_n_pages())]

    def _update_state(self) -> None:
        has_tabs = self.tab_view.get_n_pages() > 0
        self.content_stack.set_visible_child_name("tabs" if has_tabs else "empty")
        page = self.current_page
        if page is not None:
            self.window_title.set_title(page.title)
            self.window_title.set_subtitle(page.subtitle)
        else:
            self.window_title.set_title(APP_NAME)
            self.window_title.set_subtitle("")
        is_ssh = page is not None and page.kind == "ssh"
        for name, enabled in (("close-tab", has_tabs), ("copy", has_tabs), ("paste", has_tabs),
                              ("select-all", has_tabs), ("zoom-in", has_tabs), ("zoom-out", has_tabs),
                              ("zoom-reset", has_tabs), ("search", has_tabs), ("split", has_tabs),
                              ("split-vertical", has_tabs), ("close-pane", has_tabs),
                              ("reconnect", is_ssh), ("tab-sftp", is_ssh), ("tab-monitor", is_ssh),
                              ("tab-tunnels", is_ssh)):
            action = self.lookup_action(name)
            if action is not None:
                action.set_enabled(enabled)
        self.tab_menu_button.set_sensitive(has_tabs)
        self.snippets_button.set_sensitive(has_tabs)
        self._update_server_status()

    def _update_server_status(self) -> None:
        active: dict[str, str] = {}
        for tab in self._pages():
            page = tab.get_child()
            if page.kind != "ssh" or page.server is None:
                continue
            state = "active" if page.is_alive else "offline"
            if active.get(page.server.id) != "active":
                active[page.server.id] = state
        for sid, row in self.server_rows.items():
            state = active.get(sid)
            row.set_active(state == "active", state == "offline")

    def _on_page_changed(self, page: TerminalPage) -> None:
        for tab in self._pages():
            if tab.get_child() is page:
                tab.set_title(page.title)
                tab.set_tooltip(f"{page.title}\n{page.subtitle}")
                tab.set_loading(page.is_connecting)
                if page.is_disconnected:
                    tab.set_indicator_icon(Gio.ThemedIcon.new("network-offline-symbolic"))
                    tab.set_indicator_tooltip("Отключено — нажмите, чтобы переподключить")
                    tab.set_indicator_activatable(True)
                else:
                    tab.set_indicator_icon(None)
                break
        if page is self.current_page:
            self.window_title.set_title(page.title)
            self.window_title.set_subtitle(page.subtitle)
        self._update_server_status()

    # ------------------------------------------------------------------------------------------------
    # Вкладки
    # ------------------------------------------------------------------------------------------------

    def _add_page(self, page: TerminalPage, select: bool = True) -> Adw.TabPage:
        tab = self.tab_view.append(page)
        tab.set_title(page.title)
        tab.set_tooltip(f"{page.title}\n{page.subtitle}")
        icon = "network-server-symbolic" if page.kind == "ssh" else "utilities-terminal-symbolic"
        tab.set_icon(Gio.ThemedIcon.new(icon))
        page.connect("changed", self._on_page_changed)
        page.connect("empty", lambda p: self._close_page_widget(p))
        page.connect("bell", lambda p: self._on_bell(p))
        if select:
            self.tab_view.set_selected_page(tab)
        page.start()
        self._update_state()
        GLib.idle_add(lambda: (page.focus_terminal(), False)[1])
        return tab

    def open_local(self, select: bool = True, cwd: Optional[str] = None) -> Adw.TabPage:
        if cwd is None and self.current_pane is not None and self.current_page.kind == "local":
            cwd = self.current_pane.current_directory()
        return self._add_page(TerminalPage("local", cwd=cwd), select)

    def open_server(self, server: Server, password: Optional[str] = None) -> Adw.TabPage:
        if not server.hostname:
            show_error(self, "Нет адреса", "Укажите адрес сервера в настройках.")
            return None
        return self._add_page(TerminalPage("ssh", server=server, password=password))

    def open_command_tab(self, title: str, argv: list, env: dict, on_exit=None) -> None:
        """Вкладка с произвольной командой (например ssh-copy-id)."""
        page = TerminalPage("local")
        pane = page.focused
        tab = self.tab_view.append(page)
        tab.set_title(title)
        tab.set_icon(Gio.ThemedIcon.new("system-run-symbolic"))
        self.tab_view.set_selected_page(tab)
        pane.state = "running"
        page.connect("changed", self._on_page_changed)

        def exited(_term, status):
            try:
                code = os.waitstatus_to_exitcode(status)
            except ValueError:
                code = status
            pane.state = "exited"
            pane.terminal.feed(f"\r\n\x1b[2m— готово (код {code}). Вкладку можно закрыть —\x1b[0m\r\n".encode())
            if on_exit:
                on_exit(code)
            self._update_state()

        pane.terminal.disconnect_by_func(pane._on_child_exited)
        pane.terminal.connect("child-exited", exited)
        envv = ["TERM=xterm-256color"] + [f"{k}={v}" for k, v in env.items()]
        pane.terminal.spawn_async(Vte_PtyFlags_DEFAULT(), os.path.expanduser("~"), argv, envv,
                                  GLib.SpawnFlags.SEARCH_PATH, None, -1, None, None, None)
        self._update_state()

    def _close_page_widget(self, page: TerminalPage) -> None:
        for tab in self._pages():
            if tab.get_child() is page:
                self.tab_view.close_page(tab)
                break

    def close_current_tab(self) -> None:
        tab = self.tab_view.get_selected_page()
        if tab:
            self.tab_view.close_page(tab)

    def _on_close_page(self, view, tab) -> bool:
        page = tab.get_child()
        if self.settings["confirmClose"] and page.kind == "ssh" and page.is_alive:
            def do(response):
                if response:
                    page.terminate()
                view.close_page_finish(tab, response)
                self._update_state()

            alert = Adw.AlertDialog(heading="Закрыть подключение?",
                                    body=f"SSH-сессия с {page.subtitle} будет завершена.")
            alert.add_response("cancel", "Отмена")
            alert.add_response("close", "Закрыть")
            alert.set_response_appearance("close", Adw.ResponseAppearance.DESTRUCTIVE)
            alert.set_default_response("close")
            alert.set_close_response("cancel")
            alert.connect("response", lambda _a, r: do(r == "close"))
            alert.present(self)
            return True
        page.terminate()
        view.close_page_finish(tab, True)
        GLib.idle_add(lambda: (self._update_state(), False)[1])
        return True

    def _on_create_window(self, view):
        window = MainWindow(self.get_application(), open_local=False)
        window.present()
        return window.tab_view

    def _on_setup_menu(self, view, tab):
        if tab is not None:
            view.set_selected_page(tab)

    def _cycle_tab(self, delta: int) -> None:
        n = self.tab_view.get_n_pages()
        if n < 2:
            return
        tab = self.tab_view.get_selected_page()
        i = self.tab_view.get_page_position(tab)
        self.tab_view.set_selected_page(self.tab_view.get_nth_page((i + delta) % n))
        self.current_page and self.current_page.focus_terminal()

    def _select_tab(self, index: int) -> bool:
        n = self.tab_view.get_n_pages()
        if n == 0:
            return False
        index = min(index, n - 1)
        self.tab_view.set_selected_page(self.tab_view.get_nth_page(index))
        self.current_page and self.current_page.focus_terminal()
        return True

    def _on_bell(self, page: TerminalPage) -> None:
        for tab in self._pages():
            if tab.get_child() is page and tab is not self.tab_view.get_selected_page():
                tab.set_needs_attention(True)
        sel = self.tab_view.get_selected_page()
        if sel:
            sel.set_needs_attention(False)

    def _toggle_fullscreen(self) -> None:
        if self.is_fullscreen():
            self.unfullscreen()
        else:
            self.fullscreen()

    # ------------------------------------------------------------------------------------------------
    # Серверы
    # ------------------------------------------------------------------------------------------------

    def _reload_servers(self) -> None:
        child = self.server_list.get_first_child()
        while child is not None:
            nxt = child.get_next_sibling()
            self.server_list.remove(child)
            child = nxt
        self.server_rows = {}
        for server in self.store.sorted_servers():
            row = ServerRow(server, self)
            self.server_rows[server.id] = row
            self.server_list.append(row)
        self.sidebar_stack.set_visible_child_name("list" if self.store.servers else "empty")
        # Обновляем ссылки вкладок на свежие объекты серверов (после редактирования).
        for tab in self._pages():
            page = tab.get_child()
            if page.kind == "ssh" and page.server is not None:
                fresh = self.store.server(page.server.id)
                if fresh is not None:
                    page.server = fresh
                    for pane in page.panes:
                        pane.server = fresh
        self._update_server_status()

    def _filter_row(self, row) -> bool:
        query = self.search.get_text().strip().lower()
        if not query or not isinstance(row, ServerRow):
            return True
        s = row.server
        return query in s.title.lower() or query in s.hostname.lower() or query in s.username.lower()

    def _quick_connect_done(self, server: Server, save: bool) -> None:
        if save:
            self.store.upsert_server(server)
        self.open_server(server)

    def _copy_ssh_command(self, server: Server) -> None:
        cmd = sshcmd.build(self.store, server, with_forwards=False, remote=None)
        argv = [a for a in cmd.argv if a not in ("-t", "-tt")]
        if argv and argv[0] == "sshpass":
            argv = argv[argv.index("ssh"):]
        text = " ".join(GLib.shell_quote(a) if any(c in a for c in " '\"$%") else a for a in argv)
        self.get_display().get_clipboard().set(text)
        self.toast("Команда ssh скопирована")

    def _delete_server(self, server: Server) -> None:
        confirm(self, "Удалить сервер?", f"«{server.title}» будет удалён вместе с сохранённым паролем.",
                "Удалить", lambda: (self.store.delete_server(server), self.toast("Сервер удалён")))

    # ------------------------------------------------------------------------------------------------
    # SFTP / мониторинг / туннели (окна из других модулей)
    # ------------------------------------------------------------------------------------------------

    TOOLS = {
        "sftp": ("termuxx.sftp_window", "SFTPWindow", "Файлы (SFTP)"),
        "monitor": ("termuxx.monitor_window", "MonitorWindow", "Мониторинг"),
        "tunnels": ("termuxx.tunnels", "TunnelsWindow", "Туннели"),
    }

    def _tab_tool(self, tool: str) -> None:
        page = self.current_page
        if page is not None and page.kind == "ssh" and page.server is not None:
            self.open_tool(tool, page.server, page.password)

    def open_tool(self, tool: str, server: Server, password: Optional[str] = None) -> None:
        module_name, cls_name, title = self.TOOLS[tool]
        try:
            module = importlib.import_module(module_name)
            cls = getattr(module, cls_name)
        except Exception as e:
            show_error(self, f"{title} недоступны", f"Модуль не загрузился: {e}")
            return

        def launch(pw: Optional[str]) -> None:
            try:
                win = cls(self.get_application(), self.store, server, password=pw)
                if hasattr(win, "set_transient_for"):
                    win.set_transient_for(None)
                win.present()
            except Exception as e:
                show_error(self, f"{title}: ошибка", str(e))

        if password is None and server.auth == "password" and not self.store.password(server):
            def done(pw: str, save: bool) -> None:
                if save and pw:
                    self.store.set_password(server, pw)
                launch(pw)

            ask_password(self, server, done)
            return
        launch(password)

    # ------------------------------------------------------------------------------------------------
    # Ключи и сниппеты
    # ------------------------------------------------------------------------------------------------

    def show_keys(self) -> None:
        from termuxx.keys import KeysDialog

        KeysDialog(self, on_install=self.install_key)

    def install_key(self, key: KeyItem, server: Server) -> None:
        """Устанавливает публичный ключ через ssh-copy-id в отдельной вкладке."""
        if not sshcmd.which("ssh-copy-id"):
            show_error(self, "Нет ssh-copy-id", "Установите пакет openssh.")
            return
        runtime = os.environ.get("XDG_RUNTIME_DIR") or GLib.get_tmp_dir()
        pub_path = os.path.join(runtime, f"termuxx-{key.id}.pub")
        with open(pub_path, "w", encoding="utf-8") as f:
            f.write(key.public_key.strip() + "\n")
        cmd = sshcmd.copy_id_command(self.store, server, pub_path)

        def on_exit(code: int) -> None:
            try:
                os.remove(pub_path)
            except OSError:
                pass
            cmd.cleanup()
            if code != 0:
                self.toast("Не удалось установить ключ — смотрите вывод во вкладке")
                return

            def switch():
                fresh = self.store.server(server.id)
                if fresh is not None:
                    fresh.auth = "key"
                    fresh.key_id = key.id
                    self.store.upsert_server(fresh)
                    self.toast(f"Теперь вход на {fresh.title} — по ключу «{key.name}»")

            confirm(self, "Ключ установлен", f"Входить на {server.title} по ключу «{key.name}»?",
                    "Да, по ключу", switch, destructive=False)

        self.open_command_tab(f"Ключ → {server.title}", cmd.argv, cmd.env, on_exit)

    def show_snippets(self) -> None:
        from termuxx.snippets import SnippetsDialog

        SnippetsDialog(self, self.send_to_terminal)

    def send_to_terminal(self, text: str) -> bool:
        pane = self.current_pane
        if pane is None:
            self.toast("Сначала откройте терминал")
            return False
        pane.send_text(text)
        return True

    def _fill_snippets_popover(self) -> None:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.set_margin_top(6)
        box.set_margin_bottom(6)
        box.set_margin_start(6)
        box.set_margin_end(6)
        listbox = Gtk.ListBox()
        listbox.add_css_class("navigation-sidebar")
        listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        for sn in self.store.snippets:
            row = Adw.ActionRow(title=GLib.markup_escape_text(sn.name),
                                subtitle=GLib.markup_escape_text(sn.command.replace("\n", " ⏎ ")[:60]),
                                activatable=True)
            row.connect("activated", lambda _r, s=sn: (self.snippets_popover.popdown(),
                                                        self.send_to_terminal(s.command + ("\n" if s.run_immediately else ""))))
            listbox.append(row)
        scrolled = Gtk.ScrolledWindow(child=listbox, propagate_natural_height=True, max_content_height=420)
        scrolled.set_min_content_width(320)
        box.append(scrolled)
        manage = Gtk.Button(label="Управлять сниппетами…")
        manage.add_css_class("flat")
        manage.connect("clicked", lambda *_: (self.snippets_popover.popdown(), self.show_snippets()))
        box.append(manage)
        self.snippets_popover.set_child(box)

    # ------------------------------------------------------------------------------------------------
    # Прочее
    # ------------------------------------------------------------------------------------------------

    def toast(self, text: str) -> None:
        self.toast_overlay.add_toast(Adw.Toast(title=GLib.markup_escape_text(text), timeout=3))

    def _on_close_request(self, *_):
        if self._allow_close:
            return False
        alive = [t.get_child() for t in self._pages() if t.get_child().kind == "ssh" and t.get_child().is_alive]
        if self.settings["confirmClose"] and alive:
            alert = Adw.AlertDialog(heading="Закрыть окно?",
                                    body=f"Открыто SSH-сессий: {len(alive)}. Они будут завершены.")
            alert.add_response("cancel", "Отмена")
            alert.add_response("close", "Закрыть")
            alert.set_response_appearance("close", Adw.ResponseAppearance.DESTRUCTIVE)
            alert.set_close_response("cancel")

            def on_response(_a, r):
                if r == "close":
                    self._allow_close = True
                    self._terminate_all()
                    self.close()

            alert.connect("response", on_response)
            alert.present(self)
            return True
        self._terminate_all()
        return False

    def _terminate_all(self) -> None:
        for tab in self._pages():
            tab.get_child().terminate()
        self.store.unsubscribe(self._reload_servers)


def GObject_binding_flags():
    from gi.repository import GObject

    return GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE


def Vte_PtyFlags_DEFAULT():
    from gi.repository import Vte

    return Vte.PtyFlags.DEFAULT
