"""Диалоги: редактор сервера, проброс порта, быстрое подключение, запрос пароля."""

from __future__ import annotations

from typing import Callable, Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gtk  # noqa: E402

from termuxx.store import HOST_COLORS, PortForward, ProxyConfig, Server, Store  # noqa: E402


def toolbar_dialog(title: str, content: Gtk.Widget, on_save: Optional[Callable[[], bool]] = None,
                   save_label: str = "Сохранить", width: int = 560, height: int = 680) -> Adw.Dialog:
    """Adw.Dialog с шапкой «Отмена / Сохранить»."""
    dialog = Adw.Dialog(title=title, content_width=width, content_height=height)
    view = Adw.ToolbarView()
    header = Adw.HeaderBar()
    if on_save is not None:
        header.set_show_end_title_buttons(False)
        header.set_show_start_title_buttons(False)
        cancel = Gtk.Button(label="Отмена")
        cancel.connect("clicked", lambda *_: dialog.close())
        header.pack_start(cancel)
        save = Gtk.Button(label=save_label)
        save.add_css_class("suggested-action")

        def do_save(*_):
            if on_save():
                dialog.close()

        save.connect("clicked", do_save)
        header.pack_end(save)
        dialog.save_button = save
    view.add_top_bar(header)
    view.set_content(content)
    dialog.set_child(view)
    return dialog


def entry_row(title: str, text: str = "", monospace: bool = False) -> Adw.EntryRow:
    row = Adw.EntryRow(title=title)
    row.set_text(text or "")
    if monospace:
        row.add_css_class("monospace")
    return row


def spin_row(title: str, value: int, lower: int = 1, upper: int = 65535) -> Adw.SpinRow:
    adj = Gtk.Adjustment(value=value, lower=lower, upper=upper, step_increment=1, page_increment=10)
    row = Adw.SpinRow(title=title, adjustment=adj, digits=0)
    row.set_numeric(True)
    return row


def string_list(items: list[str]) -> Gtk.StringList:
    model = Gtk.StringList()
    for item in items:
        model.append(item)
    return model


def show_error(parent: Gtk.Widget, title: str, body: str) -> None:
    dialog = Adw.AlertDialog(heading=title, body=body)
    dialog.add_response("ok", "OK")
    dialog.present(parent)


def confirm(parent: Gtk.Widget, title: str, body: str, action_label: str, on_confirm: Callable[[], None],
            destructive: bool = True) -> None:
    dialog = Adw.AlertDialog(heading=title, body=body)
    dialog.add_response("cancel", "Отмена")
    dialog.add_response("ok", action_label)
    dialog.set_response_appearance(
        "ok", Adw.ResponseAppearance.DESTRUCTIVE if destructive else Adw.ResponseAppearance.SUGGESTED
    )
    dialog.set_default_response("cancel" if destructive else "ok")
    dialog.set_close_response("cancel")
    dialog.connect("response", lambda _d, r: on_confirm() if r == "ok" else None)
    dialog.present(parent)


def ask_password(parent: Gtk.Widget, server: Server, on_done: Callable[[str, bool], None],
                 title: Optional[str] = None) -> None:
    """Спрашивает пароль. on_done(password, save)."""
    dialog = Adw.AlertDialog(heading=title or "Пароль", body=f"Пароль для {server.subtitle}")
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    entry = Gtk.PasswordEntry(show_peek_icon=True)
    entry.set_activates_default(True)
    box.append(entry)
    save = Gtk.CheckButton(label="Сохранить пароль")
    box.append(save)
    dialog.set_extra_child(box)
    dialog.add_response("cancel", "Отмена")
    dialog.add_response("ok", "Подключиться")
    dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
    dialog.set_default_response("ok")
    dialog.set_close_response("cancel")

    def on_response(_d, response):
        if response == "ok":
            on_done(entry.get_text(), save.get_active())

    dialog.connect("response", on_response)
    dialog.present(parent)
    entry.grab_focus()


def quick_connect(parent: Gtk.Widget, on_done: Callable[[Server, bool], None]) -> None:
    """Быстрое подключение по строке user@host:port. on_done(server, save)."""
    dialog = Adw.AlertDialog(
        heading="Быстрое подключение",
        body="Например root@203.0.113.10, admin@my.server:2222 или ssh user@host -p 2222",
    )
    entry = Gtk.Entry(placeholder_text="user@host:port")
    entry.add_css_class("monospace")
    entry.set_activates_default(True)
    dialog.set_extra_child(entry)
    dialog.add_response("cancel", "Отмена")
    dialog.add_response("save", "Сохранить и подключиться")
    dialog.add_response("ok", "Подключиться")
    dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
    dialog.set_default_response("ok")
    dialog.set_close_response("cancel")

    def on_response(_d, response):
        if response in ("ok", "save"):
            server = Server.quick(entry.get_text())
            if server is None:
                show_error(parent, "Не понял адрес", "Введите адрес в виде user@host или user@host:port.")
                return
            on_done(server, response == "save")

    dialog.connect("response", on_response)
    dialog.present(parent)
    entry.grab_focus()


class ForwardEditor:
    """Редактор правила проброса порта."""

    def __init__(self, parent: Gtk.Widget, forward: Optional[PortForward], on_save: Callable[[PortForward], None]):
        self.forward = forward or PortForward()
        page = Adw.PreferencesPage()
        group = Adw.PreferencesGroup(
            description="Порт на этом компьютере будет вести на адрес со стороны сервера. "
                        "Например, локальный 8080 → 127.0.0.1:80 открывает веб-панель сервера."
        )
        self.name = entry_row("Название (необязательно)", self.forward.name)
        self.local = spin_row("Локальный порт", self.forward.local_port, 1, 65535)
        self.rhost = entry_row("Адрес на сервере", self.forward.remote_host, monospace=True)
        self.rport = spin_row("Порт на сервере", self.forward.remote_port, 1, 65535)
        self.auto = Adw.SwitchRow(title="Включать при подключении", active=self.forward.auto_start)
        for w in (self.name, self.local, self.rhost, self.rport, self.auto):
            group.add(w)
        page.add(group)

        def save() -> bool:
            f = self.forward
            f.name = self.name.get_text().strip()
            f.local_port = int(self.local.get_value())
            f.remote_host = self.rhost.get_text().strip() or "127.0.0.1"
            f.remote_port = int(self.rport.get_value())
            f.auto_start = self.auto.get_active()
            on_save(f)
            return True

        title = "Новый проброс" if forward is None else "Проброс порта"
        self.dialog = toolbar_dialog(title, page, save, width=480, height=520)
        self.dialog.present(parent)


class ServerEditor:
    """Создание и редактирование сервера."""

    def __init__(self, parent: Gtk.Widget, server: Optional[Server] = None,
                 on_saved: Optional[Callable[[Server], None]] = None):
        self.parent = parent
        self.store = Store.get()
        self.is_new = server is None
        self.server = server.copy() if server is not None else Server()
        self.on_saved = on_saved
        self.forwards = [PortForward.from_json(f.to_json()) for f in self.server.forwards]
        s = self.server

        page = Adw.PreferencesPage()

        # --- Сервер
        g = Adw.PreferencesGroup(title="Сервер")
        self.name = entry_row("Название", s.name)
        self.host = entry_row("Адрес (IP или домен)", s.hostname, monospace=True)
        self.port = spin_row("Порт", s.port)
        self.user = entry_row("Пользователь", s.username, monospace=True)
        for w in (self.name, self.host, self.port, self.user):
            g.add(w)
        page.add(g)

        # --- Вход
        g = Adw.PreferencesGroup(title="Вход", description="Пароли и ключи хранятся в системном хранилище паролей.")
        self.auth = Adw.ComboRow(title="Способ входа", model=string_list(["Пароль", "SSH-ключ"]))
        self.auth.set_selected(1 if s.auth == "key" else 0)
        self.password = Adw.PasswordEntryRow(title="Пароль (пусто — спрашивать)")
        if not self.is_new:
            self.password.set_text(self.store.password(s) or "")
        self.key_ids: list[Optional[str]] = [None] + [k.id for k in self.store.keys]
        key_names = ["Не выбран"] + [f"{k.name} · {k.type}" for k in self.store.keys]
        self.key = Adw.ComboRow(title="Ключ", model=string_list(key_names))
        if s.key_id in self.key_ids:
            self.key.set_selected(self.key_ids.index(s.key_id))
        if not self.store.keys:
            self.key.set_subtitle("Ключей пока нет — создайте их в меню «Ключи»")
        for w in (self.auth, self.password, self.key):
            g.add(w)
        self.auth.connect("notify::selected", lambda *_: self._sync_auth())
        page.add(g)

        # --- Сессия
        g = Adw.PreferencesGroup(title="Сессия")
        self.tmux = Adw.SwitchRow(title="Работать через tmux",
                                  subtitle="После обрыва вернётесь в ту же сессию", active=s.use_tmux)
        self.reconnect = Adw.SwitchRow(title="Автопереподключение", active=s.auto_reconnect)
        self.keepalive = Adw.SwitchRow(title="Keep-alive", subtitle="Не даёт простаивающему соединению оборваться",
                                       active=s.keep_alive)
        self.snippet_ids: list[Optional[str]] = [None] + [sn.id for sn in self.store.snippets]
        self.snippet = Adw.ComboRow(title="Команда при входе",
                                    model=string_list(["Нет"] + [sn.name for sn in self.store.snippets]))
        if s.startup_snippet_id in self.snippet_ids:
            self.snippet.set_selected(self.snippet_ids.index(s.startup_snippet_id))
        for w in (self.tmux, self.reconnect, self.keepalive, self.snippet):
            g.add(w)
        page.add(g)

        # --- Подключение через
        g = Adw.PreferencesGroup(title="Подключение через")
        others = [x for x in self.store.servers if x.id != s.id]
        self.jump_ids: list[Optional[str]] = [None] + [x.id for x in others]
        self.jump = Adw.ComboRow(title="Промежуточный сервер (jump host)",
                                 model=string_list(["Напрямую"] + [f"{x.title} ({x.subtitle})" for x in others]))
        if s.jump_host_id in self.jump_ids:
            self.jump.set_selected(self.jump_ids.index(s.jump_host_id))
        g.add(self.jump)

        self.proxy = Adw.ExpanderRow(title="SOCKS5-прокси", subtitle="Подключаться к серверу через прокси")
        self.proxy.set_show_enable_switch(True)
        self.proxy.set_enable_expansion(bool(s.proxy and s.proxy.host))
        p = s.proxy or ProxyConfig()
        self.proxy_host = entry_row("Адрес прокси", p.host, monospace=True)
        self.proxy_port = spin_row("Порт прокси", p.port)
        self.proxy_user = entry_row("Логин (необязательно)", p.username)
        self.proxy_pass = Adw.PasswordEntryRow(title="Пароль прокси")
        if not self.is_new:
            self.proxy_pass.set_text(self.store.proxy_password(s) or "")
        for w in (self.proxy_host, self.proxy_port, self.proxy_user, self.proxy_pass):
            self.proxy.add_row(w)
        g.add(self.proxy)
        page.add(g)

        # --- Проброс портов
        self.fwd_group = Adw.PreferencesGroup(
            title="Проброс портов",
            description="Открываются вместе с SSH-сессией (ssh -L) или вручную в окне «Туннели».",
        )
        add_btn = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="Добавить проброс")
        add_btn.add_css_class("flat")
        add_btn.connect("clicked", lambda *_: ForwardEditor(self.dialog, None, self._add_forward))
        self.fwd_group.set_header_suffix(add_btn)
        self.fwd_rows: list[Gtk.Widget] = []
        page.add(self.fwd_group)
        self._render_forwards()

        # --- Цвет
        g = Adw.PreferencesGroup(title="Цвет")
        row = Adw.ActionRow(title="Метка в списке")
        colors = Gtk.Box(spacing=8)
        colors.set_valign(Gtk.Align.CENTER)
        first = None
        self.color_buttons = {}
        for i, hex_color in enumerate(HOST_COLORS):
            btn = Gtk.CheckButton()
            btn.add_css_class("color-swatch")
            btn.add_css_class(f"swatch-{i}")
            btn.set_tooltip_text(hex_color)
            if first is None:
                first = btn
            else:
                btn.set_group(first)
            btn.set_active(s.color_hex.upper() == hex_color.upper())
            self.color_buttons[hex_color] = btn
            colors.append(btn)
        row.add_suffix(colors)
        g.add(row)
        page.add(g)

        # --- Отпечаток (если сервер уже известен)
        if not self.is_new:
            g = Adw.PreferencesGroup()
            delete = Gtk.Button(label="Удалить сервер")
            delete.add_css_class("destructive-action")
            delete.set_halign(Gtk.Align.CENTER)
            delete.connect("clicked", lambda *_: self._delete())
            g.add(delete)
            page.add(g)

        self._sync_auth()
        self.dialog = toolbar_dialog("Новый сервер" if self.is_new else "Изменить сервер", page, self._save)
        self.dialog.present(parent)
        if self.is_new:
            self.host.grab_focus()

    def _sync_auth(self) -> None:
        is_key = self.auth.get_selected() == 1
        self.password.set_visible(not is_key)
        self.key.set_visible(is_key)

    def _render_forwards(self) -> None:
        for row in self.fwd_rows:
            self.fwd_group.remove(row)
        self.fwd_rows = []
        if not self.forwards:
            row = Adw.ActionRow(title="Нет правил", subtitle="Нажмите «+», чтобы добавить")
            row.add_css_class("dim-label")
            self.fwd_group.add(row)
            self.fwd_rows.append(row)
            return
        for f in self.forwards:
            row = Adw.ActionRow(title=f.title,
                                subtitle=f"127.0.0.1:{f.local_port} → {f.remote_host}:{f.remote_port}"
                                + ("" if f.auto_start else " · вручную"))
            edit = Gtk.Button(icon_name="document-edit-symbolic", tooltip_text="Изменить")
            edit.add_css_class("flat")
            edit.set_valign(Gtk.Align.CENTER)
            edit.connect("clicked", lambda _b, fw=f: ForwardEditor(self.dialog, fw, lambda _f: self._render_forwards()))
            rm = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Удалить")
            rm.add_css_class("flat")
            rm.set_valign(Gtk.Align.CENTER)
            rm.connect("clicked", lambda _b, fw=f: self._remove_forward(fw))
            row.add_suffix(edit)
            row.add_suffix(rm)
            self.fwd_group.add(row)
            self.fwd_rows.append(row)

    def _add_forward(self, forward: PortForward) -> None:
        self.forwards.append(forward)
        self._render_forwards()

    def _remove_forward(self, forward: PortForward) -> None:
        self.forwards = [f for f in self.forwards if f.id != forward.id]
        self._render_forwards()

    def _delete(self) -> None:
        def do():
            self.store.delete_server(self.server)
            self.dialog.close()

        confirm(self.dialog, "Удалить сервер?", f"«{self.server.title}» будет удалён вместе с сохранённым паролем.",
                "Удалить", do)

    def _save(self) -> bool:
        s = self.server
        host = self.host.get_text().strip()
        if not host:
            self.host.add_css_class("error")
            return False
        s.name = self.name.get_text().strip()
        s.hostname = host
        s.port = int(self.port.get_value())
        s.username = self.user.get_text().strip() or "root"
        s.auth = "key" if self.auth.get_selected() == 1 else "password"
        s.key_id = self.key_ids[self.key.get_selected()] if self.key.get_selected() < len(self.key_ids) else None
        s.use_tmux = self.tmux.get_active()
        s.auto_reconnect = self.reconnect.get_active()
        s.keep_alive = self.keepalive.get_active()
        idx = self.snippet.get_selected()
        s.startup_snippet_id = self.snippet_ids[idx] if idx < len(self.snippet_ids) else None
        idx = self.jump.get_selected()
        s.jump_host_id = self.jump_ids[idx] if idx < len(self.jump_ids) else None
        if self.proxy.get_enable_expansion() and self.proxy_host.get_text().strip():
            s.proxy = ProxyConfig(host=self.proxy_host.get_text().strip(), port=int(self.proxy_port.get_value()),
                                  username=self.proxy_user.get_text().strip())
        else:
            s.proxy = None
        s.forwards = self.forwards
        for hex_color, btn in self.color_buttons.items():
            if btn.get_active():
                s.color_hex = hex_color
        self.store.upsert_server(s)
        if s.auth == "password":
            self.store.set_password(s, self.password.get_text() or None)
        if s.proxy:
            self.store.set_proxy_password(s, self.proxy_pass.get_text() or None)
        else:
            self.store.set_proxy_password(s, None)
        if self.on_saved:
            self.on_saved(s)
        return True
