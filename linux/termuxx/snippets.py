"""Сниппеты: частые команды, которые отправляются в терминал одним нажатием."""

from __future__ import annotations

from typing import Callable, Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, GLib, Gtk  # noqa: E402

from termuxx.dialogs import confirm, entry_row, toolbar_dialog  # noqa: E402
from termuxx.store import Snippet, Store  # noqa: E402


class SnippetEditor:
    def __init__(self, parent: Gtk.Widget, snippet: Optional[Snippet] = None):
        self.store = Store.get()
        self.snippet = Snippet.from_json(snippet.to_json()) if snippet else Snippet()
        page = Adw.PreferencesPage()
        group = Adw.PreferencesGroup()
        self.name = entry_row("Название", self.snippet.name)
        group.add(self.name)
        self.run = Adw.SwitchRow(title="Сразу выполнять (Enter)", active=self.snippet.run_immediately)
        group.add(self.run)
        page.add(group)

        group = Adw.PreferencesGroup(title="Команда", description="Можно несколько строк — они отправятся как есть.")
        self.buffer = Gtk.TextBuffer()
        self.buffer.set_text(self.snippet.command)
        view = Gtk.TextView(buffer=self.buffer, monospace=True, wrap_mode=Gtk.WrapMode.WORD_CHAR)
        view.set_top_margin(10)
        view.set_bottom_margin(10)
        view.set_left_margin(10)
        view.set_right_margin(10)
        frame = Gtk.Frame(child=view)
        frame.set_size_request(-1, 160)
        frame.add_css_class("card")
        group.add(frame)
        page.add(group)

        def save() -> bool:
            command = self.buffer.get_text(self.buffer.get_start_iter(), self.buffer.get_end_iter(), False)
            if not command.strip():
                return False
            self.snippet.command = command
            self.snippet.name = self.name.get_text().strip() or command.strip().splitlines()[0][:24]
            self.snippet.run_immediately = self.run.get_active()
            self.store.upsert_snippet(self.snippet)
            return True

        self.dialog = toolbar_dialog("Новый сниппет" if snippet is None else "Сниппет", page, save,
                                     width=520, height=480)
        self.dialog.present(parent)


class SnippetsDialog:
    def __init__(self, window, send: Callable[[str], bool]):
        self.window = window
        self.store = Store.get()
        self.send = send
        self.page = Adw.PreferencesPage()
        self.group = Adw.PreferencesGroup(title="Сниппеты",
                                          description="Отправляются в текущий терминал. Можно задать команду при входе в настройках сервера.")
        add = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="Новый сниппет")
        add.add_css_class("flat")
        add.connect("clicked", lambda *_: SnippetEditor(self.dialog))
        self.group.set_header_suffix(add)
        self.page.add(self.group)
        self.rows: list[Gtk.Widget] = []
        self.dialog = toolbar_dialog("Сниппеты", self.page, None, width=600, height=560)
        self._render()
        self.store.subscribe(self._render)
        self.dialog.connect("closed", lambda *_: self.store.unsubscribe(self._render))
        self.dialog.present(window)

    def _render(self) -> None:
        for r in self.rows:
            self.group.remove(r)
        self.rows = []
        if not self.store.snippets:
            row = Adw.ActionRow(title="Нет сниппетов", subtitle="Нажмите «+», чтобы добавить команду")
            self.group.add(row)
            self.rows.append(row)
            return
        for sn in self.store.snippets:
            row = Adw.ActionRow(title=GLib.markup_escape_text(sn.name),
                                subtitle=GLib.markup_escape_text(sn.command.replace("\n", " ⏎ ")))
            row.set_subtitle_lines(2)
            row.add_css_class("snippet-row")
            send = Gtk.Button(icon_name="mail-send-symbolic", tooltip_text="Отправить в терминал")
            send.set_valign(Gtk.Align.CENTER)
            send.add_css_class("flat")
            send.connect("clicked", lambda _b, s=sn: self._send(s))
            edit = Gtk.Button(icon_name="document-edit-symbolic", tooltip_text="Изменить")
            edit.set_valign(Gtk.Align.CENTER)
            edit.add_css_class("flat")
            edit.connect("clicked", lambda _b, s=sn: SnippetEditor(self.dialog, s))
            delete = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Удалить")
            delete.set_valign(Gtk.Align.CENTER)
            delete.add_css_class("flat")
            delete.connect("clicked", lambda _b, s=sn: confirm(self.dialog, "Удалить сниппет?", s.name, "Удалить",
                                                               lambda: self.store.delete_snippet(s)))
            row.add_suffix(send)
            row.add_suffix(edit)
            row.add_suffix(delete)
            self.group.add(row)
            self.rows.append(row)

    def _send(self, snippet: Snippet) -> None:
        text = snippet.command + ("\n" if snippet.run_immediately else "")
        if self.send(text):
            self.dialog.close()
