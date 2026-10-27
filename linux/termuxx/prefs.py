"""Параметры: внешний вид терминала, поведение, резервная копия."""

from __future__ import annotations

import os
from datetime import date

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gio, GLib, Gtk, Pango  # noqa: E402

from termuxx import backup  # noqa: E402
from termuxx.dialogs import show_error, spin_row, string_list  # noqa: E402
from termuxx.settings import Settings  # noqa: E402
from termuxx.store import Store  # noqa: E402
from termuxx.terminal import font_family_available  # noqa: E402
from termuxx.themes import THEMES  # noqa: E402

CURSORS = [("block", "Блок"), ("ibeam", "Черта"), ("underline", "Подчёркивание")]
SCHEMES = [("dark", "Тёмная"), ("light", "Светлая"), ("system", "Как в системе")]


def _theme_preview(theme) -> Gtk.Widget:
    box = Gtk.Box(spacing=0)
    box.add_css_class("theme-preview")
    box.add_css_class(f"theme-{theme.id}")
    box.set_valign(Gtk.Align.CENTER)
    for i in range(8):
        dot = Gtk.Box()
        dot.add_css_class("theme-cell")
        dot.add_css_class(f"theme-{theme.id}-{i}")
        dot.set_size_request(10, 18)
        box.append(dot)
    return box


def theme_css() -> str:
    lines = []
    for t in THEMES:
        lines.append(f".theme-{t.id} {{ background: {t.background}; padding: 3px; border-radius: 6px; }}")
        for i, c in enumerate(t.ansi[:8]):
            lines.append(f".theme-{t.id}-{i} {{ background: {c}; }}")
    return "\n".join(lines)


class PreferencesDialog:
    def __init__(self, window):
        self.window = window
        self.settings = Settings.get()
        self.store = Store.get()
        dialog = Adw.PreferencesDialog(title="Параметры")
        dialog.set_search_enabled(False)
        self.dialog = dialog

        # --- Внешний вид
        page = Adw.PreferencesPage(title="Внешний вид", icon_name="applications-graphics-symbolic")
        group = Adw.PreferencesGroup(title="Тема терминала")
        first = None
        for theme in THEMES:
            row = Adw.ActionRow(title=theme.name, activatable=True)
            check = Gtk.CheckButton()
            check.set_valign(Gtk.Align.CENTER)
            if first is None:
                first = check
            else:
                check.set_group(first)
            check.set_active(self.settings["themeID"] == theme.id)
            check.connect("toggled", lambda c, t=theme: c.get_active() and self.settings.set("themeID", t.id))
            row.add_prefix(check)
            row.set_activatable_widget(check)
            row.add_suffix(_theme_preview(theme))
            group.add(row)
        page.add(group)

        group = Adw.PreferencesGroup(title="Текст")
        font_row = Adw.ActionRow(title="Шрифт")
        font_dialog = Gtk.FontDialog(title="Шрифт терминала")
        font_button = Gtk.FontDialogButton(dialog=font_dialog)
        font_button.set_use_font(True)
        font_button.set_valign(Gtk.Align.CENTER)
        desc = Pango.FontDescription.from_string(self.settings["font"] or "Monospace 11")
        if not font_family_available(desc.get_family()):
            desc.set_family("Monospace")
        font_button.set_font_desc(desc)
        font_button.connect("notify::font-desc", self._on_font)
        font_row.add_suffix(font_button)
        group.add(font_row)

        cursor = Adw.ComboRow(title="Курсор", model=string_list([c[1] for c in CURSORS]))
        keys = [c[0] for c in CURSORS]
        cursor.set_selected(keys.index(self.settings["cursorShape"]) if self.settings["cursorShape"] in keys else 0)
        cursor.connect("notify::selected", lambda r, *_: self.settings.set("cursorShape", keys[r.get_selected()]))
        group.add(cursor)
        blink = Adw.SwitchRow(title="Мигающий курсор", active=self.settings["cursorBlink"])
        blink.connect("notify::active", lambda r, *_: self.settings.set("cursorBlink", r.get_active()))
        group.add(blink)
        scheme = Adw.ComboRow(title="Оформление окна", model=string_list([s[1] for s in SCHEMES]))
        skeys = [s[0] for s in SCHEMES]
        scheme.set_selected(skeys.index(self.settings["colorScheme"]) if self.settings["colorScheme"] in skeys else 0)
        scheme.connect("notify::selected", lambda r, *_: self.settings.set("colorScheme", skeys[r.get_selected()]))
        group.add(scheme)
        page.add(group)
        dialog.add(page)

        # --- Поведение
        page = Adw.PreferencesPage(title="Поведение", icon_name="preferences-system-symbolic")
        group = Adw.PreferencesGroup(title="Терминал")
        scroll = spin_row("Строк в истории прокрутки", int(self.settings["scrollback"]), 0, 1_000_000)
        scroll.get_adjustment().set_step_increment(1000)
        scroll.connect("notify::value", lambda r, *_: self.settings.set("scrollback", int(r.get_value())))
        group.add(scroll)
        bell = Adw.SwitchRow(title="Звуковой сигнал", active=self.settings["audibleBell"])
        bell.connect("notify::active", lambda r, *_: self.settings.set("audibleBell", r.get_active()))
        group.add(bell)
        cos = Adw.SwitchRow(title="Копировать при выделении", active=self.settings["copyOnSelect"])
        cos.connect("notify::active", lambda r, *_: self.settings.set("copyOnSelect", r.get_active()))
        group.add(cos)
        page.add(group)
        group = Adw.PreferencesGroup(title="Окно")
        confirm_close = Adw.SwitchRow(title="Спрашивать перед закрытием активных сессий",
                                      active=self.settings["confirmClose"])
        confirm_close.connect("notify::active", lambda r, *_: self.settings.set("confirmClose", r.get_active()))
        group.add(confirm_close)
        local = Adw.SwitchRow(title="Открывать локальный терминал при запуске",
                              active=self.settings["openLocalOnStart"])
        local.connect("notify::active", lambda r, *_: self.settings.set("openLocalOnStart", r.get_active()))
        group.add(local)
        page.add(group)
        group = Adw.PreferencesGroup(title="Хранилище паролей")
        backend = "системное (libsecret)" if self.store.secrets_backend == "libsecret" else "файл ~/.local/share/termuxx/secrets.json"
        group.add(Adw.ActionRow(title="Где лежат пароли и ключи", subtitle=backend))
        page.add(group)
        dialog.add(page)

        # --- Резервная копия
        page = Adw.PreferencesPage(title="Резервная копия", icon_name="document-save-symbolic")
        group = Adw.PreferencesGroup(
            title="Экспорт",
            description="Файл совместим с Termuxx для iPhone: можно перенести серверы в обе стороны.",
        )
        self.include_secrets = Adw.SwitchRow(title="Включить пароли и ключи",
                                             subtitle="Будут зашифрованы паролем (AES-256-GCM)")
        group.add(self.include_secrets)
        self.backup_password = Adw.PasswordEntryRow(title="Пароль резервной копии")
        self.backup_password2 = Adw.PasswordEntryRow(title="Повторите пароль")
        group.add(self.backup_password)
        group.add(self.backup_password2)

        def sync(*_):
            on = self.include_secrets.get_active()
            self.backup_password.set_sensitive(on)
            self.backup_password2.set_sensitive(on)

        self.include_secrets.connect("notify::active", sync)
        sync()
        export_row = Adw.ActionRow(title="Сохранить в файл…", activatable=True)
        export_row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
        export_row.connect("activated", lambda *_: self._export())
        group.add(export_row)
        page.add(group)

        group = Adw.PreferencesGroup(title="Импорт", description="Серверы с теми же ID будут обновлены, новые — добавлены.")
        import_row = Adw.ActionRow(title="Загрузить из файла…", activatable=True)
        import_row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
        import_row.connect("activated", lambda *_: self._import())
        group.add(import_row)
        page.add(group)
        dialog.add(page)

        dialog.present(window)

    @staticmethod
    def _is_monospace(item) -> bool:
        try:
            family = item if isinstance(item, Pango.FontFamily) else item.get_family()
            return family.is_monospace()
        except Exception:
            return True

    def _on_font(self, button, *_):
        desc = button.get_font_desc()
        if desc is not None:
            self.settings.set("font", desc.to_string())

    def _toast(self, text: str) -> None:
        if hasattr(self.window, "toast"):
            self.window.toast(text)
        try:
            self.dialog.add_toast(Adw.Toast(title=text))
        except Exception:
            pass

    def _export(self) -> None:
        include = self.include_secrets.get_active()
        password = self.backup_password.get_text()
        if include:
            if len(password) < 6:
                show_error(self.dialog, "Слишком короткий пароль", "Пароль резервной копии — минимум 6 символов.")
                return
            if password != self.backup_password2.get_text():
                show_error(self.dialog, "Пароли не совпадают", "Введите одинаковый пароль в оба поля.")
                return
        file_dialog = Gtk.FileDialog(title="Сохранить резервную копию",
                                     initial_name=f"termuxx-backup-{date.today().isoformat()}.termuxx")

        def done(dlg, result):
            try:
                f = dlg.save_finish(result)
            except GLib.Error:
                return
            try:
                backup.export_backup(self.store, f.get_path(), include, password if include else None)
            except Exception as e:
                show_error(self.dialog, "Не удалось сохранить", str(e))
                return
            self._toast("Резервная копия сохранена")

        file_dialog.save(self.window, None, done)

    def _import(self) -> None:
        file_dialog = Gtk.FileDialog(title="Открыть резервную копию")
        filters = Gio.ListStore.new(Gtk.FileFilter)
        flt = Gtk.FileFilter(name="Резервные копии Termuxx")
        flt.add_pattern("*.termuxx")
        flt.add_pattern("*.json")
        filters.append(flt)
        all_files = Gtk.FileFilter(name="Все файлы")
        all_files.add_pattern("*")
        filters.append(all_files)
        file_dialog.set_filters(filters)

        def done(dlg, result):
            try:
                f = dlg.open_finish(result)
            except GLib.Error:
                return
            try:
                data = backup.read_backup(f.get_path())
            except backup.BackupError as e:
                show_error(self.dialog, "Не получилось", str(e))
                return
            if backup.has_secrets(data):
                self._ask_backup_password(data)
            else:
                self._finish_import(data, None)

        file_dialog.open(self.window, None, done)

    def _ask_backup_password(self, data: dict) -> None:
        alert = Adw.AlertDialog(heading="Пароль резервной копии",
                                body="В файле есть зашифрованные пароли и ключи.")
        entry = Gtk.PasswordEntry(show_peek_icon=True)
        entry.set_activates_default(True)
        alert.set_extra_child(entry)
        alert.add_response("cancel", "Отмена")
        alert.add_response("skip", "Без паролей")
        alert.add_response("ok", "Импортировать")
        alert.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
        alert.set_default_response("ok")
        alert.set_close_response("cancel")

        def on_response(_a, response):
            if response == "ok":
                self._finish_import(data, entry.get_text())
            elif response == "skip":
                self._finish_import(data, None)

        alert.connect("response", on_response)
        alert.present(self.dialog)

    def _finish_import(self, data: dict, password) -> None:
        try:
            summary = backup.import_backup(self.store, data, password)
        except backup.BackupError as e:
            show_error(self.dialog, "Не получилось", str(e))
            return
        self._toast(summary.text())
