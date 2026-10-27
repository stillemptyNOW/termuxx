import Foundation
import Citadel
import NIO
import NIOSSH

/// Работающий туннель (локальный проброс порта).
struct ActiveTunnel: Identifiable {
    var id: UUID { forward.id }
    let forward: PortForward
    let sessionID: UUID
    let serverTitle: String
    let startedAt: Date
}

enum TunnelError: LocalizedError {
    case notConnected
    case portInUse(Int)
    case permissionDenied(Int)
    case badPort(Int)
    case unsupportedEventLoop
    case other(Int, String)

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Сессия не подключена — туннель запустится после подключения."
        case .portInUse(let port):
            return "Порт \(port) на iPhone уже занят. Выберите другой локальный порт."
        case .permissionDenied(let port):
            return "iOS не разрешает занять порт \(port). Используйте порт выше 1024."
        case .badPort(let port):
            return "Неверный порт: \(port). Допустимо 1–65535."
        case .unsupportedEventLoop:
            return "Не удалось открыть порт для этого соединения."
        case .other(let port, let text):
            return "Порт \(port): \(text)"
        }
    }
}

/// Потокобезопасный учёт соединений одного туннеля (вызывается из event loop).
final class TunnelConnections: @unchecked Sendable {
    private let lock = NSLock()
    private var channels: [ObjectIdentifier: Channel] = [:]

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return channels.count
    }

    func add(_ channel: Channel) {
        lock.lock(); defer { lock.unlock() }
        channels[ObjectIdentifier(channel)] = channel
    }

    func remove(_ channel: Channel) {
        lock.lock(); defer { lock.unlock() }
        channels.removeValue(forKey: ObjectIdentifier(channel))
    }

    func closeAll() {
        lock.lock()
        let all = Array(channels.values)
        channels.removeAll()
        lock.unlock()
        for channel in all { channel.close(promise: nil) }
    }
}

/// Управляет локальными пробросами портов: 127.0.0.1:localPort на устройстве → remoteHost:remotePort со стороны сервера.
@MainActor
final class TunnelManager: ObservableObject {
    static let shared = TunnelManager()

    @Published private(set) var active: [ActiveTunnel] = []
    @Published var lastError: String?

    private var listeners: [UUID: Channel] = [:]
    private var connections: [UUID: TunnelConnections] = [:]
    private var starting: Set<UUID> = []

    func isActive(_ forwardID: UUID) -> Bool {
        listeners[forwardID] != nil
    }

    func isStarting(_ forwardID: UUID) -> Bool {
        starting.contains(forwardID)
    }

    /// Сколько клиентов сейчас подключено через туннель.
    func connectionCount(_ forwardID: UUID) -> Int {
        connections[forwardID]?.count ?? 0
    }

    func tunnels(for sessionID: UUID) -> [ActiveTunnel] {
        active.filter { $0.sessionID == sessionID }
    }

    /// Запускает все туннели сервера с флагом «Запускать автоматически».
    func startAuto(for session: TerminalSession) async {
        let server = Store.shared.host(session.server.id) ?? session.server
        for forward in server.forwards where forward.autoStart {
            await start(forward, session: session, reportErrors: true)
        }
    }

    func start(_ forward: PortForward, session: TerminalSession) async {
        await start(forward, session: session, reportErrors: true)
    }

    private func start(_ forward: PortForward, session: TerminalSession, reportErrors: Bool) async {
        guard listeners[forward.id] == nil, !starting.contains(forward.id) else { return }
        guard (1...65535).contains(forward.localPort), (1...65535).contains(forward.remotePort) else {
            if reportErrors { lastError = TunnelError.badPort(forward.localPort).errorDescription }
            return
        }
        if let clash = active.first(where: { $0.forward.localPort == forward.localPort }) {
            if reportErrors {
                lastError = "Порт \(forward.localPort) уже используется туннелем «\(clash.forward.title)»."
            }
            return
        }
        guard let connection = session.connection, connection.isConnected else {
            if reportErrors { lastError = TunnelError.notConnected.errorDescription }
            return
        }

        starting.insert(forward.id)
        defer { starting.remove(forward.id) }

        let tracker = TunnelConnections()
        do {
            let listener = try await TunnelBinder.bind(forward, client: connection.client, tracker: tracker)
            // Пока мы ждали, сессию могли закрыть.
            guard session.connection === connection, connection.isConnected else {
                listener.close(promise: nil)
                tracker.closeAll()
                return
            }
            listeners[forward.id] = listener
            connections[forward.id] = tracker
            active.append(ActiveTunnel(
                forward: forward,
                sessionID: session.id,
                serverTitle: session.server.title,
                startedAt: Date()
            ))
            let forwardID = forward.id
            let listenerID = ObjectIdentifier(listener)
            listener.closeFuture.whenComplete { [weak self] _ in
                Task { @MainActor in
                    self?.listenerClosed(forwardID, listenerID: listenerID)
                }
            }
        } catch {
            if reportErrors { lastError = TunnelBinder.describe(error, port: forward.localPort) }
        }
    }

    func stop(_ forwardID: UUID) {
        if let listener = listeners.removeValue(forKey: forwardID) {
            listener.close(promise: nil)
        }
        connections.removeValue(forKey: forwardID)?.closeAll()
        active.removeAll { $0.forward.id == forwardID }
    }

    func stopAll(sessionID: UUID) {
        let ids = active.filter { $0.sessionID == sessionID }.map(\.forward.id)
        ids.forEach(stop)
    }

    func stopEverything() {
        Array(listeners.keys).forEach(stop)
    }

    /// Слушающий сокет закрылся сам (например, оборвалось SSH-соединение).
    private func listenerClosed(_ forwardID: UUID, listenerID: ObjectIdentifier) {
        guard let current = listeners[forwardID], ObjectIdentifier(current) == listenerID else { return }
        stop(forwardID)
    }
}

/// Сетевая часть проброса. Не привязана к MainActor: замыкания выполняются в event loop.
enum TunnelBinder {
    /// Открывает 127.0.0.1:localPort на том же event loop, что и SSH-соединение,
    /// поэтому склейка каналов (GlueHandler) работает без межпоточных переходов.
    static func bind(_ forward: PortForward, client: SSHClient, tracker: TunnelConnections) async throws -> Channel {
        guard let bootstrap = ServerBootstrap(validatingGroup: client.eventLoop) else {
            throw TunnelError.unsupportedEventLoop
        }
        let remoteHost = forward.remoteHost.trimmingCharacters(in: .whitespaces).isEmpty
            ? "127.0.0.1"
            : forward.remoteHost.trimmingCharacters(in: .whitespaces)
        let remotePort = forward.remotePort

        return try await bootstrap
            .serverChannelOption(ChannelOptions.socket(SocketOptionLevel(SOL_SOCKET), SO_REUSEADDR), value: 1)
            .serverChannelOption(ChannelOptions.backlog, value: 64)
            .childChannelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_NODELAY), value: 1)
            .childChannelInitializer { inbound in
                tracker.add(inbound)
                inbound.closeFuture.whenComplete { _ in tracker.remove(inbound) }

                let (localGlue, remoteGlue) = GlueHandler.matchedPair()
                let originator: SocketAddress
                if let address = inbound.remoteAddress {
                    originator = address
                } else if let fallback = try? SocketAddress(ipAddress: "127.0.0.1", port: 0) {
                    originator = fallback
                } else {
                    localGlue.unlink()
                    return inbound.eventLoop.makeFailedFuture(TunnelError.unsupportedEventLoop)
                }
                let target = SSHChannelType.DirectTCPIP(
                    targetHost: remoteHost,
                    targetPort: remotePort,
                    originatorAddress: originator
                )

                return inbound.pipeline.addHandler(localGlue).flatMap {
                    inbound.eventLoop.makeFutureWithTask {
                        _ = try await client.createDirectTCPIPChannel(using: target) { channel in
                            channel.pipeline.addHandler(remoteGlue)
                        }
                    }
                }.flatMapError { error in
                    // Сервер не смог открыть соединение (порт закрыт, AllowTcpForwarding no и т.п.).
                    localGlue.unlink()
                    inbound.close(promise: nil)
                    return inbound.eventLoop.makeFailedFuture(error)
                }
            }
            .bind(host: "127.0.0.1", port: forward.localPort)
            .get()
    }

    static func describe(_ error: Error, port: Int) -> String {
        if let tunnel = error as? TunnelError, let text = tunnel.errorDescription { return text }
        if let io = error as? IOError {
            switch io.errnoCode {
            case EADDRINUSE: return TunnelError.portInUse(port).errorDescription ?? ""
            case EACCES, EPERM: return TunnelError.permissionDenied(port).errorDescription ?? ""
            default: return TunnelError.other(port, io.description).errorDescription ?? ""
            }
        }
        let text = String(describing: error)
        if text.contains("EADDRINUSE") || text.contains("Address already in use") {
            return TunnelError.portInUse(port).errorDescription ?? ""
        }
        return TunnelError.other(port, text).errorDescription ?? text
    }
}
