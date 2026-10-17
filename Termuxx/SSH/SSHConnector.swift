import Foundation
import Citadel
import Crypto
import NIO
import NIOSSH

enum TermuxxError: LocalizedError {
    case noPassword
    case noKey
    case badKey
    case hostKeyMismatch(expected: String, got: String)

    var errorDescription: String? {
        switch self {
        case .noPassword:
            return "Не указан пароль."
        case .noKey:
            return "Для этого хоста не выбран SSH-ключ."
        case .badKey:
            return "Не удалось прочитать приватный ключ. Поддерживаются OpenSSH-ключи Ed25519 и RSA без пароля."
        case .hostKeyMismatch(let expected, let got):
            return "Ключ сервера изменился!\nБыло: \(expected)\nСейчас: \(got)\nЕсли вы переустанавливали сервер — сбросьте сохранённый ключ в настройках хоста."
        }
    }
}

/// Проверка ключа сервера по принципу «доверяй при первом подключении» (как known_hosts).
final class TOFUHostKeyValidator: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    private let expected: String?
    private let onFirstSeen: @Sendable (String) -> Void

    init(expected: String?, onFirstSeen: @escaping @Sendable (String) -> Void) {
        self.expected = expected
        self.onFirstSeen = onFirstSeen
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let fingerprint = HostKeyFingerprint.of(hostKey)
        if let expected, expected != fingerprint {
            validationCompletePromise.fail(TermuxxError.hostKeyMismatch(expected: expected, got: fingerprint))
            return
        }
        if expected == nil {
            onFirstSeen(fingerprint)
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

enum SSHConnector {
    @MainActor
    static func connect(_ server: Server, password: String? = nil, store: Store? = nil) async throws -> SSHClient {
        let store = store ?? Store.shared
        let auth = try authentication(for: server, password: password, store: store)
        let knownKey = server.knownHostsKey
        let validator = TOFUHostKeyValidator(expected: store.knownHosts[knownKey]) { fingerprint in
            Task { @MainActor in
                Store.shared.knownHosts[knownKey] = fingerprint
            }
        }
        let client = try await SSHClient.connect(
            host: server.hostname,
            port: server.port,
            authenticationMethod: auth,
            hostKeyValidator: .custom(validator),
            reconnect: .never,
            connectTimeout: .seconds(15)
        )
        store.markConnected(server)
        return client
    }

    @MainActor
    static func authentication(for server: Server, password: String?, store: Store) throws -> SSHAuthenticationMethod {
        switch server.auth {
        case .password:
            guard let pw = password ?? store.password(for: server), !pw.isEmpty else { throw TermuxxError.noPassword }
            return .passwordBased(username: server.username, password: pw)
        case .key:
            guard let id = server.keyID, let pem = store.privateKey(id) else { throw TermuxxError.noKey }
            return try KeyTools.authentication(username: server.username, privateKey: pem)
        }
    }
}

enum KeyTools {
    static func authentication(username: String, privateKey pem: String) throws -> SSHAuthenticationMethod {
        let text = pem.trimmingCharacters(in: .whitespacesAndNewlines)
        if let key = try? Curve25519.Signing.PrivateKey(sshEd25519: text) {
            return .ed25519(username: username, privateKey: key)
        }
        if let key = try? Insecure.RSA.PrivateKey(sshRsa: text) {
            return .rsa(username: username, privateKey: key)
        }
        throw TermuxxError.badKey
    }

    /// Проверяет приватный ключ и возвращает его тип и публичную часть (если её можно получить).
    static func inspect(privateKey pem: String, comment: String) throws -> (type: String, publicKey: String) {
        let text = pem.trimmingCharacters(in: .whitespacesAndNewlines)
        if let key = try? Curve25519.Signing.PrivateKey(sshEd25519: text) {
            return ("ED25519", ed25519PublicString(key.publicKey.rawRepresentation, comment: comment))
        }
        if (try? Insecure.RSA.PrivateKey(sshRsa: text)) != nil {
            return ("RSA", "")
        }
        throw TermuxxError.badKey
    }

    static func generateEd25519(comment: String) -> (privateKey: String, publicKey: String) {
        let key = Curve25519.Signing.PrivateKey()
        let pem = key.makeSSHRepresentation(comment: comment)
        return (pem, ed25519PublicString(key.publicKey.rawRepresentation, comment: comment))
    }

    static func ed25519PublicString(_ raw: Data, comment: String) -> String {
        var blob = Data()
        func append(_ d: Data) {
            var len = UInt32(d.count).bigEndian
            blob.append(Data(bytes: &len, count: 4))
            blob.append(d)
        }
        append(Data("ssh-ed25519".utf8))
        append(raw)
        let base = "ssh-ed25519 " + blob.base64EncodedString()
        return comment.isEmpty ? base : base + " " + comment
    }

    /// Команда, добавляющая публичный ключ в authorized_keys (без дублей).
    static func installCommand(publicKey: String) -> String {
        let escaped = publicKey.replacingOccurrences(of: "'", with: "")
        return "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '\(escaped)' ~/.ssh/authorized_keys || echo '\(escaped)' >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys && echo OK"
    }
}
