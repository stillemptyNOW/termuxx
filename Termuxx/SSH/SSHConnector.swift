import Foundation
import Citadel
import Crypto
import NIO
import NIOSSH

enum TermuxxError: LocalizedError {
    case noPassword(String)
    case noKey
    case badKey
    case wrongPassphrase
    case hostKeyMismatch(expected: String, got: String)
    case unknownHostKey(HostKeyRequest)
    case jumpHostMissing

    var errorDescription: String? {
        switch self {
        case .noPassword(let name):
            return "Не указан пароль для \(name)."
        case .noKey:
            return "Для этого сервера не выбран SSH-ключ."
        case .badKey:
            return "Не удалось прочитать приватный ключ. Поддерживаются OpenSSH-ключи Ed25519 и RSA."
        case .wrongPassphrase:
            return "Неверный пароль от ключа."
        case .hostKeyMismatch(let expected, let got):
            return "Ключ сервера изменился!\nБыло: \(expected)\nСейчас: \(got)\nЕсли вы переустанавливали сервер — сбросьте сохранённый ключ в настройках сервера."
        case .unknownHostKey(let request):
            return "Новый сервер \(request.hostLabel). Проверьте отпечаток ключа и подтвердите подключение."
        case .jumpHostMissing:
            return "Промежуточный сервер не найден. Выберите его заново в настройках."
        }
    }
}

/// Запрос на доверие новому ключу сервера.
struct HostKeyRequest: Identifiable, Equatable {
    var id: String { knownHostsKey + fingerprint }
    let knownHostsKey: String
    let hostLabel: String
    let fingerprint: String

    @MainActor
    func trust() {
        Store.shared.knownHosts[knownHostsKey] = fingerprint
    }
}

extension Error {
    var hostKeyRequest: HostKeyRequest? {
        if case TermuxxError.unknownHostKey(let r) = self { return r }
        return nil
    }
}

/// Проверка ключа сервера как в known_hosts: неизвестный ключ требует подтверждения, изменившийся — блокируется.
final class HostKeyValidator: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    private let knownHostsKey: String
    private let hostLabel: String
    private let expected: String?
    private(set) var failure: Error?

    init(knownHostsKey: String, hostLabel: String, expected: String?) {
        self.knownHostsKey = knownHostsKey
        self.hostLabel = hostLabel
        self.expected = expected
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let fingerprint = HostKeyFingerprint.of(hostKey)
        guard let expected else {
            let error = TermuxxError.unknownHostKey(HostKeyRequest(knownHostsKey: knownHostsKey, hostLabel: hostLabel, fingerprint: fingerprint))
            failure = error
            validationCompletePromise.fail(error)
            return
        }
        if expected != fingerprint {
            let error = TermuxxError.hostKeyMismatch(expected: expected, got: fingerprint)
            failure = error
            validationCompletePromise.fail(error)
            return
        }
        validationCompletePromise.succeed(())
    }
}

enum HostKeyFingerprint {
    static func of(_ key: NIOSSHPublicKey) -> String {
        let openSSH = String(openSSHPublicKey: key)
        let parts = openSSH.split(separator: " ")
        guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return openSSH }
        let digest = SHA256.hash(data: blob)
        let b64 = Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
        return "\(parts[0]) SHA256:\(b64)"
    }
}

/// Живое SSH-подключение (и, если был, промежуточный сервер).
final class SSHConnection: @unchecked Sendable {
    let client: SSHClient
    let jump: SSHConnection?

    init(client: SSHClient, jump: SSHConnection?) {
        self.client = client
        self.jump = jump
    }

    var isConnected: Bool { client.isConnected }

    func close() async {
        try? await client.close()
        await jump?.close()
    }
}

enum SSHConnector {
    @MainActor
    static func connect(_ server: Server, password: String? = nil, isJump: Bool = false) async throws -> SSHConnection {
        let store = Store.shared
        let authFactory = try authentication(for: server, password: password, store: store)
        let validator = HostKeyValidator(
            knownHostsKey: server.knownHostsKey,
            hostLabel: server.subtitle,
            expected: store.knownHosts[server.knownHostsKey]
        )
        var settings = SSHClientSettings(
            host: server.hostname,
            port: server.port,
            authenticationMethod: authFactory,
            hostKeyValidator: .custom(validator)
        )
        settings.connectTimeout = .seconds(15)

        // Подключение через промежуточный сервер (jump host).
        if !isJump, let jumpID = server.jumpHostID {
            guard let jumpServer = store.host(jumpID), jumpServer.id != server.id else { throw TermuxxError.jumpHostMissing }
            let jump = try await connect(jumpServer, password: nil, isJump: true)
            do {
                let client = try await jump.client.jump(to: settings)
                store.markConnected(server)
                return SSHConnection(client: client, jump: jump)
            } catch {
                await jump.close()
                throw validator.failure ?? error
            }
        }

        let channel = try await TCPConnector.connect(
            host: server.hostname,
            port: server.port,
            proxy: server.proxy,
            proxyPassword: server.proxy == nil ? nil : store.proxyPassword(for: server),
            keepAlive: server.keepAlive
        )
        do {
            let client = try await SSHClient.connect(on: channel, settings: settings)
            store.markConnected(server)
            return SSHConnection(client: client, jump: nil)
        } catch {
            try? await channel.close()
            throw validator.failure ?? error
        }
    }

    @MainActor
    static func authentication(for server: Server, password: String?, store: Store) throws -> @Sendable () -> SSHAuthenticationMethod {
        let username = server.username
        switch server.auth {
        case .password:
            guard let pw = password ?? store.password(for: server), !pw.isEmpty else {
                throw TermuxxError.noPassword(server.title)
            }
            return { .passwordBased(username: username, password: pw) }
        case .key:
            guard let id = server.keyID, let pem = store.privateKey(id) else { throw TermuxxError.noKey }
            let passphrase = store.passphrase(id)
            let key = try KeyTools.parse(pem, passphrase: passphrase)
            return { key.authentication(username: username) }
        }
    }
}

/// Разобранный приватный ключ.
enum ParsedKey: @unchecked Sendable {
    case ed25519(Curve25519.Signing.PrivateKey)
    case rsa(Insecure.RSA.PrivateKey)

    func authentication(username: String) -> SSHAuthenticationMethod {
        switch self {
        case .ed25519(let k): return .ed25519(username: username, privateKey: k)
        case .rsa(let k): return .rsa(username: username, privateKey: k)
        }
    }
}

enum KeyTools {
    static func isEncrypted(_ pem: String) -> Bool {
        let text = pem.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-----BEGIN OPENSSH PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "-----END OPENSSH PRIVATE KEY-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines).joined()
        guard let data = Data(base64Encoded: text) else { return false }
        // После "openssh-key-v1\0" идёт строка с именем шифра; "none" — без пароля.
        let header = Data("openssh-key-v1".utf8) + Data([0])
        guard data.count > header.count + 8, data.prefix(header.count) == header else { return false }
        let lenBytes = data.subdata(in: header.count..<(header.count + 4))
        let len = lenBytes.reduce(0) { ($0 << 8) | Int($1) }
        let start = header.count + 4
        guard len > 0, data.count >= start + len else { return false }
        let cipher = String(data: data.subdata(in: start..<(start + len)), encoding: .utf8) ?? "none"
        return cipher != "none"
    }

    static func parse(_ pem: String, passphrase: String?) throws -> ParsedKey {
        let text = pem.trimmingCharacters(in: .whitespacesAndNewlines)
        let decryptionKey = passphrase.flatMap { $0.isEmpty ? nil : Data($0.utf8) }
        if let key = try? Curve25519.Signing.PrivateKey(sshEd25519: text, decryptionKey: decryptionKey) {
            return .ed25519(key)
        }
        if let key = try? Insecure.RSA.PrivateKey(sshRsa: text, decryptionKey: decryptionKey) {
            return .rsa(key)
        }
        if isEncrypted(text) { throw TermuxxError.wrongPassphrase }
        throw TermuxxError.badKey
    }

    /// Проверяет приватный ключ и возвращает его тип и публичную часть.
    static func inspect(privateKey pem: String, passphrase: String?, comment: String) throws -> (type: String, publicKey: String) {
        switch try parse(pem, passphrase: passphrase) {
        case .ed25519(let key):
            return ("ED25519", ed25519PublicString(key.publicKey.rawRepresentation, comment: comment))
        case .rsa(let key):
            var body = ByteBuffer()
            _ = key.publicKey.write(to: &body)
            var blob = Data()
            appendSSHString(Data("ssh-rsa".utf8), to: &blob)
            blob.append(Data(body.readableBytesView))
            let base = "ssh-rsa " + blob.base64EncodedString()
            return ("RSA", comment.isEmpty ? base : base + " " + comment)
        }
    }

    static func generateEd25519(comment: String) -> (privateKey: String, publicKey: String) {
        let key = Curve25519.Signing.PrivateKey()
        let pem = key.makeSSHRepresentation(comment: comment)
        return (pem, ed25519PublicString(key.publicKey.rawRepresentation, comment: comment))
    }

    private static func appendSSHString(_ d: Data, to blob: inout Data) {
        var len = UInt32(d.count).bigEndian
        blob.append(Data(bytes: &len, count: 4))
        blob.append(d)
    }

    static func ed25519PublicString(_ raw: Data, comment: String) -> String {
        var blob = Data()
        appendSSHString(Data("ssh-ed25519".utf8), to: &blob)
        appendSSHString(raw, to: &blob)
        let base = "ssh-ed25519 " + blob.base64EncodedString()
        return comment.isEmpty ? base : base + " " + comment
    }

    /// Команда, добавляющая публичный ключ в authorized_keys (без дублей).
    static func installCommand(publicKey: String) -> String {
        let escaped = publicKey.replacingOccurrences(of: "'", with: "")
        return "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '\(escaped)' ~/.ssh/authorized_keys || echo '\(escaped)' >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys && echo OK"
    }
}
