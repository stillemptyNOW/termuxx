import Foundation
import SwiftUI

enum AuthMethod: String, Codable, CaseIterable, Identifiable {
    case password
    case key

    var id: String { rawValue }

    var title: String {
        switch self {
        case .password: return "Пароль"
        case .key: return "SSH-ключ"
        }
    }
}

struct Server: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String = ""
    var hostname: String = ""
    var port: Int = 22
    var username: String = "root"
    var auth: AuthMethod = .password
    var keyID: UUID?
    var startupSnippetID: UUID?
    var colorHex: String = HostColor.palette[0]
    var lastConnected: Date?

    var title: String { name.isEmpty ? hostname : name }
    var subtitle: String { "\(username)@\(hostname)" + (port == 22 ? "" : ":\(port)") }
    var knownHostsKey: String { "\(hostname.lowercased()):\(port)" }
    var color: Color { Color(hex: colorHex) }

    /// Парсит строку вида `user@host:port`.
    static func quick(_ raw: String) -> Server? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("ssh ") { text = String(text.dropFirst(4)).trimmingCharacters(in: .whitespaces) }
        guard !text.isEmpty else { return nil }
        var host = Server()
        if let at = text.lastIndex(of: "@") {
            host.username = String(text[..<at])
            text = String(text[text.index(after: at)...])
        }
        if let colon = text.lastIndex(of: ":"), let port = Int(text[text.index(after: colon)...]) {
            host.port = port
            text = String(text[..<colon])
        }
        guard !text.isEmpty else { return nil }
        host.hostname = text
        return host
    }
}

struct SSHKeyItem: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var type: String
    var publicKey: String
    var created = Date()
}

struct Snippet: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String = ""
    var command: String = ""
    var runImmediately: Bool = true
}

enum HostColor {
    static let palette = ["#3DDC97", "#4EA8FF", "#B48CFF", "#FF7AA2", "#FFB454", "#FF5C5C", "#5CE1E6", "#C7D0DA"]
}

extension Color {
    init(hex: String) {
        let c = UIColor(hex: hex)
        self.init(uiColor: c)
    }
}

extension UIColor {
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r = CGFloat((v >> 16) & 0xFF) / 255
        let g = CGFloat((v >> 8) & 0xFF) / 255
        let b = CGFloat(v & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}
