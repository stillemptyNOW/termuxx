"""Темы терминала — те же, что в iOS-версии (Termuxx/Terminal/Themes.swift)."""

from dataclasses import dataclass


@dataclass(frozen=True)
class TerminalTheme:
    id: str
    name: str
    background: str
    foreground: str
    cursor: str
    ansi: tuple  # 16 цветов: 8 обычных + 8 ярких
    light: bool = False


THEMES = [
    TerminalTheme(
        "termuxx", "Termuxx Night", "#0A0E14", "#D5DEE8", "#3DDC97",
        ("#1B222C", "#FF5C6C", "#3DDC97", "#FFC66D", "#4EA8FF", "#B48CFF", "#4FD6E0", "#C7D0DA",
         "#4B5563", "#FF8A96", "#7AF0BC", "#FFDB99", "#85C3FF", "#CFB3FF", "#86EBF2", "#F4F7FA"),
    ),
    TerminalTheme(
        "dracula", "Dracula", "#282A36", "#F8F8F2", "#F8F8F2",
        ("#21222C", "#FF5555", "#50FA7B", "#F1FA8C", "#BD93F9", "#FF79C6", "#8BE9FD", "#F8F8F2",
         "#6272A4", "#FF6E6E", "#69FF94", "#FFFFA5", "#D6ACFF", "#FF92DF", "#A4FFFF", "#FFFFFF"),
    ),
    TerminalTheme(
        "nord", "Nord", "#2E3440", "#D8DEE9", "#88C0D0",
        ("#3B4252", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0",
         "#4C566A", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4"),
    ),
    TerminalTheme(
        "gruvbox", "Gruvbox Dark", "#282828", "#EBDBB2", "#FE8019",
        ("#282828", "#CC241D", "#98971A", "#D79921", "#458588", "#B16286", "#689D6A", "#A89984",
         "#928374", "#FB4934", "#B8BB26", "#FABD2F", "#83A598", "#D3869B", "#8EC07C", "#EBDBB2"),
    ),
    TerminalTheme(
        "solarized", "Solarized Dark", "#002B36", "#839496", "#93A1A1",
        ("#073642", "#DC322F", "#859900", "#B58900", "#268BD2", "#D33682", "#2AA198", "#EEE8D5",
         "#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"),
    ),
    TerminalTheme(
        "paper", "Paper (светлая)", "#FAFAF7", "#1F2328", "#0969DA",
        ("#24292F", "#CF222E", "#116329", "#9A6700", "#0969DA", "#8250DF", "#1B7C83", "#6E7781",
         "#57606A", "#A40E26", "#1A7F37", "#7D4E00", "#218BFF", "#A475F9", "#3192AA", "#8C959F"),
        light=True,
    ),
]


def theme_by_id(theme_id: str) -> TerminalTheme:
    for t in THEMES:
        if t.id == theme_id:
            return t
    return THEMES[0]


def rgba(hex_color: str, alpha: float = 1.0):
    from gi.repository import Gdk

    c = Gdk.RGBA()
    c.parse(hex_color)
    c.alpha = alpha
    return c


def apply_theme(terminal, theme: TerminalTheme) -> None:
    """Применяет тему к Vte.Terminal."""
    terminal.set_colors(rgba(theme.foreground), rgba(theme.background), [rgba(c) for c in theme.ansi])
    terminal.set_color_cursor(rgba(theme.cursor))
    terminal.set_color_cursor_foreground(rgba(theme.background))
    terminal.set_color_bold(None)
    terminal.set_color_highlight(rgba(theme.cursor, 0.35))
    terminal.set_color_highlight_foreground(None)
