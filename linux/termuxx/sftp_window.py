"""Файловый менеджер SFTP для Termuxx (GTK4 + libadwaita)."""

from __future__ import annotations

import os
import posixpath
import stat
import threading
import time
from datetime import datetime
from typing import Callable, Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, GObject, Gtk, Pango  # noqa: E402

try:
    gi.require_version("GtkSource", "5")
    from gi.repository import GtkSource  # noqa: E402

    GtkSource.init()
except (ValueError, ImportError):
    GtkSource = None

from . import sshconn  # noqa: E402
from .sshconn import Connection, describe_error, run_in_thread  # noqa: E402

EDITOR_LIMIT = 2 * 1024 * 1024
CHUNK = 256 * 1024


class Cancelled(Exception):
    pass


def _fmt_size(n: Optional[int]) -> str:
    if n is None:
        return "—"
    return GLib.format_size(int(n))


def _fmt_time(ts: Optional[float]) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts).strftime("%d.%m.%Y %H:%M")
    except (OverflowError, OSError, ValueError):
        return ""


def _perm_string(mode: int) -> str:
    if stat.S_ISDIR(mode):
        kind = "d"
    elif stat.S_ISLNK(mode):
        kind = "l"
    else:
        kind = "-"
    chars = ""
    for who in range(3):
        bits = (mode >> (6 - 3 * who)) & 7
        chars += ("r" if bits & 4 else "-") + ("w" if bits & 2 else "-") + ("x" if bits & 1 else "-")
    return kind + chars


def _alert(parent, heading: str, body: str = "", body_markup: bool = False):
    """Создаёт Adw.AlertDialog (libadwaita ≥ 1.5) или Adw.MessageDialog."""
    if hasattr(Adw, "AlertDialog"):
        d = Adw.AlertDialog(heading=heading, body=body, body_use_markup=body_markup)
        d._termuxx_parent = parent
        return d
    d = Adw.MessageDialog(transient_for=parent, heading=heading, body=body, body_use_markup=body_markup)
    d._termuxx_parent = None
    return d


def _present(dialog):
    parent = getattr(dialog, "_termuxx_parent", None)
    if parent is not None and hasattr(Adw, "AlertDialog") and isinstance(dialog, Adw.AlertDialog):
        dialog.present(parent)
    else:
        dialog.present()


def _close_dialog(dialog):
    if hasattr(dialog, "force_close"):
        dialog.force_close()
    else:
        dialog.close()


def prompt_text(parent, heading: str, body: str, initial: str, ok_label: str,
                callback: Callable[[str], None], select_stem: bool = True) -> None:
    """Диалог с полем ввода."""
    dialog = _alert(parent, heading, body)
    entry = Gtk.Entry(text=initial, activates_default=True)
    entry.set_hexpand(True)
    dialog.set_extra_child(entry)
    dialog.add_response("cancel", "Отмена")
    dialog.add_response("ok", ok_label)
    dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
    dialog.set_default_response("ok")
    dialog.set_close_response("cancel")
    done = {"v": False}

    def finish():
        if done["v"]:
            return
        text = entry.get_text().strip()
        if text:
            done["v"] = True
            callback(text)

    def on_response(_d, response):
        if response == "ok":
            finish()

    def on_activate(_e):
        finish()
        if done["v"]:
            if isinstance(dialog, Gtk.Window):
                dialog.close()
            else:
                _close_dialog(dialog)

    dialog.connect("response", on_response)
    entry.connect("activate", on_activate)
    _present(dialog)

    def focus():
        entry.grab_focus()
        if select_stem and "." in initial[1:]:
            entry.select_region(0, initial.rfind("."))
        else:
            entry.select_region(0, -1)
        return False

    GLib.timeout_add(80, focus)


def confirm(parent, heading: str, body: str, ok_label: str, callback: Callable[[], None],
            destructive: bool = True) -> None:
    dialog = _alert(parent, heading, body)
    dialog.add_response("cancel", "Отмена")
    dialog.add_response("ok", ok_label)
    dialog.set_response_appearance(
        "ok", Adw.ResponseAppearance.DESTRUCTIVE if destructive else Adw.ResponseAppearance.SUGGESTED
    )
    dialog.set_default_response("cancel" if destructive else "ok")
    dialog.set_close_response("cancel")
    dialog.connect("response", lambda _d, r: callback() if r == "ok" else None)
    _present(dialog)


# ---------------------------------------------------------------------------
# Модель файлов
# ---------------------------------------------------------------------------


class FileItem(GObject.Object):
    __gtype_name__ = "TermuxxSFTPFileItem"

    def __init__(self, name: str, path: str, attrs, is_dir: bool, link_target: Optional[str] = None):
        super().__init__()
        self.name = name
        self.path = path
        self.size = attrs.st_size if attrs.st_size is not None else 0
        self.mtime = attrs.st_mtime or 0
        self.mode = attrs.st_mode or 0
        self.uid = attrs.st_uid
        self.gid = attrs.st_gid
        self.is_link = stat.S_ISLNK(self.mode)
        self.is_dir = is_dir
        self.link_target = link_target

    @property
    def hidden(self) -> bool:
        return self.name.startswith(".")

    def gicon(self) -> Gio.Icon:
        if self.is_dir:
            return Gio.ThemedIcon.new("folder-symbolic")
        ctype, _uncertain = Gio.content_type_guess(self.name, None)
        icon = Gio.content_type_get_symbolic_icon(ctype) if ctype else None
        return icon or Gio.ThemedIcon.new("text-x-generic-symbolic")


def _ordering(v: int):
    if v < 0:
        return Gtk.Ordering.SMALLER
    if v > 0:
        return Gtk.Ordering.LARGER
    return Gtk.Ordering.EQUAL


def _cmp(a, b) -> int:
    return (a > b) - (a < b)


# ---------------------------------------------------------------------------
# Передача файлов
# ---------------------------------------------------------------------------


class TransferJob:
    def __init__(self, kind: str, title: str, sources: list, dest: str, after: Optional[Callable] = None):
        self.kind = kind  # "download" | "upload"
        self.title = title
        self.sources = sources
        self.dest = dest
        self.after = after
        self.cancelled = False
        self.total = 0
        self.done = 0
        self.files_total = 0
        self.files_done = 0
        self.current = ""
        self.started = time.monotonic()
        self.results: list[str] = []


# ---------------------------------------------------------------------------
# Окно
# ---------------------------------------------------------------------------


class SFTPWindow(Adw.Window):
    def __init__(self, application, store, server, password=None):
        super().__init__(application=application)
        self.store = store
        self.server = server
        self.password = password
        self.conn: Optional[Connection] = None
        self.sftp = None
        self.sftp_lock = threading.Lock()
        self.path = "/"
        self.history: list[str] = []
        self.jobs: list[TransferJob] = []
        self.job: Optional[TransferJob] = None
        self.transfer_sftp = None
        self._closing = False
        self._loading_token = 0

        self.set_default_size(1040, 700)
        self.set_title(f"Файлы — {getattr(server, 'title', '')}")
        self._build_actions()
        self._build_ui()
        self._build_shortcuts()
        self.connect("close-request", self._on_close_request)
        self.present()
        self._connect()

    # ---------------- UI ----------------

    def _build_ui(self):
        self.toasts = Adw.ToastOverlay()
        toolbar = Adw.ToolbarView()
        self.toasts.set_child(toolbar)
        self.set_content(self.toasts)

        header = Adw.HeaderBar()
        self.title_widget = Adw.WindowTitle(title=getattr(self.server, "title", ""), subtitle="Подключение…")
        header.set_title_widget(self.title_widget)

        self.back_btn = Gtk.Button(icon_name="go-previous-symbolic", tooltip_text="Назад (Alt+←)")
        self.back_btn.set_action_name("sftp.back")
        self.up_btn = Gtk.Button(icon_name="go-up-symbolic", tooltip_text="Вверх (Alt+↑)")
        self.up_btn.set_action_name("sftp.up")
        refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Обновить (F5)")
        refresh.set_action_name("sftp.refresh")
        header.pack_start(self.back_btn)
        header.pack_start(self.up_btn)
        header.pack_start(refresh)

        menu = Gio.Menu()
        create = Gio.Menu()
        create.append("Новая папка", "sftp.new-folder")
        create.append("Новый файл", "sftp.new-file")
        menu.append_section(None, create)
        upload = Gio.Menu()
        upload.append("Загрузить файлы…", "sftp.upload")
        upload.append("Загрузить папку…", "sftp.upload-folder")
        menu.append_section(None, upload)
        view = Gio.Menu()
        view.append("Показывать скрытые", "sftp.show-hidden")
        view.append("Перейти по пути…", "sftp.goto")
        menu.append_section(None, view)
        menu_btn = Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu, tooltip_text="Меню")
        header.pack_end(menu_btn)

        upload_btn = Gtk.Button(tooltip_text="Загрузить файлы на сервер (Ctrl+U)")
        upload_btn.set_child(Adw.ButtonContent(icon_name="document-send-symbolic", label="Загрузить"))
        upload_btn.set_action_name("sftp.upload")
        header.pack_end(upload_btn)

        self.search_btn = Gtk.ToggleButton(icon_name="system-search-symbolic", tooltip_text="Поиск (Ctrl+F)")
        header.pack_end(self.search_btn)
        toolbar.add_top_bar(header)

        # Поиск
        self.search_bar = Gtk.SearchBar()
        self.search_entry = Gtk.SearchEntry(placeholder_text="Фильтр по имени", hexpand=True)
        clamp = Adw.Clamp(maximum_size=520, child=self.search_entry)
        self.search_bar.set_child(clamp)
        self.search_bar.connect_entry(self.search_entry)
        self.search_bar.set_key_capture_widget(self)
        self.search_btn.bind_property("active", self.search_bar, "search-mode-enabled",
                                      GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE)
        self.search_entry.connect("search-changed", lambda *_: self._refilter())
        toolbar.add_top_bar(self.search_bar)

        # Хлебные крошки / ввод пути
        self.path_stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        crumbs_scroll = Gtk.ScrolledWindow(vscrollbar_policy=Gtk.PolicyType.NEVER,
                                           hscrollbar_policy=Gtk.PolicyType.EXTERNAL, hexpand=True)
        self.crumbs = Gtk.Box(spacing=2)
        crumbs_scroll.set_child(self.crumbs)
        self.crumbs_scroll = crumbs_scroll
        self.path_entry = Gtk.Entry(hexpand=True, placeholder_text="/путь/к/папке")
        self.path_entry.connect("activate", self._on_path_entry)
        esc = Gtk.EventControllerKey()
        esc.connect("key-pressed", self._on_path_entry_key)
        self.path_entry.add_controller(esc)
        self.path_stack.add_named(crumbs_scroll, "crumbs")
        self.path_stack.add_named(self.path_entry, "entry")
        edit_path = Gtk.Button(icon_name="document-edit-symbolic", tooltip_text="Ввести путь (Ctrl+L)",
                               css_classes=["flat"])
        edit_path.set_action_name("sftp.goto")
        path_bar = Gtk.Box(spacing=6, margin_start=10, margin_end=10, margin_top=4, margin_bottom=4)
        path_bar.append(self.path_stack)
        path_bar.append(edit_path)
        toolbar.add_top_bar(path_bar)

        # Содержимое
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)

        loading = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12,
                          valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        spinner = Gtk.Spinner(spinning=True, width_request=32, height_request=32)
        self.loading_label = Gtk.Label(label="Подключение…", css_classes=["dim-label"])
        loading.append(spinner)
        loading.append(self.loading_label)
        self.stack.add_named(loading, "loading")

        self.error_page = Adw.StatusPage(icon_name="network-error-symbolic", title="Нет подключения")
        retry = Gtk.Button(label="Переподключиться", halign=Gtk.Align.CENTER,
                           css_classes=["pill", "suggested-action"])
        retry.connect("clicked", lambda *_: self._connect())
        self.error_page.set_child(retry)
        self.stack.add_named(self.error_page, "error")

        self._build_list()
        list_overlay = Gtk.Overlay()
        list_overlay.set_child(self.list_scroll)
        self.drop_hint = Gtk.Label(label="Отпустите, чтобы загрузить на сервер",
                                   css_classes=["title-2"], visible=False,
                                   halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        self.drop_hint.add_css_class("osd")
        self.drop_hint.set_margin_top(20)
        list_overlay.add_overlay(self.drop_hint)
        self.empty_page = Adw.StatusPage(icon_name="folder-symbolic", title="Папка пуста",
                                         description="Перетащите сюда файлы, чтобы загрузить их на сервер")
        content_stack = Gtk.Stack()
        content_stack.add_named(list_overlay, "list")
        content_stack.add_named(self.empty_page, "empty")
        self.content_stack = content_stack
        self.stack.add_named(content_stack, "main")
        self.stack.set_visible_child_name("loading")

        drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        drop.connect("drop", self._on_drop)
        drop.connect("enter", self._on_drop_enter)
        drop.connect("leave", lambda *_: self.drop_hint.set_visible(False))
        self.stack.add_controller(drop)

        toolbar.set_content(self.stack)

        # Нижняя панель передачи
        self.transfer_revealer = Gtk.Revealer(transition_type=Gtk.RevealerTransitionType.SLIDE_UP)
        bar = Gtk.Box(spacing=12, margin_start=12, margin_end=12, margin_top=8, margin_bottom=8)
        info = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, hexpand=True)
        self.transfer_label = Gtk.Label(xalign=0, ellipsize=Pango.EllipsizeMode.MIDDLE)
        self.transfer_progress = Gtk.ProgressBar(hexpand=True)
        self.transfer_detail = Gtk.Label(xalign=0, css_classes=["dim-label", "caption"])
        info.append(self.transfer_label)
        info.append(self.transfer_progress)
        info.append(self.transfer_detail)
        cancel = Gtk.Button(label="Отменить", valign=Gtk.Align.CENTER)
        cancel.connect("clicked", lambda *_: self._cancel_transfers())
        bar.append(info)
        bar.append(cancel)
        self.transfer_revealer.set_child(bar)
        toolbar.add_bottom_bar(self.transfer_revealer)

    def _build_list(self):
        self.model = Gio.ListStore(item_type=FileItem)
        self.filter = Gtk.CustomFilter.new(self._filter_func, None)
        filtered = Gtk.FilterListModel(model=self.model, filter=self.filter)
        self.dirs_first = Gtk.CustomSorter.new(self._cmp_dirs_first, None)
        self.sorter = Gtk.MultiSorter()
        self.sorter.append(self.dirs_first)
        sorted_model = Gtk.SortListModel(model=filtered, sorter=self.sorter)
        self.selection = Gtk.MultiSelection(model=sorted_model)
        self.view = Gtk.ColumnView(model=self.selection, show_row_separators=False,
                                   reorderable=False, hexpand=True, vexpand=True)
        self.view.add_css_class("data-table")
        self.view.connect("activate", self._on_activate)

        self.col_name = self._column("Имя", self._setup_name, self._bind_name, self._cmp_name, expand=True)
        self.col_size = self._column("Размер", self._setup_label_right, self._bind_size, self._cmp_size, width=110)
        self.col_date = self._column("Изменён", self._setup_label, self._bind_date, self._cmp_date, width=150)
        self.col_perm = self._column("Права", self._setup_mono, self._bind_perm, None, width=120)
        for col in (self.col_name, self.col_size, self.col_date, self.col_perm):
            self.view.append_column(col)
        self.sorter.append(self.view.get_sorter())
        self.view.sort_by_column(self.col_name, Gtk.SortType.ASCENDING)

        self.list_scroll = Gtk.ScrolledWindow(child=self.view, hexpand=True, vexpand=True)

    def _column(self, title, setup, bind, cmp, expand=False, width=None):
        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", setup)
        factory.connect("bind", bind)
        col = Gtk.ColumnViewColumn(title=title, factory=factory, expand=expand, resizable=True)
        if width:
            col.set_fixed_width(width)
        if cmp is not None:
            col.set_sorter(Gtk.CustomSorter.new(cmp, None))
        return col

    def _attach_context(self, widget):
        click = Gtk.GestureClick(button=3)
        click.connect("pressed", self._on_right_click, widget)
        widget.add_controller(click)

    def _setup_name(self, _factory, list_item):
        box = Gtk.Box(spacing=10, margin_top=3, margin_bottom=3)
        icon = Gtk.Image()
        label = Gtk.Label(xalign=0, ellipsize=Pango.EllipsizeMode.MIDDLE, hexpand=True)
        box.append(icon)
        box.append(label)
        self._attach_context(box)
        list_item.set_child(box)

    def _bind_name(self, _factory, list_item):
        item: FileItem = list_item.get_item()
        box = list_item.get_child()
        icon = box.get_first_child()
        label = icon.get_next_sibling()
        icon.set_from_gicon(item.gicon())
        label.set_label(item.name + (" →" if item.is_link else ""))
        if item.link_target:
            label.set_tooltip_text(f"{item.name} → {item.link_target}")
        elif len(item.name) > 48:
            label.set_tooltip_text(item.name)
        else:
            label.set_tooltip_text(None)
        if item.hidden:
            label.add_css_class("dim-label")
        else:
            label.remove_css_class("dim-label")
        box._position = list_item.get_position()

    def _setup_label(self, _factory, list_item):
        label = Gtk.Label(xalign=0, css_classes=["dim-label"])
        self._attach_context(label)
        list_item.set_child(label)

    def _setup_label_right(self, _factory, list_item):
        label = Gtk.Label(xalign=1, css_classes=["dim-label", "numeric"])
        self._attach_context(label)
        list_item.set_child(label)

    def _setup_mono(self, _factory, list_item):
        label = Gtk.Label(xalign=0, css_classes=["dim-label", "monospace", "caption"])
        self._attach_context(label)
        list_item.set_child(label)

    def _bind_size(self, _factory, list_item):
        item = list_item.get_item()
        w = list_item.get_child()
        w.set_label("—" if item.is_dir else _fmt_size(item.size))
        w._position = list_item.get_position()

    def _bind_date(self, _factory, list_item):
        item = list_item.get_item()
        w = list_item.get_child()
        w.set_label(_fmt_time(item.mtime))
        w._position = list_item.get_position()

    def _bind_perm(self, _factory, list_item):
        item = list_item.get_item()
        w = list_item.get_child()
        w.set_label(_perm_string(item.mode))
        w._position = list_item.get_position()

    # сортировка и фильтр
    def _filter_func(self, item, *_):
        if not self._show_hidden() and item.hidden:
            return False
        query = self.search_entry.get_text().strip().casefold() if hasattr(self, "search_entry") else ""
        return not query or query in item.name.casefold()

    def _cmp_dirs_first(self, a, b, *_):
        return _ordering(_cmp(0 if a.is_dir else 1, 0 if b.is_dir else 1))

    def _cmp_name(self, a, b, *_):
        return _ordering(_cmp(a.name.casefold(), b.name.casefold()))

    def _cmp_size(self, a, b, *_):
        return _ordering(_cmp(a.size, b.size))

    def _cmp_date(self, a, b, *_):
        return _ordering(_cmp(a.mtime, b.mtime))

    def _refilter(self):
        self.filter.changed(Gtk.FilterChange.DIFFERENT)
        self._update_empty()

    def _update_empty(self):
        empty = self.selection.get_n_items() == 0
        if empty:
            if self.model.get_n_items() > 0:
                self.empty_page.set_title("Ничего не найдено")
                self.empty_page.set_description("Измените фильтр или включите показ скрытых файлов")
            else:
                self.empty_page.set_title("Папка пуста")
                self.empty_page.set_description("Перетащите сюда файлы, чтобы загрузить их на сервер")
        self.content_stack.set_visible_child_name("empty" if empty else "list")

    # ---------------- действия ----------------

    def _build_actions(self):
        group = Gio.SimpleActionGroup()

        def add(name, cb):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", lambda *_: cb())
            group.add_action(action)
            return action

        self.act_back = add("back", self.go_back)
        self.act_up = add("up", self.go_up)
        add("refresh", self.reload)
        add("new-folder", self.new_folder)
        add("new-file", self.new_file)
        add("upload", self.choose_upload)
        add("upload-folder", self.choose_upload_folder)
        add("goto", self.show_path_entry)
        add("open", self.open_selected)
        add("download", self.download_selected)
        add("rename", self.rename_selected)
        add("delete", self.delete_selected)
        add("copy-path", self.copy_path)
        add("properties", self.show_properties)
        hidden = Gio.SimpleAction.new_stateful("show-hidden", None, GLib.Variant.new_boolean(False))
        hidden.connect("change-state", self._on_hidden_changed)
        group.add_action(hidden)
        self.act_hidden = hidden
        self.insert_action_group("sftp", group)
        self.actions = group
        self.act_back.set_enabled(False)

    def _show_hidden(self) -> bool:
        return bool(self.act_hidden.get_state().get_boolean())

    def _on_hidden_changed(self, action, value):
        action.set_state(value)
        self._refilter()

    def _build_shortcuts(self):
        ctrl = Gtk.ShortcutController()
        ctrl.set_scope(Gtk.ShortcutScope.LOCAL)

        def sc(trigger, fn):
            ctrl.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string(trigger),
                                               Gtk.CallbackAction.new(lambda *_: (fn(), True)[1])))

        sc("Delete", self.delete_selected)
        sc("F2", self.rename_selected)
        sc("<Alt>Up", self.go_up)
        sc("<Alt>Left", self.go_back)
        sc("<Control>l", self.show_path_entry)
        sc("<Control>f", lambda: self.search_btn.set_active(not self.search_btn.get_active()))
        sc("<Control>h", lambda: self.act_hidden.change_state(GLib.Variant.new_boolean(not self._show_hidden())))
        sc("F5", self.reload)
        sc("<Control>r", self.reload)
        sc("<Control>u", self.choose_upload)
        sc("<Control>n", self.new_folder)
        sc("<Control>w", self.close)
        self.add_controller(ctrl)

        back = Gtk.EventControllerKey()
        back.connect("key-pressed", self._on_view_key)
        self.view.add_controller(back)

    def _on_view_key(self, _ctrl, keyval, _code, state):
        if keyval == Gdk.KEY_BackSpace and not (state & Gdk.ModifierType.CONTROL_MASK):
            self.go_up()
            return True
        return False

    # ---------------- подключение ----------------

    def toast(self, text: str, timeout: int = 3):
        t = Adw.Toast(title=GLib.markup_escape_text(text), timeout=timeout)
        self.toasts.add_toast(t)

    def _connect(self):
        self.loading_label.set_label("Подключение…")
        self.stack.set_visible_child_name("loading")
        self.title_widget.set_subtitle("Подключение…")

        def connected(conn):
            if self._closing:
                run_in_thread(conn.close)
                return
            self.conn = conn

            def open_sftp():
                sftp = conn.open_sftp()
                home = sftp.normalize(".")
                return sftp, home

            def ready(result):
                self.sftp, home = result
                self.navigate(home or "/", push=False)

            run_in_thread(open_sftp, ready, self._fatal)

        sshconn.connect_interactive(self, self.store, self.server, self.password, connected, self._fatal)

    def _fatal(self, e: BaseException):
        if self._closing:
            return
        self.error_page.set_title("Нет подключения")
        self.error_page.set_description(GLib.markup_escape_text(describe_error(e)))
        self.title_widget.set_subtitle("нет подключения")
        self.stack.set_visible_child_name("error")

    def _sftp_call(self, fn: Callable, on_success: Optional[Callable] = None,
                   on_error: Optional[Callable] = None):
        """Выполняет операцию над общим SFTP-клиентом в фоне (по одной за раз)."""

        def work():
            if self.sftp is None:
                raise sshconn.SSHError("Нет SFTP-подключения.")
            with self.sftp_lock:
                return fn(self.sftp)

        def failed(e):
            if self.conn is not None and not self.conn.is_active:
                self._fatal(sshconn.SSHError("Соединение потеряно. " + describe_error(e)))
                return
            if on_error:
                on_error(e)
            else:
                self.toast(describe_error(e) if not isinstance(e, IOError) else _io_error(e))

        run_in_thread(work, on_success, failed)

    # ---------------- навигация ----------------

    def navigate(self, path: str, push: bool = True):
        path = posixpath.normpath(path) if path else "/"
        if not path.startswith("/"):
            path = posixpath.normpath(posixpath.join(self.path, path))
        previous = self.path
        self._loading_token += 1
        token = self._loading_token

        def list_dir(sftp):
            entries = []
            for attrs in sftp.listdir_attr(path):
                name = attrs.filename
                if name in (".", ".."):
                    continue
                full = posixpath.join(path, name)
                mode = attrs.st_mode or 0
                is_dir = stat.S_ISDIR(mode)
                target = None
                if stat.S_ISLNK(mode):
                    try:
                        target = sftp.readlink(full)
                        is_dir = stat.S_ISDIR(sftp.stat(full).st_mode or 0)
                    except IOError:
                        pass
                entries.append((name, full, attrs, is_dir, target))
            return entries

        def done(entries):
            if token != self._loading_token:
                return
            if push and previous and previous != path:
                self.history.append(previous)
            self.path = path
            items = [FileItem(n, f, a, d, t) for (n, f, a, d, t) in entries]
            self.model.splice(0, self.model.get_n_items(), items)
            self._update_empty()
            self._update_path_ui()
            self.stack.set_visible_child_name("main")
            self.view.grab_focus()

        def failed(e):
            if token != self._loading_token:
                return
            if self.conn is not None and not self.conn.is_active:
                self._fatal(e)
                return
            self.toast(f"Не удалось открыть {path}: {_io_error(e)}")
            if self.stack.get_visible_child_name() != "main":
                self._fatal(e)

        self._sftp_call(list_dir, done, failed)

    def reload(self):
        if self.sftp is None:
            self._connect()
            return
        self.navigate(self.path, push=False)

    def go_up(self):
        if self.path != "/":
            self.navigate(posixpath.dirname(self.path.rstrip("/")) or "/")

    def go_back(self):
        if self.history:
            target = self.history.pop()
            self.navigate(target, push=False)

    def _update_path_ui(self):
        self.title_widget.set_subtitle(self.path)
        self.act_up.set_enabled(self.path != "/")
        self.act_back.set_enabled(bool(self.history))
        child = self.crumbs.get_first_child()
        while child is not None:
            nxt = child.get_next_sibling()
            self.crumbs.remove(child)
            child = nxt
        parts = [p for p in self.path.split("/") if p]
        acc = ""
        self._crumb(" / ", "/", root=True)
        for i, part in enumerate(parts):
            acc += "/" + part
            if i > 0:
                self.crumbs.append(Gtk.Label(label="›", css_classes=["dim-label"]))
            self._crumb(part, acc, last=(i == len(parts) - 1))
        GLib.idle_add(self._scroll_crumbs_end)

    def _scroll_crumbs_end(self):
        adj = self.crumbs_scroll.get_hadjustment()
        adj.set_value(adj.get_upper())
        return False

    def _crumb(self, label, path, root=False, last=False):
        btn = Gtk.Button(label=label, css_classes=["flat"])
        if root:
            btn.set_child(Gtk.Image(icon_name="drive-harddisk-symbolic"))
            btn.set_tooltip_text("/")
        if last:
            btn.add_css_class("heading")
        btn.connect("clicked", lambda *_: self.navigate(path))
        self.crumbs.append(btn)

    def show_path_entry(self):
        self.path_entry.set_text(self.path)
        self.path_stack.set_visible_child_name("entry")
        self.path_entry.grab_focus()
        self.path_entry.set_position(-1)

    def _on_path_entry(self, entry):
        text = entry.get_text().strip()
        self.path_stack.set_visible_child_name("crumbs")
        if text:
            if text.startswith("~"):
                home_rel = text[1:].lstrip("/")

                def resolve(sftp):
                    return posixpath.join(sftp.normalize("."), home_rel)

                self._sftp_call(resolve, lambda p: self.navigate(p))
            else:
                self.navigate(text)

    def _on_path_entry_key(self, _ctrl, keyval, *_):
        if keyval == Gdk.KEY_Escape:
            self.path_stack.set_visible_child_name("crumbs")
            self.view.grab_focus()
            return True
        return False

    # ---------------- выделение и меню ----------------

    def selected_items(self) -> list[FileItem]:
        items = []
        bitset = self.selection.get_selection()
        n = bitset.get_size()
        for i in range(n):
            pos = bitset.get_nth(i)
            item = self.selection.get_item(pos)
            if item is not None:
                items.append(item)
        return items

    def _on_activate(self, _view, position):
        item = self.selection.get_item(position)
        if item is None:
            return
        if item.is_dir:
            self.navigate(item.path)
        else:
            self.open_item(item)

    def _on_right_click(self, gesture, _n, x, y, widget):
        pos = getattr(widget, "_position", None)
        if pos is not None and not self.selection.is_selected(pos):
            self.selection.select_item(pos, True)
        items = self.selected_items()
        menu = Gio.Menu()
        if len(items) == 1 and not items[0].is_dir:
            menu.append("Открыть", "sftp.open")
        elif len(items) == 1:
            menu.append("Открыть папку", "sftp.open")
        menu.append("Скачать…", "sftp.download")
        edit = Gio.Menu()
        if len(items) == 1:
            edit.append("Переименовать", "sftp.rename")
        edit.append("Скопировать путь", "sftp.copy-path")
        if len(items) == 1:
            edit.append("Свойства и права", "sftp.properties")
        menu.append_section(None, edit)
        danger = Gio.Menu()
        danger.append("Удалить", "sftp.delete")
        menu.append_section(None, danger)
        popover = Gtk.PopoverMenu.new_from_model(menu)
        popover.set_has_arrow(False)
        popover.set_parent(widget)
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        popover.set_pointing_to(rect)
        popover.connect("closed", lambda p: GLib.idle_add(p.unparent))
        popover.popup()
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)

    def open_selected(self):
        items = self.selected_items()
        if len(items) == 1:
            item = items[0]
            if item.is_dir:
                self.navigate(item.path)
            else:
                self.open_item(item)

    def copy_path(self):
        items = self.selected_items()
        text = "\n".join(i.path for i in items) if items else self.path
        Gdk.Display.get_default().get_clipboard().set(text)
        self.toast("Путь скопирован")

    # ---------------- файлы ----------------

    def open_item(self, item: FileItem):
        if item.size <= EDITOR_LIMIT:
            def read(sftp):
                with sftp.open(item.path, "rb") as f:
                    return f.read(EDITOR_LIMIT + 1)

            def got(data: bytes):
                text = None
                if b"\x00" not in data[:8192]:
                    try:
                        text = data.decode("utf-8")
                    except UnicodeDecodeError:
                        text = None
                if text is not None:
                    EditorWindow(self, item.path, text).present()
                else:
                    self._open_external(item)

            self._sftp_call(read, got)
        else:
            self._open_external(item)

    def _open_external(self, item: FileItem):
        cache = os.path.join(GLib.get_user_cache_dir(), "termuxx", "open",
                             str(getattr(self.server, "id", "server")))
        os.makedirs(cache, exist_ok=True)

        def launch(job: TransferJob):
            if job.results:
                path = job.results[0]
                launcher_cls = getattr(Gtk, "FileLauncher", None)
                if launcher_cls is not None:
                    launcher_cls.new(Gio.File.new_for_path(path)).launch(self, None, None, None)
                else:
                    Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), None)

        self._enqueue(TransferJob("download", f"Открываю {item.name}", [item], cache, after=launch),
                      overwrite=True)

    def write_text(self, path: str, text: str, on_done: Callable, on_error: Callable):
        def write(sftp):
            data = text.encode("utf-8")
            with sftp.open(path, "wb") as f:
                f.set_pipelined(True)
                f.write(data)
            return path

        def ok(_p):
            on_done()
            self.reload()

        self._sftp_call(write, ok, on_error)

    def new_folder(self):
        if self.sftp is None:
            return

        def create(name):
            target = posixpath.join(self.path, name)
            self._sftp_call(lambda sftp: sftp.mkdir(target), lambda _r: (self.reload(), self.toast(f"Папка «{name}» создана")))

        prompt_text(self, "Новая папка", f"В {self.path}", "Новая папка", "Создать", create, select_stem=False)

    def new_file(self):
        if self.sftp is None:
            return

        def create(name):
            target = posixpath.join(self.path, name)

            def touch(sftp):
                try:
                    sftp.stat(target)
                    raise IOError(f"«{name}» уже существует")
                except FileNotFoundError:
                    pass
                with sftp.open(target, "wb"):
                    pass
                return target

            def created(path):
                self.reload()
                EditorWindow(self, path, "").present()

            self._sftp_call(touch, created)

        prompt_text(self, "Новый файл", f"В {self.path}", "новый_файл.txt", "Создать", create)

    def rename_selected(self):
        items = self.selected_items()
        if len(items) != 1:
            return
        item = items[0]

        def do(new_name):
            if new_name == item.name:
                return
            target = posixpath.join(posixpath.dirname(item.path), new_name)
            self._sftp_call(lambda sftp: sftp.rename(item.path, target),
                            lambda _r: (self.reload(), self.toast("Переименовано")))

        prompt_text(self, "Переименовать", item.name, item.name, "Переименовать", do)

    def delete_selected(self):
        items = self.selected_items()
        if not items:
            return
        if len(items) == 1:
            what = f"«{items[0].name}»" + (" со всем содержимым" if items[0].is_dir else "")
        else:
            what = f"{len(items)} объектов"

        def do():
            def remove(sftp):
                for it in items:
                    _rm_rf(sftp, it.path)
                return len(items)

            self._sftp_call(remove, lambda n: (self.reload(), self.toast(f"Удалено: {n}")))

        confirm(self, "Удалить?", f"Удалить {what} с сервера? Это нельзя отменить.", "Удалить", do)

    def show_properties(self):
        items = self.selected_items()
        if len(items) != 1:
            return
        it = items[0]
        kind = "Папка" if it.is_dir else ("Ссылка" if it.is_link else "Файл")
        rows = [
            ("Путь", it.path),
            ("Тип", kind + (f" → {it.link_target}" if it.link_target else "")),
            ("Размер", "—" if it.is_dir else f"{_fmt_size(it.size)} ({it.size} байт)"),
            ("Изменён", _fmt_time(it.mtime)),
            ("Права", f"{_perm_string(it.mode)}  ({stat.S_IMODE(it.mode):04o})"),
            ("Владелец", f"uid {it.uid}, gid {it.gid}"),
        ]
        body = "\n".join(f"<b>{GLib.markup_escape_text(k)}:</b> {GLib.markup_escape_text(str(v))}" for k, v in rows)
        dialog = _alert(self, it.name, body, body_markup=True)
        box = Gtk.Box(spacing=8)
        box.append(Gtk.Label(label="Права (восьмерично):"))
        entry = Gtk.Entry(text=f"{stat.S_IMODE(it.mode):04o}", max_length=4, width_chars=6)
        box.append(entry)
        dialog.set_extra_child(box)
        dialog.add_response("close", "Закрыть")
        dialog.add_response("apply", "Применить права")
        dialog.set_close_response("close")

        def response(_d, r):
            if r != "apply":
                return
            try:
                mode = int(entry.get_text().strip(), 8)
            except ValueError:
                self.toast("Права указываются числом, например 0644")
                return
            self._sftp_call(lambda sftp: sftp.chmod(it.path, mode),
                            lambda _r: (self.reload(), self.toast("Права изменены")))

        dialog.connect("response", response)
        _present(dialog)

    # ---------------- передача ----------------

    def choose_upload(self):
        if self.sftp is None:
            return
        dialog = Gtk.FileDialog(title="Загрузить на сервер", modal=True)

        def done(d, result):
            try:
                files = d.open_multiple_finish(result)
            except GLib.Error:
                return
            paths = []
            for i in range(files.get_n_items()):
                f = files.get_item(i)
                if f.get_path():
                    paths.append(f.get_path())
            self.upload_paths(paths)

        dialog.open_multiple(self, None, done)

    def choose_upload_folder(self):
        if self.sftp is None:
            return
        dialog = Gtk.FileDialog(title="Загрузить папку на сервер", modal=True)

        def done(d, result):
            try:
                folder = d.select_folder_finish(result)
            except GLib.Error:
                return
            if folder and folder.get_path():
                self.upload_paths([folder.get_path()])

        dialog.select_folder(self, None, done)

    def upload_paths(self, paths: list[str]):
        paths = [p for p in paths if p and os.path.exists(p)]
        if not paths:
            return
        title = os.path.basename(paths[0]) if len(paths) == 1 else f"{len(paths)} объектов"
        self._enqueue(TransferJob("upload", f"Загрузка: {title}", paths, self.path,
                                  after=lambda job: (self.reload(), self.toast(f"Загружено в {job.dest}"))))

    def download_selected(self):
        items = self.selected_items()
        if not items:
            return
        dialog = Gtk.FileDialog(title="Куда сохранить", modal=True)
        downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or os.path.expanduser("~")
        dialog.set_initial_folder(Gio.File.new_for_path(downloads))

        def done(d, result):
            try:
                folder = d.select_folder_finish(result)
            except GLib.Error:
                return
            if folder is None or not folder.get_path():
                return
            title = items[0].name if len(items) == 1 else f"{len(items)} объектов"
            self._enqueue(TransferJob("download", f"Скачивание: {title}", items, folder.get_path(),
                                      after=lambda job: self.toast(f"Сохранено в {job.dest}")))

        dialog.select_folder(self, None, done)

    def _on_drop_enter(self, *_):
        self.drop_hint.set_visible(True)
        return Gdk.DragAction.COPY

    def _on_drop(self, _target, value, _x, _y):
        self.drop_hint.set_visible(False)
        try:
            files = value.get_files()
        except AttributeError:
            return False
        self.upload_paths([f.get_path() for f in files if f.get_path()])
        return True

    def _enqueue(self, job: TransferJob, overwrite: bool = False):
        job.overwrite = overwrite
        self.jobs.append(job)
        if self.job is None:
            self._next_job()

    def _next_job(self):
        if not self.jobs or self._closing:
            self.job = None
            self.transfer_revealer.set_reveal_child(False)
            return
        job = self.jobs.pop(0)
        self.job = job
        self.transfer_label.set_label(job.title)
        self.transfer_progress.set_fraction(0)
        self.transfer_detail.set_label("Подготовка…")
        self.transfer_revealer.set_reveal_child(True)
        GLib.timeout_add(150, self._tick_progress, job)

        def run():
            if self.transfer_sftp is None:
                self.transfer_sftp = self.conn.open_sftp()
            sftp = self.transfer_sftp
            if job.kind == "download":
                _run_download(sftp, job)
            else:
                _run_upload(sftp, job)
            return job

        def finished(_job):
            if job.after:
                job.after(job)
            self._next_job()

        def failed(e):
            if isinstance(e, Cancelled):
                self.toast("Передача отменена")
            else:
                self.toast(f"Ошибка передачи: {_io_error(e)}", timeout=6)
                self.transfer_sftp = None
            self._next_job()

        run_in_thread(run, finished, failed)

    def _tick_progress(self, job: TransferJob):
        if self.job is not job:
            return False
        if job.total > 0:
            self.transfer_progress.set_fraction(min(1.0, job.done / job.total))
        else:
            self.transfer_progress.pulse()
        elapsed = max(0.001, time.monotonic() - job.started)
        speed = job.done / elapsed
        left = ""
        if speed > 0 and job.total > job.done:
            secs = int((job.total - job.done) / speed)
            left = f" · осталось {secs // 60}:{secs % 60:02d}"
        queue = f" · ещё в очереди: {len(self.jobs)}" if self.jobs else ""
        files = f"{job.files_done}/{job.files_total} · " if job.files_total > 1 else ""
        self.transfer_detail.set_label(
            f"{files}{_fmt_size(job.done)} из {_fmt_size(job.total)} · {_fmt_size(int(speed))}/с{left}{queue}"
        )
        if job.current and job.files_total > 1:
            self.transfer_label.set_label(f"{job.title} — {job.current}")
        return True

    def _cancel_transfers(self):
        for j in self.jobs:
            j.cancelled = True
        self.jobs.clear()
        if self.job is not None:
            self.job.cancelled = True

    # ---------------- закрытие ----------------

    def _on_close_request(self, *_):
        self._closing = True
        self._cancel_transfers()
        conn, self.conn = self.conn, None
        sftp, self.sftp = self.sftp, None
        tsftp, self.transfer_sftp = self.transfer_sftp, None

        def shutdown():
            for s in (sftp, tsftp):
                try:
                    if s is not None:
                        s.close()
                except Exception:
                    pass
            if conn is not None:
                conn.close()

        threading.Thread(target=shutdown, daemon=True).start()
        return False


# ---------------------------------------------------------------------------
# Фоновые операции
# ---------------------------------------------------------------------------


def _io_error(e: BaseException) -> str:
    if isinstance(e, PermissionError) or (isinstance(e, IOError) and getattr(e, "errno", None) == 13):
        return "нет прав доступа"
    if isinstance(e, FileNotFoundError) or (isinstance(e, IOError) and getattr(e, "errno", None) == 2):
        return "файл или папка не найдены"
    if isinstance(e, IOError) and str(e) == "Failure":
        return "сервер отказал (возможно, папка не пуста или нет прав)"
    return describe_error(e)


def _rm_rf(sftp, path: str):
    attrs = sftp.lstat(path)
    if stat.S_ISDIR(attrs.st_mode or 0):
        for child in sftp.listdir_attr(path):
            if child.filename in (".", ".."):
                continue
            _rm_rf(sftp, posixpath.join(path, child.filename))
        sftp.rmdir(path)
    else:
        sftp.remove(path)


def _unique_local(path: str) -> str:
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    i = 1
    while os.path.exists(f"{root} ({i}){ext}"):
        i += 1
    return f"{root} ({i}){ext}"


def _run_download(sftp, job: TransferJob):
    plan: list[tuple[str, str, int]] = []  # (remote, local, size)
    dirs: list[str] = []

    def walk(remote: str, local: str):
        if job.cancelled:
            raise Cancelled()
        attrs = sftp.stat(remote)
        if stat.S_ISDIR(attrs.st_mode or 0):
            dirs.append(local)
            for child in sftp.listdir_attr(remote):
                if child.filename in (".", ".."):
                    continue
                walk(posixpath.join(remote, child.filename), os.path.join(local, child.filename))
        else:
            plan.append((remote, local, attrs.st_size or 0))

    for item in job.sources:
        local = os.path.join(job.dest, item.name)
        if not getattr(job, "overwrite", False):
            local = _unique_local(local)
        walk(item.path, local)

    job.total = sum(size for _r, _l, size in plan)
    job.files_total = len(plan)
    for d in dirs:
        os.makedirs(d, exist_ok=True)
    for remote, local, size in plan:
        if job.cancelled:
            raise Cancelled()
        job.current = posixpath.basename(remote)
        os.makedirs(os.path.dirname(local) or ".", exist_ok=True)
        tmp = local + ".part"
        try:
            with sftp.open(remote, "rb") as rf:
                if size > 0:
                    rf.prefetch(size)
                with open(tmp, "wb") as lf:
                    while True:
                        if job.cancelled:
                            raise Cancelled()
                        data = rf.read(CHUNK)
                        if not data:
                            break
                        lf.write(data)
                        job.done += len(data)
            os.replace(tmp, local)
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        job.files_done += 1
        job.results.append(local)
    if not plan:
        job.results.extend(dirs[:1])


def _run_upload(sftp, job: TransferJob):
    plan: list[tuple[str, str, int]] = []  # (local, remote, size)
    dirs: list[str] = []
    for src in job.sources:
        base = os.path.basename(os.path.normpath(src))
        remote_base = posixpath.join(job.dest, base)
        if os.path.isdir(src):
            for root, subdirs, files in os.walk(src):
                rel = os.path.relpath(root, src)
                rdir = remote_base if rel == "." else posixpath.join(remote_base, *rel.split(os.sep))
                dirs.append(rdir)
                subdirs.sort()
                for name in sorted(files):
                    local = os.path.join(root, name)
                    try:
                        plan.append((local, posixpath.join(rdir, name), os.path.getsize(local)))
                    except OSError:
                        pass
        else:
            plan.append((src, remote_base, os.path.getsize(src)))

    job.total = sum(size for _l, _r, size in plan)
    job.files_total = len(plan)
    for d in dirs:
        if job.cancelled:
            raise Cancelled()
        try:
            sftp.mkdir(d)
        except IOError:
            pass  # уже существует
    for local, remote, _size in plan:
        if job.cancelled:
            raise Cancelled()
        job.current = os.path.basename(local)
        try:
            with open(local, "rb") as lf, sftp.open(remote, "wb") as wf:
                wf.set_pipelined(True)
                while True:
                    if job.cancelled:
                        raise Cancelled()
                    chunk = lf.read(CHUNK)
                    if not chunk:
                        break
                    wf.write(chunk)
                    job.done += len(chunk)
        except Cancelled:
            try:
                sftp.remove(remote)
            except IOError:
                pass
            raise
        job.files_done += 1
        job.results.append(remote)


# ---------------------------------------------------------------------------
# Редактор
# ---------------------------------------------------------------------------


class EditorWindow(Adw.Window):
    def __init__(self, browser: SFTPWindow, remote_path: str, text: str):
        super().__init__(application=browser.get_application(), transient_for=browser)
        self.browser = browser
        self.remote_path = remote_path
        self.saving = False
        self._force_close = False
        name = posixpath.basename(remote_path)
        self.set_default_size(900, 680)
        self.set_title(name)

        self.toasts = Adw.ToastOverlay()
        toolbar = Adw.ToolbarView()
        self.toasts.set_child(toolbar)
        self.set_content(self.toasts)

        header = Adw.HeaderBar()
        self.title_widget = Adw.WindowTitle(title=name, subtitle=posixpath.dirname(remote_path))
        header.set_title_widget(self.title_widget)
        self.save_btn = Gtk.Button(label="Сохранить", css_classes=["suggested-action"],
                                   tooltip_text="Сохранить на сервер (Ctrl+S)")
        self.save_btn.connect("clicked", lambda *_: self.save())
        header.pack_end(self.save_btn)
        toolbar.add_top_bar(header)

        if GtkSource is not None:
            self.buffer = GtkSource.Buffer()
            lang = GtkSource.LanguageManager.get_default().guess_language(name, None)
            if lang is not None:
                self.buffer.set_language(lang)
            scheme = GtkSource.StyleSchemeManager.get_default().get_scheme("Adwaita-dark")
            if scheme is not None:
                self.buffer.set_style_scheme(scheme)
            view = GtkSource.View(buffer=self.buffer, monospace=True, show_line_numbers=True,
                                  highlight_current_line=True, auto_indent=True, tab_width=4)
        else:
            self.buffer = Gtk.TextBuffer()
            view = Gtk.TextView(buffer=self.buffer, monospace=True)
        view.set_top_margin(8)
        view.set_bottom_margin(8)
        view.set_left_margin(8)
        view.set_right_margin(8)
        self.view = view

        if GtkSource is not None:
            self.buffer.begin_irreversible_action()
            self.buffer.set_text(text)
            self.buffer.end_irreversible_action()
        else:
            self.buffer.set_text(text)
        self.buffer.set_modified(False)
        self.buffer.place_cursor(self.buffer.get_start_iter())
        self.buffer.connect("modified-changed", lambda *_: self._update_title())

        scroll = Gtk.ScrolledWindow(child=view, vexpand=True)
        toolbar.set_content(scroll)

        ctrl = Gtk.ShortcutController()
        ctrl.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string("<Control>s"),
                                           Gtk.CallbackAction.new(lambda *_: (self.save(), True)[1])))
        ctrl.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string("<Control>w"),
                                           Gtk.CallbackAction.new(lambda *_: (self.close(), True)[1])))
        self.add_controller(ctrl)
        self.connect("close-request", self._on_close_request)
        GLib.idle_add(lambda: (view.grab_focus(), False)[1])

    def _update_title(self):
        name = posixpath.basename(self.remote_path)
        self.title_widget.set_title(("• " if self.buffer.get_modified() else "") + name)

    def save(self, then: Optional[Callable] = None):
        if self.saving:
            return
        self.saving = True
        self.save_btn.set_sensitive(False)
        start, end = self.buffer.get_bounds()
        text = self.buffer.get_text(start, end, True)

        def ok():
            self.saving = False
            self.save_btn.set_sensitive(True)
            self.buffer.set_modified(False)
            self.toasts.add_toast(Adw.Toast(title="Сохранено", timeout=2))
            if then:
                then()

        def failed(e):
            self.saving = False
            self.save_btn.set_sensitive(True)
            self.toasts.add_toast(Adw.Toast(title=GLib.markup_escape_text(f"Не удалось сохранить: {_io_error(e)}"),
                                            timeout=6))

        self.browser.write_text(self.remote_path, text, ok, failed)

    def _on_close_request(self, *_):
        if self._force_close or not self.buffer.get_modified():
            return False
        dialog = _alert(self, "Сохранить изменения?",
                        f"Файл «{posixpath.basename(self.remote_path)}» изменён.")
        dialog.add_response("cancel", "Отмена")
        dialog.add_response("discard", "Не сохранять")
        dialog.add_response("save", "Сохранить")
        dialog.set_response_appearance("discard", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_response_appearance("save", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("save")
        dialog.set_close_response("cancel")

        def response(_d, r):
            if r == "discard":
                self._force_close = True
                self.close()
            elif r == "save":
                def closed():
                    self._force_close = True
                    self.close()

                self.save(then=closed)

        dialog.connect("response", response)
        _present(dialog)
        return True
