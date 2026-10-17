import Foundation
import SwiftUI

/// Хранилище хостов, ключей и сниппетов. Метаданные — в JSON, секреты — в Keychain.
@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    @Published var hosts: [Server] = [] { didSet { save() } }
    @Published var keys: [SSHKeyItem] = [] { didSet { save() } }
    @Published var snippets: [Snippet] = [] { didSet { save() } }
    @Published var knownHosts: [String: String] = [:] { didSet { save() } }

    private var isLoading = false

    private struct Payload: Codable {
        var hosts: [Server]
        var keys: [SSHKeyItem]
        var snippets: [Snippet]
        var knownHosts: [String: String]
    }

    private var fileURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("termuxx.json")
    }

    init() {
        load()
    }

    private func load() {
        isLoading = true
        defer { isLoading = false }
        guard let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            snippets = Store.defaultSnippets
            return
        }
        hosts = payload.hosts
        keys = payload.keys
        snippets = payload.snippets
        knownHosts = payload.knownHosts
    }

    private func save() {
        guard !isLoading else { return }
        let payload = Payload(hosts: hosts, keys: keys, snippets: snippets, knownHosts: knownHosts)
        guard let data = try? JSONEncoder().encode(payload) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: Hosts

    func upsert(_ host: Server) {
        if let i = hosts.firstIndex(where: { $0.id == host.id }) {
            hosts[i] = host
        } else {
            hosts.append(host)
        }
    }

    func delete(_ host: Server) {
        hosts.removeAll { $0.id == host.id }
        Keychain.delete("pw.\(host.id)")
    }

    func markConnected(_ host: Server) {
        guard let i = hosts.firstIndex(where: { $0.id == host.id }) else { return }
        hosts[i].lastConnected = Date()
    }

    func password(for host: Server) -> String? { Keychain.get("pw.\(host.id)") }
    func setPassword(_ password: String?, for host: Server) { Keychain.set(password, for: "pw.\(host.id)") }

    // MARK: Keys

    func privateKey(_ id: UUID) -> String? { Keychain.get("key.\(id)") }

    func addKey(_ item: SSHKeyItem, privateKey: String) {
        Keychain.set(privateKey, for: "key.\(item.id)")
        keys.append(item)
    }

    func deleteKey(_ item: SSHKeyItem) {
        Keychain.delete("key.\(item.id)")
        keys.removeAll { $0.id == item.id }
        for i in hosts.indices where hosts[i].keyID == item.id {
            hosts[i].keyID = nil
        }
    }

    func key(_ id: UUID?) -> SSHKeyItem? { keys.first { $0.id == id } }

    // MARK: Snippets

    func snippet(_ id: UUID?) -> Snippet? { snippets.first { $0.id == id } }

    func upsert(_ snippet: Snippet) {
        if let i = snippets.firstIndex(where: { $0.id == snippet.id }) {
            snippets[i] = snippet
        } else {
            snippets.append(snippet)
        }
    }

    static let defaultSnippets: [Snippet] = [
        Snippet(name: "Нагрузка", command: "htop || top", runImmediately: true),
        Snippet(name: "Место на диске", command: "df -h", runImmediately: true),
        Snippet(name: "Память", command: "free -h", runImmediately: true),
        Snippet(name: "Обновить систему", command: "apt update && apt upgrade -y", runImmediately: false),
        Snippet(name: "Сервисы с ошибками", command: "systemctl --failed", runImmediately: true),
        Snippet(name: "Открытые порты", command: "ss -tulpn", runImmediately: true),
    ]
}
