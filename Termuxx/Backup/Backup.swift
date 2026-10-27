import Foundation
import Security
import CommonCrypto
import Crypto

// Резервная копия Termuxx: перенос серверов, ключей и сниппетов между устройствами
// (iPhone, iPad, Termuxx для Linux). Формат описан в docs/BACKUP_FORMAT.md,
// эталонная реализация криптографии — scripts/backup_tool.py.

// MARK: - Ошибки

enum BackupError: LocalizedError, Equatable {
    case notABackup
    case unsupportedVersion(Int)
    case passwordRequired
    case wrongPassword
    case corrupted(String)
    case crypto(String)
    case io(String)

    var errorDescription: String? {
        switch self {
        case .notABackup:
            return "Это не файл резервной копии Termuxx."
        case .unsupportedVersion(let version):
            return "Бэкап создан более новой версией Termuxx (формат \(version)). Обновите приложение."
        case .passwordRequired:
            return "Нужен пароль бэкапа, чтобы зашифровать пароли и ключи."
        case .wrongPassword:
            return "Неверный пароль бэкапа."
        case .corrupted(let what):
            return "Файл бэкапа повреждён: \(what)."
        case .crypto(let what):
            return "Ошибка шифрования: \(what)."
        case .io(let what):
            return "Не удалось прочитать или записать файл: \(what)"
        }
    }
}

// MARK: - Криптография

/// PBKDF2-HMAC-SHA256 (200 000 итераций) → ключ AES-256 → AES-256-GCM без AAD.
/// Поле `data` = ciphertext || tag (16 байт), как у Python `AESGCM.encrypt`.
enum BackupCrypto {
    static let kdfName = "pbkdf2-sha256"
    static let cipherName = "aes-256-gcm"
    static let defaultIterations = 200_000
    static let saltLength = 16
    static let nonceLength = 12
    static let tagLength = 16
    static let keyLength = 32

    static func randomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else { throw BackupError.crypto("генератор случайных чисел недоступен") }
        return Data(bytes)
    }

    /// Пароль нормализуется в Unicode NFC и берётся в UTF-8 — так же делает Linux-версия.
    static func deriveKey(password: String, salt: Data, iterations: Int) throws -> SymmetricKey {
        let normalized = password.precomposedStringWithCanonicalMapping
        let passwordLength = normalized.utf8.count
        guard passwordLength > 0 else { throw BackupError.passwordRequired }
        guard !salt.isEmpty else { throw BackupError.corrupted("пустая соль") }
        guard iterations > 0, iterations <= 10_000_000 else { throw BackupError.corrupted("число итераций") }

        let saltBytes = [UInt8](salt)
        let length = keyLength
        var derived = [UInt8](repeating: 0, count: length)
        let status: Int32 = normalized.withCString { cPassword in
            saltBytes.withUnsafeBufferPointer { saltBuffer in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    cPassword,
                    passwordLength,
                    saltBuffer.baseAddress,
                    saltBuffer.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(iterations),
                    &derived,
                    length
                )
            }
        }
        guard status == 0 else { throw BackupError.crypto("PBKDF2, код \(status)") }
        return SymmetricKey(data: derived)
    }

    static func seal(_ plaintext: Data, password: String, iterations: Int = defaultIterations) throws -> BackupSecretsEnvelope {
        let salt = try randomBytes(saltLength)
        let nonceData = try randomBytes(nonceLength)
        let key = try deriveKey(password: password, salt: salt, iterations: iterations)
        let sealed: AES.GCM.SealedBox
        do {
            let nonce = try AES.GCM.Nonce(data: nonceData)
            sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
        } catch {
            throw BackupError.crypto("AES-GCM")
        }
        var combined = Data(sealed.ciphertext)
        combined.append(Data(sealed.tag))
        return BackupSecretsEnvelope(
            kdf: kdfName,
            iterations: iterations,
            salt: salt.base64EncodedString(),
            cipher: cipherName,
            nonce: nonceData.base64EncodedString(),
            data: combined.base64EncodedString()
        )
    }

    static func open(_ envelope: BackupSecretsEnvelope, password: String) throws -> Data {
        guard envelope.kdf.lowercased() == kdfName else {
            throw BackupError.corrupted("неизвестный алгоритм ключа «\(envelope.kdf)»")
        }
        guard envelope.cipher.lowercased() == cipherName else {
            throw BackupError.corrupted("неизвестный шифр «\(envelope.cipher)»")
        }
        guard let salt = Data(base64Encoded: envelope.salt, options: .ignoreUnknownCharacters), !salt.isEmpty,
              let nonceData = Data(base64Encoded: envelope.nonce, options: .ignoreUnknownCharacters),
              nonceData.count == nonceLength,
              let combined = Data(base64Encoded: envelope.data, options: .ignoreUnknownCharacters),
              combined.count >= tagLength
        else {
            throw BackupError.corrupted("секция с паролями и ключами")
        }
        let key = try deriveKey(password: password, salt: salt, iterations: envelope.iterations)
        let ciphertext = Data(combined.prefix(combined.count - tagLength))
        let tag = Data(combined.suffix(tagLength))
        do {
            let nonce = try AES.GCM.Nonce(data: nonceData)
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            return try AES.GCM.open(box, using: key)
        } catch {
            throw BackupError.wrongPassword
        }
    }
}

// MARK: - Формат файла

/// Зашифрованная секция `secrets`.
struct BackupSecretsEnvelope: Codable, Equatable {
    var kdf: String
    var iterations: Int
    var salt: String
    var cipher: String
    var nonce: String
    var data: String
}

/// Расшифрованное содержимое `secrets`. Ключи словарей — ID в верхнем регистре.
struct BackupSecrets: Codable, Equatable {
    var passwords: [String: String] = [:]
    var proxyPasswords: [String: String] = [:]
    var privateKeys: [String: String] = [:]
    var passphrases: [String: String] = [:]

    enum CodingKeys: String, CodingKey {
        case passwords, proxyPasswords, privateKeys, passphrases
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func section(_ key: CodingKeys) -> [String: String] {
            let raw = (try? c.decodeIfPresent([String: String].self, forKey: key)) ?? [:]
            var result: [String: String] = [:]
            for (id, value) in raw {
                result[id.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()] = value
            }
            return result
        }
        passwords = section(.passwords)
        proxyPasswords = section(.proxyPasswords)
        privateKeys = section(.privateKeys)
        passphrases = section(.passphrases)
    }

    var count: Int { passwords.count + proxyPasswords.count + privateKeys.count + passphrases.count }
    var isEmpty: Bool { count == 0 }
}

struct BackupProxy: Codable, Equatable {
    var host: String
    var port: Int
    var username: String

    enum CodingKeys: String, CodingKey { case host, port, username }

    init(proxy: ProxyConfig) {
        host = proxy.host
        port = proxy.port
        username = proxy.username
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = c.lenientString(.host) ?? ""
        port = c.lenientInt(.port) ?? 1080
        username = c.lenientString(.username) ?? ""
    }

    func makeProxy() -> ProxyConfig? {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var proxy = ProxyConfig()
        proxy.host = trimmed
        proxy.port = (1...65535).contains(port) ? port : 1080
        proxy.username = username
        return proxy
    }
}

struct BackupForward: Codable, Equatable {
    var id: String
    var name: String
    var localPort: Int
    var remoteHost: String
    var remotePort: Int
    var autoStart: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, localPort, remoteHost, remotePort, autoStart
    }

    init(forward: PortForward) {
        id = forward.id.uuidString
        name = forward.name
        localPort = forward.localPort
        remoteHost = forward.remoteHost
        remotePort = forward.remotePort
        autoStart = forward.autoStart
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientID(.id) ?? UUID().uuidString
        name = c.lenientString(.name) ?? ""
        localPort = c.lenientInt(.localPort) ?? 0
        remoteHost = c.lenientString(.remoteHost) ?? "127.0.0.1"
        remotePort = c.lenientInt(.remotePort) ?? 0
        autoStart = c.lenientBool(.autoStart) ?? true
    }

    func makeForward() -> PortForward? {
        guard (1...65535).contains(localPort), (1...65535).contains(remotePort) else { return nil }
        var forward = PortForward()
        forward.id = UUID(uuidString: id) ?? UUID()
        forward.name = name
        forward.localPort = localPort
        let host = remoteHost.trimmingCharacters(in: .whitespacesAndNewlines)
        forward.remoteHost = host.isEmpty ? "127.0.0.1" : host
        forward.remotePort = remotePort
        forward.autoStart = autoStart
        return forward
    }
}

struct BackupHost: Codable, Equatable {
    var id: String
    var name: String
    var hostname: String
    var port: Int
    var username: String
    var auth: String
    var keyID: String?
    var startupSnippetID: String?
    var colorHex: String
    var lastConnected: Date?
    var useTmux: Bool
    var autoReconnect: Bool
    var keepAlive: Bool
    var jumpHostID: String?
    var proxy: BackupProxy?
    var forwards: [BackupForward]

    enum CodingKeys: String, CodingKey {
        case id, name, hostname, port, username, auth, keyID, startupSnippetID, colorHex, lastConnected
        case useTmux, autoReconnect, keepAlive, jumpHostID, proxy, forwards
    }

    init(server: Server) {
        id = server.id.uuidString
        name = server.name
        hostname = server.hostname
        port = server.port
        username = server.username
        auth = server.auth.rawValue
        keyID = server.keyID?.uuidString
        startupSnippetID = server.startupSnippetID?.uuidString
        colorHex = server.colorHex
        lastConnected = server.lastConnected
        useTmux = server.useTmux
        autoReconnect = server.autoReconnect
        keepAlive = server.keepAlive
        jumpHostID = server.jumpHostID?.uuidString
        proxy = server.proxy.map(BackupProxy.init(proxy:))
        forwards = server.forwards.map(BackupForward.init(forward:))
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientID(.id) ?? ""
        name = c.lenientString(.name) ?? ""
        hostname = (c.lenientString(.hostname) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        port = c.lenientInt(.port) ?? 22
        username = c.lenientString(.username) ?? "root"
        auth = (c.lenientString(.auth) ?? "password").lowercased()
        keyID = c.lenientID(.keyID)
        startupSnippetID = c.lenientID(.startupSnippetID)
        colorHex = c.lenientString(.colorHex) ?? HostColor.palette[0]
        lastConnected = c.lenientDate(.lastConnected)
        useTmux = c.lenientBool(.useTmux) ?? false
        autoReconnect = c.lenientBool(.autoReconnect) ?? true
        keepAlive = c.lenientBool(.keepAlive) ?? true
        jumpHostID = c.lenientID(.jumpHostID)
        proxy = try? c.decodeIfPresent(BackupProxy.self, forKey: .proxy)
        forwards = (try? c.decodeIfPresent(BackupLossyList<BackupForward>.self, forKey: .forwards))?.items ?? []
    }

    func makeServer() -> Server? {
        guard let uuid = UUID(uuidString: id), !hostname.isEmpty else { return nil }
        var server = Server()
        server.id = uuid
        server.name = name
        server.hostname = hostname
        server.port = (1...65535).contains(port) ? port : 22
        server.username = username.isEmpty ? "root" : username
        server.auth = AuthMethod(rawValue: auth) ?? .password
        server.keyID = keyID.flatMap { UUID(uuidString: $0) }
        server.startupSnippetID = startupSnippetID.flatMap { UUID(uuidString: $0) }
        server.colorHex = colorHex.isEmpty ? HostColor.palette[0] : colorHex
        server.lastConnected = lastConnected
        server.useTmux = useTmux
        server.autoReconnect = autoReconnect
        server.keepAlive = keepAlive
        let jump = jumpHostID.flatMap { UUID(uuidString: $0) }
        server.jumpHostID = jump == uuid ? nil : jump
        server.proxy = proxy?.makeProxy()
        server.forwards = forwards.compactMap { $0.makeForward() }
        return server
    }
}

struct BackupKey: Codable, Equatable {
    var id: String
    var name: String
    var type: String
    var publicKey: String
    var created: Date?
    var encrypted: Bool?

    enum CodingKeys: String, CodingKey { case id, name, type, publicKey, created, encrypted }

    init(item: SSHKeyItem) {
        id = item.id.uuidString
        name = item.name
        type = item.type
        publicKey = item.publicKey
        created = item.created
        encrypted = item.encrypted ?? false
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientID(.id) ?? ""
        name = c.lenientString(.name) ?? ""
        type = c.lenientString(.type) ?? ""
        publicKey = c.lenientString(.publicKey) ?? ""
        created = c.lenientDate(.created)
        encrypted = c.lenientBool(.encrypted)
    }

    func makeKey() -> SSHKeyItem? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        var detectedType = type.uppercased()
        if detectedType.isEmpty {
            detectedType = publicKey.hasPrefix("ssh-rsa") ? "RSA" : "ED25519"
        }
        var item = SSHKeyItem(name: name.isEmpty ? "Импортированный ключ" : name,
                              type: detectedType,
                              publicKey: publicKey)
        item.id = uuid
        item.created = created ?? Date()
        item.encrypted = encrypted
        return item
    }
}

struct BackupSnippet: Codable, Equatable {
    var id: String
    var name: String
    var command: String
    var runImmediately: Bool

    enum CodingKeys: String, CodingKey { case id, name, command, runImmediately }

    init(snippet: Snippet) {
        id = snippet.id.uuidString
        name = snippet.name
        command = snippet.command
        runImmediately = snippet.runImmediately
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientID(.id) ?? ""
        name = c.lenientString(.name) ?? ""
        command = c.lenientString(.command) ?? ""
        runImmediately = c.lenientBool(.runImmediately) ?? true
    }

    func makeSnippet() -> Snippet? {
        guard let uuid = UUID(uuidString: id), !command.isEmpty else { return nil }
        var snippet = Snippet()
        snippet.id = uuid
        snippet.name = name.isEmpty ? String(command.prefix(24)) : name
        snippet.command = command
        snippet.runImmediately = runImmediately
        return snippet
    }
}

/// Корневой объект файла `.termuxx`.
struct BackupFile: Codable {
    var format: String = BackupManager.formatName
    var version: Int = BackupManager.currentVersion
    var app: String = "ios"
    var createdAt: Date?
    var hosts: [BackupHost] = []
    var keys: [BackupKey] = []
    var snippets: [BackupSnippet] = []
    var knownHosts: [String: String] = [:]
    var secrets: BackupSecretsEnvelope?

    enum CodingKeys: String, CodingKey {
        case format, version, app, createdAt, hosts, keys, snippets, knownHosts, secrets
    }

    init() {}

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self),
              let format = c.lenientString(.format), format == BackupManager.formatName
        else {
            throw BackupError.notABackup
        }
        self.format = format
        version = c.lenientInt(.version) ?? 1
        app = c.lenientString(.app) ?? "unknown"
        createdAt = c.lenientDate(.createdAt)
        hosts = (try? c.decodeIfPresent(BackupLossyList<BackupHost>.self, forKey: .hosts))?.items ?? []
        keys = (try? c.decodeIfPresent(BackupLossyList<BackupKey>.self, forKey: .keys))?.items ?? []
        snippets = (try? c.decodeIfPresent(BackupLossyList<BackupSnippet>.self, forKey: .snippets))?.items ?? []
        knownHosts = (try? c.decodeIfPresent([String: String].self, forKey: .knownHosts)) ?? [:]
        if let envelope = try? c.decodeIfPresent(BackupSecretsEnvelope.self, forKey: .secrets) {
            secrets = envelope
        } else if c.contains(.secrets), (try? c.decodeNil(forKey: .secrets)) == false {
            throw BackupError.corrupted("секция с паролями и ключами")
        } else {
            secrets = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(format, forKey: .format)
        try c.encode(version, forKey: .version)
        try c.encode(app, forKey: .app)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encode(hosts, forKey: .hosts)
        try c.encode(keys, forKey: .keys)
        try c.encode(snippets, forKey: .snippets)
        try c.encode(knownHosts, forKey: .knownHosts)
        if let secrets {
            try c.encode(secrets, forKey: .secrets)
        } else {
            try c.encodeNil(forKey: .secrets)
        }
    }
}

/// Массив, в котором битые элементы пропускаются, а не ломают весь файл.
struct BackupLossyList<Element: Decodable>: Decodable {
    var items: [Element] = []

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var result: [Element] = []
        while !container.isAtEnd {
            if (try? container.decodeNil()) == true { continue }
            if let value = try? container.decode(Element.self) {
                result.append(value)
            } else if (try? container.decode(BackupSkip.self)) == nil {
                break
            }
        }
        items = result
    }
}

/// Пустышка, чтобы пропустить элемент массива любого вида.
struct BackupSkip: Decodable {
    init(from decoder: Decoder) throws {}
}

private extension KeyedDecodingContainer {
    func lenientString(_ key: Key) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return String(value) }
        return nil
    }

    func lenientInt(_ key: Key) -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key), value.isFinite, abs(value) < 1_000_000_000 {
            return Int(value)
        }
        if let value = try? decodeIfPresent(String.self, forKey: key) {
            return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    func lenientBool(_ key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value != 0 }
        if let value = try? decodeIfPresent(String.self, forKey: key) {
            return ["true", "1", "yes", "да"].contains(value.lowercased())
        }
        return nil
    }

    func lenientDate(_ key: Key) -> Date? {
        try? decodeIfPresent(Date.self, forKey: key)
    }

    /// ID в верхнем регистре (Swift пишет UUID заглавными, Python — строчными).
    func lenientID(_ key: Key) -> String? {
        guard let raw = lenientString(key)?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return raw.uppercased()
    }
}

// MARK: - Результаты

struct BackupPreview: Equatable {
    var app: String
    var createdAt: Date?
    var version: Int
    var hosts: Int
    var keys: Int
    var snippets: Int
    var knownHosts: Int
    var hasSecrets: Bool

    var sourceTitle: String {
        switch app.lowercased() {
        case "ios": return "iPhone / iPad"
        case "linux": return "Linux"
        case "macos": return "Mac"
        default: return app
        }
    }
}

struct ImportSummary: Equatable {
    var hostsAdded = 0
    var hostsUpdated = 0
    var keysAdded = 0
    var keysUpdated = 0
    var keysWithoutPrivate = 0
    var snippetsAdded = 0
    var snippetsUpdated = 0
    var knownHostsAdded = 0
    var knownHostsConflicts = 0
    var secretsRestored = 0
    var secretsSkipped = false
    var skippedItems = 0

    var isEmpty: Bool {
        hostsAdded + hostsUpdated + keysAdded + keysUpdated + snippetsAdded + snippetsUpdated
            + knownHostsAdded + secretsRestored == 0
    }

    var lines: [String] {
        var result: [String] = []
        if let text = Self.describe(added: hostsAdded, updated: hostsUpdated) {
            result.append("Серверы: \(text)")
        }
        if let text = Self.describe(added: keysAdded, updated: keysUpdated) {
            result.append("Ключи: \(text)")
        }
        if let text = Self.describe(added: snippetsAdded, updated: snippetsUpdated) {
            result.append("Сниппеты: \(text)")
        }
        if knownHostsAdded > 0 {
            result.append("Отпечатки серверов: +\(knownHostsAdded)")
        }
        if secretsRestored > 0 {
            result.append("Пароли и ключи: восстановлено \(secretsRestored)")
        }
        return result
    }

    var warnings: [String] {
        var result: [String] = []
        if isEmpty {
            result.append("Ничего нового — всё уже есть на этом устройстве.")
        }
        if secretsSkipped {
            result.append("Пароли и приватные ключи пропущены — для них нужен пароль бэкапа.")
        }
        if keysWithoutPrivate > 0 {
            let n = keysWithoutPrivate
            result.append("\(n) \(BackupManager.plural(n, "ключ", "ключа", "ключей")) без приватной части — сделайте бэкап с паролями и ключами.")
        }
        if knownHostsConflicts > 0 {
            let n = knownHostsConflicts
            result.append("У \(n) \(BackupManager.plural(n, "сервера", "серверов", "серверов")) другой отпечаток ключа — оставлен текущий.")
        }
        if skippedItems > 0 {
            result.append("Пропущено повреждённых записей: \(skippedItems).")
        }
        return result
    }

    var text: String { (lines + warnings).joined(separator: "\n") }

    private static func describe(added: Int, updated: Int) -> String? {
        var parts: [String] = []
        if added > 0 { parts.append("\(added) \(BackupManager.plural(added, "новый", "новых", "новых"))") }
        if updated > 0 { parts.append("\(updated) \(BackupManager.plural(updated, "обновлён", "обновлено", "обновлено"))") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

/// Проверенный (и при наличии пароля — расшифрованный) бэкап, готовый к применению.
struct PreparedBackup {
    var file: BackupFile
    var secrets: BackupSecrets?
}

// MARK: - Экспорт и импорт

enum BackupManager {
    static let formatName = "termuxx-backup"
    static let currentVersion = 1
    static let fileExtension = "termuxx"
    static let minimumPasswordLength = 8
    static let maxFileSize = 32 * 1024 * 1024

    // MARK: JSON

    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self), let date = BackupManager.parseDate(text) {
                return date
            }
            if let seconds = try? container.decode(Double.self) {
                return Date(timeIntervalSince1970: seconds)
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Неверная дата")
        }
        return decoder
    }

    /// ISO 8601 с секундами или с долями секунды; `Z` или смещение `+03:00`.
    static func parseDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)
    }

    // MARK: Экспорт

    /// Снимок данных приложения (метаданные + секреты, если нужны).
    @MainActor
    static func snapshot(includeSecrets: Bool) -> (file: BackupFile, secrets: BackupSecrets?) {
        let store = Store.shared
        var file = BackupFile()
        file.app = "ios"
        file.createdAt = Date()
        file.hosts = store.hosts.map(BackupHost.init(server:))
        file.keys = store.keys.map(BackupKey.init(item:))
        file.snippets = store.snippets.map(BackupSnippet.init(snippet:))
        file.knownHosts = store.knownHosts

        guard includeSecrets else { return (file, nil) }
        var secrets = BackupSecrets()
        for host in store.hosts {
            let id = host.id.uuidString
            if let password = store.password(for: host), !password.isEmpty {
                secrets.passwords[id] = password
            }
            if let proxyPassword = store.proxyPassword(for: host), !proxyPassword.isEmpty {
                secrets.proxyPasswords[id] = proxyPassword
            }
        }
        for key in store.keys {
            let id = key.id.uuidString
            if let pem = store.privateKey(key.id), !pem.isEmpty {
                secrets.privateKeys[id] = pem
            }
            if let passphrase = store.passphrase(key.id), !passphrase.isEmpty {
                secrets.passphrases[id] = passphrase
            }
        }
        return (file, secrets)
    }

    /// Собирает JSON. Секреты шифруются, если они есть; пустые секреты не пишутся.
    static func encode(_ file: BackupFile, secrets: BackupSecrets?, password: String?) throws -> Data {
        var file = file
        file.secrets = nil
        if let secrets, !secrets.isEmpty {
            guard let password, !password.isEmpty else { throw BackupError.passwordRequired }
            let plaintext = try makeEncoder().encode(secrets)
            file.secrets = try BackupCrypto.seal(plaintext, password: password)
        }
        do {
            return try makeEncoder().encode(file)
        } catch {
            throw BackupError.io(error.localizedDescription)
        }
    }

    /// Пишет бэкап во временную папку: `termuxx-backup-ГГГГ-ММ-ДД.termuxx`.
    static func writeTemporaryFile(_ data: Data, date: Date = Date()) throws -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let name = "termuxx-backup-\(formatter.string(from: date)).\(fileExtension)"
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TermuxxBackup", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: url)
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            throw BackupError.io(error.localizedDescription)
        }
    }

    /// Создаёт файл бэкапа (синхронно, на главном потоке).
    @MainActor
    static func export(includeSecrets: Bool, password: String?) throws -> URL {
        if includeSecrets, (password ?? "").isEmpty { throw BackupError.passwordRequired }
        let snap = BackupManager.snapshot(includeSecrets: includeSecrets)
        let data = try BackupManager.encode(snap.file, secrets: snap.secrets, password: password)
        return try BackupManager.writeTemporaryFile(data)
    }

    /// То же, но шифрование (PBKDF2 ~0.1–0.3 с) идёт в фоне — интерфейс не замирает.
    @MainActor
    static func exportAsync(includeSecrets: Bool, password: String?) async throws -> URL {
        if includeSecrets, (password ?? "").isEmpty { throw BackupError.passwordRequired }
        let snap = BackupManager.snapshot(includeSecrets: includeSecrets)
        let file = snap.file
        let secrets = snap.secrets
        return try await Task.detached(priority: .userInitiated) {
            let data = try BackupManager.encode(file, secrets: secrets, password: password)
            return try BackupManager.writeTemporaryFile(data)
        }.value
    }

    // MARK: Импорт

    /// Читает файл (в том числе выбранный в «Файлах» — с доступом security-scoped).
    static func readData(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw BackupError.io(error.localizedDescription)
        }
        guard !data.isEmpty, data.count <= maxFileSize else { throw BackupError.notABackup }
        return data
    }

    static func decode(_ data: Data) throws -> BackupFile {
        let file: BackupFile
        do {
            file = try makeDecoder().decode(BackupFile.self, from: data)
        } catch let error as BackupError {
            throw error
        } catch {
            throw BackupError.notABackup
        }
        guard file.version <= currentVersion else { throw BackupError.unsupportedVersion(file.version) }
        return file
    }

    static func inspect(data: Data) throws -> BackupPreview {
        let file = try decode(data)
        return BackupPreview(
            app: file.app,
            createdAt: file.createdAt,
            version: file.version,
            hosts: file.hosts.count,
            keys: file.keys.count,
            snippets: file.snippets.count,
            knownHosts: file.knownHosts.count,
            hasSecrets: file.secrets != nil
        )
    }

    static func inspect(url: URL) throws -> BackupPreview {
        try inspect(data: readData(url))
    }

    /// Проверяет файл и расшифровывает секреты. Если пароля нет — секреты пропускаются.
    /// Неверный пароль → `BackupError.wrongPassword` (до каких-либо изменений в приложении).
    static func prepare(_ data: Data, password: String?) throws -> PreparedBackup {
        let file = try decode(data)
        var secrets: BackupSecrets?
        if let envelope = file.secrets, let password, !password.isEmpty {
            let plaintext = try BackupCrypto.open(envelope, password: password)
            do {
                secrets = try makeDecoder().decode(BackupSecrets.self, from: plaintext)
            } catch {
                throw BackupError.corrupted("расшифрованные пароли и ключи")
            }
        }
        return PreparedBackup(file: file, secrets: secrets)
    }

    /// Применяет бэкап: записи с тем же ID обновляются, новые добавляются, ничего не удаляется.
    @MainActor
    static func apply(_ backup: PreparedBackup) -> ImportSummary {
        let store = Store.shared
        var summary = ImportSummary()
        summary.secretsSkipped = backup.file.secrets != nil && backup.secrets == nil
        let secrets = backup.secrets ?? BackupSecrets()

        // Ключи — первыми, чтобы серверы сразу видели свои keyID.
        var keys = store.keys
        for dto in backup.file.keys {
            guard let item = dto.makeKey() else {
                summary.skippedItems += 1
                continue
            }
            if let index = keys.firstIndex(where: { $0.id == item.id }) {
                keys[index] = item
                summary.keysUpdated += 1
            } else {
                keys.append(item)
                summary.keysAdded += 1
            }
            let id = item.id.uuidString
            if let pem = secrets.privateKeys[id], !pem.isEmpty {
                Keychain.set(pem, for: "key.\(item.id)")
                summary.secretsRestored += 1
            } else if Keychain.get("key.\(item.id)") == nil {
                summary.keysWithoutPrivate += 1
            }
            if let passphrase = secrets.passphrases[id], !passphrase.isEmpty {
                Keychain.set(passphrase, for: "keypass.\(item.id)")
                summary.secretsRestored += 1
            }
        }
        store.keys = keys

        var hosts = store.hosts
        for dto in backup.file.hosts {
            guard var server = dto.makeServer() else {
                summary.skippedItems += 1
                continue
            }
            if let index = hosts.firstIndex(where: { $0.id == server.id }) {
                if let local = hosts[index].lastConnected, local > (server.lastConnected ?? .distantPast) {
                    server.lastConnected = local
                }
                hosts[index] = server
                summary.hostsUpdated += 1
            } else {
                hosts.append(server)
                summary.hostsAdded += 1
            }
            let id = server.id.uuidString
            if let password = secrets.passwords[id], !password.isEmpty {
                Keychain.set(password, for: "pw.\(server.id)")
                summary.secretsRestored += 1
            }
            if let proxyPassword = secrets.proxyPasswords[id], !proxyPassword.isEmpty {
                Keychain.set(proxyPassword, for: "proxy.\(server.id)")
                summary.secretsRestored += 1
            }
        }
        store.hosts = hosts

        var snippets = store.snippets
        for dto in backup.file.snippets {
            guard let snippet = dto.makeSnippet() else {
                summary.skippedItems += 1
                continue
            }
            if let index = snippets.firstIndex(where: { $0.id == snippet.id }) {
                snippets[index] = snippet
                summary.snippetsUpdated += 1
            } else {
                snippets.append(snippet)
                summary.snippetsAdded += 1
            }
        }
        store.snippets = snippets

        // Отпечатки: проверенные на этом устройстве не перезаписываем.
        var known = store.knownHosts
        for (rawKey, fingerprint) in backup.file.knownHosts {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !key.isEmpty, !fingerprint.isEmpty else { continue }
            if let existing = known[key] {
                if existing != fingerprint { summary.knownHostsConflicts += 1 }
            } else {
                known[key] = fingerprint
                summary.knownHostsAdded += 1
            }
        }
        store.knownHosts = known

        return summary
    }

    @MainActor
    static func importBackup(url: URL, password: String?) throws -> ImportSummary {
        let data = try readData(url)
        return apply(try prepare(data, password: password))
    }

    @MainActor
    static func importBackup(data: Data, password: String?) throws -> ImportSummary {
        apply(try prepare(data, password: password))
    }

    /// Расшифровка в фоне, применение — на главном потоке.
    @MainActor
    static func importBackupAsync(data: Data, password: String?) async throws -> ImportSummary {
        let prepared = try await Task.detached(priority: .userInitiated) {
            try BackupManager.prepare(data, password: password)
        }.value
        return apply(prepared)
    }

    // MARK: Русские окончания

    /// 1 сервер, 2 сервера, 5 серверов.
    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let n10 = abs(n) % 10
        let n100 = abs(n) % 100
        if n10 == 1 && n100 != 11 { return one }
        if (2...4).contains(n10) && !(12...14).contains(n100) { return few }
        return many
    }
}
