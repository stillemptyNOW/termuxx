"""Окно «SSH-ключи»: генерация Ed25519, импорт, копирование публичного ключа, установка на сервер."""

from __future__ import annotations

import os
import subprocess
import tempfile
from datetime import datetime
from typing import Callable, Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gio, GLib, Gtk, Pango  # noqa: E402

from termuxx.dialogs import confirm, show_error, toolbar_dialog  # noqa: E402
from termuxx.store import KeyItem, Store  # noqa: E402


def key_type_from_public(pub: str) -> str:
    prefix = (pub.split() or [""])[0]
    return {
        "ssh-ed25519": "ED25519",
        "ssh-rsa": "RSA",
        "ecdsa-sha2-nistp256": "ECDSA",
        "ecdsa-sha2-nistp384": "ECDSA",
        "ecdsa-sha2-nistp521": "ECDSA",
        "sk-ssh-ed25519@openssh.com": "ED25519-SK",
    }.get(prefix, prefix.upper() or "?")


def is_encrypted(pem: str) -> bool:
    """Зашифрован ли приватный ключ (OpenSSH или PEM)."""
    if "ENCRYPTED" in pem:
        return True
    body = "".join(line.strip() for line in pem.strip().splitlines() if not line.startswith("-----"))
    try:
        import base64

        data = base64.b64decode(body + "===")
    except Exception:
        return False
    magic = b"openssh-key-v1\x00"
    if not data.startswith(magic) or len(data) < len(magic) + 4:
        return False
    n = int.from_bytes(data[len(magic):len(magic) + 4], "big")
    cipher = data[len(magic) + 4:len(magic) + 4 + n].decode(errors="ignore")
    return cipher != "none"


def public_from_private(pem: str, passphrase: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Возвращает (публичный ключ, ошибка) через `ssh-keygen -y`."""
    fd, path = tempfile.mkstemp(prefix="termuxx-key-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(pem.strip().replace("\r\n", "\n") + "\n")
        r = subprocess.run(["ssh-keygen", "-y", "-P", passphrase or "", "-f", path],
                           capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            err = (r.stderr or "").strip()
            if "incorrect passphrase" in err or "passphrase" in err.lower():
                return None, "Неверный пароль от ключа."
            return None, err or "Не удалось прочитать ключ."
        return r.stdout.strip(), None
    except FileNotFoundError:
        return None, "Не найден ssh-keygen (пакет openssh)."
    except subprocess.TimeoutExpired:
        return None, "ssh-keygen не ответил."
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def generate_ed25519(name: str, passphrase: str = "") -> tuple[str, str]:
    """(приватный PEM, публичный ключ)."""
    with tempfile.TemporaryDirectory(prefix="termuxx-gen-") as d:
        path = os.path.join(d, "id_ed25519")
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", passphrase, "-C", name, "-f", path],
                       check=True, capture_output=True, timeout=30)
        with open(path, "r", encoding="utf-8") as f:
            pem = f.read()
        with open(path + ".pub", "r", encoding="utf-8") as f:
            pub = f.read().strip()
    return pem, pub


def _copy_text(widget: Gtk.Widget, text: str) -> None:
    clipboard = widget.get_display().get_clipboard()
    clipboard.set(text)


class KeysDialog:
    def __init__(self, window, on_install: Optional[Callable] = None):
        self.window = window
        self.store = Store.get()
        self.on_install = on_install

        self.page = Adw.PreferencesPage()
        self.group = Adw.PreferencesGroup(
            title="SSH-ключи",
            description="Вход по ключу надёжнее пароля. Приватные ключи хранятся в системном хранилище паролей.",
        )
        add = Gtk.MenuButton(icon_name="list-add-symbolic", tooltip_text="Добавить ключ")
        add.add_css_class("flat")
        menu = Gio.Menu()
        menu.append("Создать ключ Ed25519", "keys.generate")
        menu.append("Импортировать из файла…", "keys.import-file")
        menu.append("Вставить из буфера обмена", "keys.import-clipboard")
        add.set_menu_model(menu)
        self.group.set_header_suffix(add)
        self.page.add(self.group)
        self.rows: list[Gtk.Widget] = []

        self.dialog = toolbar_dialog("Ключи", self.page, None, width=620, height=560)
        group = Gio.SimpleActionGroup()
        for name, cb in (("generate", self._ask_generate), ("import-file", self._import_file),
                         ("import-clipboard", self._import_clipboard)):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", lambda *_a, f=cb: f())
            group.add_action(action)
        self.dialog.insert_action_group("keys", group)
        self._render()
        self.store.subscribe(self._render)
        self.dialog.connect("closed", lambda *_: self.store.unsubscribe(self._render))
        self.dialog.present(window)

    def _render(self) -> None:
        for r in self.rows:
            self.group.remove(r)
        self.rows = []
        if not self.store.keys:
            row = Adw.ActionRow(title="Ключей пока нет", subtitle="Нажмите «+» → «Создать ключ Ed25519»")
            self.group.add(row)
            self.rows.append(row)
            return
        for key in self.store.keys:
            try:
                created = datetime.strptime(key.created, "%Y-%m-%dT%H:%M:%SZ").strftime("%d.%m.%Y")
            except ValueError:
                created = key.created[:10]
            subtitle = f"{key.type} · {created}" + (" · с паролем" if key.encrypted else "")
            row = Adw.ExpanderRow(title=GLib.markup_escape_text(key.name), subtitle=subtitle)
            icon = Gtk.Image(icon_name="dialog-password-symbolic")
            row.add_prefix(icon)
            if key.public_key:
                pub = Gtk.Label(label=key.public_key, wrap=True, selectable=True, xalign=0)
                pub.set_wrap_mode(Pango.WrapMode.CHAR)
                pub.add_css_class("monospace")
                pub.add_css_class("caption")
                pub.set_margin_top(10)
                pub.set_margin_bottom(10)
                pub.set_margin_start(12)
                pub.set_margin_end(12)
                row.add_row(pub)
            actions = Gtk.Box(spacing=8, halign=Gtk.Align.END)
            actions.set_margin_top(8)
            actions.set_margin_bottom(8)
            actions.set_margin_end(12)
            if key.public_key:
                copy = Gtk.Button(label="Скопировать публичный ключ")
                copy.connect("clicked", lambda _b, k=key: self._copy(k))
                actions.append(copy)
                install = Gtk.Button(label="Установить на сервер…")
                install.add_css_class("suggested-action")
                install.connect("clicked", lambda b, k=key: self._install_menu(b, k))
                actions.append(install)
            delete = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Удалить ключ")
            delete.add_css_class("destructive-action")
            delete.connect("clicked", lambda _b, k=key: self._delete(k))
            actions.append(delete)
            row.add_row(actions)
            self.group.add(row)
            self.rows.append(row)

    def _toast(self, text: str) -> None:
        if hasattr(self.window, "toast"):
            self.window.toast(text)

    def _copy(self, key: KeyItem) -> None:
        _copy_text(self.dialog, key.public_key)
        self._toast("Публичный ключ скопирован")

    def _delete(self, key: KeyItem) -> None:
        confirm(self.dialog, "Удалить ключ?", f"«{key.name}» будет удалён из Termuxx. На серверах он останется.",
                "Удалить", lambda: self.store.delete_key(key))

    def _install_menu(self, button: Gtk.Button, key: KeyItem) -> None:
        if not self.store.servers:
            show_error(self.dialog, "Нет серверов", "Сначала добавьте сервер.")
            return
        popover = Gtk.Popover()
        box = Gtk.ListBox()
        box.add_css_class("boxed-list")
        box.set_selection_mode(Gtk.SelectionMode.NONE)
        for server in self.store.sorted_servers():
            row = Adw.ActionRow(title=GLib.markup_escape_text(server.title), subtitle=server.subtitle, activatable=True)
            row.connect("activated", lambda _r, s=server: (popover.popdown(), self._install(key, s)))
            box.append(row)
        scrolled = Gtk.ScrolledWindow(child=box, propagate_natural_height=True, max_content_height=360,
                                      propagate_natural_width=True)
        scrolled.set_min_content_width(280)
        popover.set_child(scrolled)
        popover.set_parent(button)
        popover.popup()

    def _install(self, key: KeyItem, server) -> None:
        if self.on_install:
            self.dialog.close()
            self.on_install(key, server)

    # --- создание / импорт ---------------------------------------------------------

    def _ask_generate(self) -> None:
        dialog = Adw.AlertDialog(heading="Новый ключ Ed25519", body="Пароль от ключа необязателен.")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        name = Gtk.Entry(text=f"termuxx@{GLib.get_host_name()}", placeholder_text="Имя ключа")
        name.set_activates_default(True)
        passphrase = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text="Пароль (необязательно)")
        passphrase.set_property("placeholder-text", "Пароль (необязательно)")
        box.append(name)
        box.append(passphrase)
        dialog.set_extra_child(box)
        dialog.add_response("cancel", "Отмена")
        dialog.add_response("ok", "Создать")
        dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("ok")
        dialog.set_close_response("cancel")

        def on_response(_d, response):
            if response != "ok":
                return
            key_name = name.get_text().strip() or "termuxx"
            pp = passphrase.get_text()
            try:
                pem, pub = generate_ed25519(key_name, pp)
            except Exception as e:
                show_error(self.dialog, "Не удалось создать ключ", str(e))
                return
            self.store.add_key(KeyItem(name=key_name, type="ED25519", public_key=pub, encrypted=bool(pp) or None),
                               pem, pp or None)
            self._toast("Ключ создан")

        dialog.connect("response", on_response)
        dialog.present(self.dialog)

    def _import_file(self) -> None:
        file_dialog = Gtk.FileDialog(title="Выберите приватный ключ")
        ssh_dir = os.path.expanduser("~/.ssh")
        if os.path.isdir(ssh_dir):
            file_dialog.set_initial_folder(Gio.File.new_for_path(ssh_dir))

        def done(dlg, result):
            try:
                f = dlg.open_finish(result)
            except GLib.Error:
                return
            path = f.get_path()
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    text = fh.read()
            except (OSError, UnicodeDecodeError) as e:
                show_error(self.dialog, "Не удалось прочитать файл", str(e))
                return
            self._import_text(text, os.path.basename(path))

        file_dialog.open(self.window, None, done)

    def _import_clipboard(self) -> None:
        clipboard = self.dialog.get_display().get_clipboard()

        def done(cb, result):
            try:
                text = cb.read_text_finish(result)
            except GLib.Error:
                text = None
            if not text:
                show_error(self.dialog, "Буфер пуст", "Скопируйте приватный ключ и попробуйте снова.")
                return
            self._import_text(text, "Импортированный ключ")

        clipboard.read_text_async(None, done)

    def _import_text(self, pem: str, default_name: str) -> None:
        if "PRIVATE KEY" not in pem:
            show_error(self.dialog, "Это не приватный ключ",
                       "Нужен файл вида -----BEGIN OPENSSH PRIVATE KEY----- (например ~/.ssh/id_ed25519).")
            return
        encrypted = is_encrypted(pem)
        dialog = Adw.AlertDialog(heading="Импорт ключа",
                                 body="Ключ защищён паролем — введите его." if encrypted else "Как назвать ключ?")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        name = Gtk.Entry(text=default_name)
        name.set_activates_default(True)
        box.append(name)
        passphrase = Gtk.PasswordEntry(show_peek_icon=True)
        passphrase.set_property("placeholder-text", "Пароль от ключа")
        if encrypted:
            box.append(passphrase)
        dialog.set_extra_child(box)
        dialog.add_response("cancel", "Отмена")
        dialog.add_response("ok", "Импортировать")
        dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("ok")
        dialog.set_close_response("cancel")

        def on_response(_d, response):
            if response != "ok":
                return
            pp = passphrase.get_text() if encrypted else None
            pub, err = public_from_private(pem, pp)
            if err:
                show_error(self.dialog, "Ключ не подошёл", err)
                return
            key_name = name.get_text().strip() or default_name
            self.store.add_key(KeyItem(name=key_name, type=key_type_from_public(pub), public_key=pub,
                                       encrypted=True if encrypted else None),
                               pem.strip() + "\n", pp or None)
            self._toast("Ключ импортирован")

        dialog.connect("response", on_response)
        dialog.present(self.dialog)
