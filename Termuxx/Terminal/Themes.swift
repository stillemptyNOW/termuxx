import UIKit
import SwiftTerm

struct TerminalTheme: Identifiable, Hashable {
    let id: String
    let name: String
    let background: String
    let foreground: String
    let cursor: String
    /// 16 ANSI-цветов: 8 обычных + 8 ярких.
    let ansi: [String]

    var uiBackground: UIColor { UIColor(hex: background) }
    var uiForeground: UIColor { UIColor(hex: foreground) }
    var uiCursor: UIColor { UIColor(hex: cursor) }

    var swiftTermColors: [SwiftTerm.Color] {
        ansi.map { hex in
            let c = UIColor(hex: hex)
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            c.getRed(&r, green: &g, blue: &b, alpha: &a)
            return SwiftTerm.Color(red: UInt16(r * 65535), green: UInt16(g * 65535), blue: UInt16(b * 65535))
        }
    }

    static func by(id: String) -> TerminalTheme {
        all.first { $0.id == id } ?? all[0]
    }

    static let all: [TerminalTheme] = [
        TerminalTheme(
            id: "termuxx", name: "Termuxx Night",
            background: "#0A0E14", foreground: "#D5DEE8", cursor: "#3DDC97",
            ansi: ["#1B222C", "#FF5C6C", "#3DDC97", "#FFC66D", "#4EA8FF", "#B48CFF", "#4FD6E0", "#C7D0DA",
                   "#4B5563", "#FF8A96", "#7AF0BC", "#FFDB99", "#85C3FF", "#CFB3FF", "#86EBF2", "#F4F7FA"]
        ),
        TerminalTheme(
            id: "dracula", name: "Dracula",
            background: "#282A36", foreground: "#F8F8F2", cursor: "#F8F8F2",
            ansi: ["#21222C", "#FF5555", "#50FA7B", "#F1FA8C", "#BD93F9", "#FF79C6", "#8BE9FD", "#F8F8F2",
                   "#6272A4", "#FF6E6E", "#69FF94", "#FFFFA5", "#D6ACFF", "#FF92DF", "#A4FFFF", "#FFFFFF"]
        ),
        TerminalTheme(
            id: "nord", name: "Nord",
            background: "#2E3440", foreground: "#D8DEE9", cursor: "#88C0D0",
            ansi: ["#3B4252", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0",
                   "#4C566A", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4"]
        ),
        TerminalTheme(
            id: "gruvbox", name: "Gruvbox Dark",
            background: "#282828", foreground: "#EBDBB2", cursor: "#FE8019",
            ansi: ["#282828", "#CC241D", "#98971A", "#D79921", "#458588", "#B16286", "#689D6A", "#A89984",
                   "#928374", "#FB4934", "#B8BB26", "#FABD2F", "#83A598", "#D3869B", "#8EC07C", "#EBDBB2"]
        ),
        TerminalTheme(
            id: "solarized", name: "Solarized Dark",
            background: "#002B36", foreground: "#839496", cursor: "#93A1A1",
            ansi: ["#073642", "#DC322F", "#859900", "#B58900", "#268BD2", "#D33682", "#2AA198", "#EEE8D5",
                   "#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"]
        ),
        TerminalTheme(
            id: "paper", name: "Paper (светлая)",
            background: "#FAFAF7", foreground: "#1F2328", cursor: "#0969DA",
            ansi: ["#24292F", "#CF222E", "#116329", "#9A6700", "#0969DA", "#8250DF", "#1B7C83", "#6E7781",
                   "#57606A", "#A40E26", "#1A7F37", "#7D4E00", "#218BFF", "#A475F9", "#3192AA", "#8C959F"]
        ),
    ]
}
