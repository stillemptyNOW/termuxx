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
    // v1.1
    var useTmux: Bool = false
    var autoReconnect: Bool = true
    var keepAlive: Bool = true
    var jumpHostID: UUID?
    var proxy: ProxyConfig?
    var forwards: [PortForward] = []

    init() {}

    enum CodingKeys: String, CodingKey {
        case id, name, hostname, port, username, auth, keyID, startupSnippetID, colorHex, lastConnected
        case useTmux, autoReconnect, keepAlive, jumpHostID, proxy, forwards
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        hostname = try c.decodeIfPresent(String.self, forKey: .hostname) ?? ""
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? 22
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? "root"
        auth = try c.decodeIfPresent(AuthMethod.self, forKey: .auth) ?? .password
        keyID = try c.decodeIfPresent(UUID.self, forKey: .keyID)
        startupSnippetID = try c.decodeIfPresent(UUID.self, forKey: .startupSnippetID)
        colorHex = try c.decodeIfPresent(String.self, forKey: .colorHex) ?? HostColor.palette[0]
        lastConnected = try c.decodeIfPresent(Date.self, forKey: .lastConnected)
        useTmux = try c.decodeIfPresent(Bool.self, forKey: .useTmux) ?? false
        autoReconnect = try c.decodeIfPresent(Bool.self, forKey: .autoReconnect) ?? true
        keepAlive = try c.decodeIfPresent(Bool.self, forKey: .keepAlive) ?? true
        jumpHostID = try c.decodeIfPresent(UUID.self, forKey: .jumpHostID)
        proxy = try c.decodeIfPresent(ProxyConfig.self, forKey: .proxy)
        forwards = try c.decodeIfPresent([PortForward].self, forKey: .forwards) ?? []
    }

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
    var encrypted: Bool? = nil
}

/// SOCKS5-прокси, через который идёт TCP-подключение к серверу.
struct ProxyConfig: Codable, Hashable {
    var host: String = ""
    var port: Int = 1080
    var username: String = ""
}

/// Локальный проброс порта: 127.0.0.1:localPort на телефоне → remoteHost:remotePort со стороны сервера.
struct PortForward: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String = ""
    var localPort: Int = 8080
    var remoteHost: String = "127.0.0.1"
    var remotePort: Int = 80
    var autoStart: Bool = true

    var title: String { name.isEmpty ? "localhost:\(localPort) → \(remoteHost):\(remotePort)" : name }
    var localURL: URL? { URL(string: "http://127.0.0.1:\(localPort)") }
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
