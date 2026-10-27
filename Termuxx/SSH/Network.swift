import Foundation
import NIO

/// TCP-подключение с keep-alive и (опционально) через SOCKS5-прокси.
enum TCPConnector {
    static func connect(
        host: String,
        port: Int,
        proxy: ProxyConfig?,
        proxyPassword: String?,
        keepAlive: Bool,
        timeout: TimeAmount = .seconds(15)
    ) async throws -> Channel {
        var bootstrap = ClientBootstrap(group: MultiThreadedEventLoopGroup.singleton)
            .connectTimeout(timeout)
            .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_NODELAY), value: 1)

        if keepAlive {
            bootstrap = bootstrap
                .channelOption(ChannelOptions.socket(SocketOptionLevel(SOL_SOCKET), SO_KEEPALIVE), value: 1)
                .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_KEEPALIVE), value: 30)
                .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_KEEPINTVL), value: 15)
                .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_KEEPCNT), value: 4)
        }

        guard let proxy, !proxy.host.isEmpty else {
            return try await bootstrap.connect(host: host, port: port).get()
        }

        let handshake = SOCKS5Handshake(
            targetHost: host,
            targetPort: port,
            username: proxy.username,
            password: proxyPassword ?? ""
        )
        let channel = try await bootstrap
            .channelInitializer { channel in
                channel.pipeline.addHandler(handshake)
            }
            .connect(host: proxy.host, port: proxy.port)
            .get()
        do {
            try await channel.eventLoop.flatSubmit { handshake.completion }
                .get()
        } catch {
            try? await channel.close()
            throw error
        }
        return channel
    }
}

enum SOCKSError: LocalizedError {
    case noAcceptableMethod
    case authFailed
    case connectFailed(UInt8)
    case closed
    case badReply

    var errorDescription: String? {
        switch self {
        case .noAcceptableMethod: return "SOCKS5-прокси не принял способ авторизации."
        case .authFailed: return "SOCKS5-прокси: неверный логин или пароль."
        case .connectFailed(let code):
            let reasons: [UInt8: String] = [
                1: "общая ошибка", 2: "запрещено правилами", 3: "сеть недоступна", 4: "хост недоступен",
                5: "соединение отклонено", 6: "истёк TTL", 7: "команда не поддерживается", 8: "тип адреса не поддерживается",
            ]
            return "SOCKS5-прокси не смог подключиться к серверу: \(reasons[code] ?? "код \(code)")."
        case .closed: return "SOCKS5-прокси закрыл соединение."
        case .badReply: return "SOCKS5-прокси ответил непонятно."
        }
    }
}

/// Минимальный клиент SOCKS5 (RFC 1928 + RFC 1929). После рукопожатия становится прозрачным.
final class SOCKS5Handshake: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer

    private enum Stage { case greeting, auth, connect, done, failed }

    private let targetHost: String
    private let targetPort: Int
    private let username: String
    private let password: String

    private var stage: Stage = .greeting
    private var greeted = false
    private var buffer = ByteBuffer()
    private var leftover: ByteBuffer?
    private var promise: EventLoopPromise<Void>?

    var completion: EventLoopFuture<Void> { promise!.futureResult }

    init(targetHost: String, targetPort: Int, username: String, password: String) {
        self.targetHost = targetHost
        self.targetPort = targetPort
        self.username = username
        self.password = password
    }

    func handlerAdded(context: ChannelHandlerContext) {
        promise = context.eventLoop.makePromise(of: Void.self)
        if context.channel.isActive { sendGreeting(context) }
    }

    func channelActive(context: ChannelHandlerContext) {
        sendGreeting(context)
        context.fireChannelActive()
    }

    func channelInactive(context: ChannelHandlerContext) {
        if stage != .done { fail(SOCKSError.closed) }
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        if stage != .done { fail(error) }
        context.fireErrorCaught(error)
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var incoming = unwrapInboundIn(data)
        if stage == .done {
            context.fireChannelRead(data)
            return
        }
        buffer.writeBuffer(&incoming)
        process(context)
    }

    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        context.write(data, promise: promise)
        // Первая запись от SSH означает, что SSH-обработчики уже стоят в пайплайне —
        // отдаём им байты, пришедшие вместе с ответом прокси.
        if stage == .done, let pending = leftover {
            leftover = nil
            context.eventLoop.execute {
                context.fireChannelRead(self.wrapInboundOut(pending))
            }
        }
    }

    private func sendGreeting(_ context: ChannelHandlerContext) {
        guard !greeted else { return }
        greeted = true
        var out = context.channel.allocator.buffer(capacity: 4)
        if username.isEmpty {
            out.writeBytes([0x05, 0x01, 0x00])
        } else {
            out.writeBytes([0x05, 0x02, 0x00, 0x02])
        }
        context.writeAndFlush(wrapOutboundOut(out), promise: nil)
    }

    private func sendAuth(_ context: ChannelHandlerContext) {
        let user = Array(username.utf8.prefix(255))
        let pass = Array(password.utf8.prefix(255))
        var out = context.channel.allocator.buffer(capacity: 3 + user.count + pass.count)
        out.writeInteger(UInt8(0x01))
        out.writeInteger(UInt8(user.count))
        out.writeBytes(user)
        out.writeInteger(UInt8(pass.count))
        out.writeBytes(pass)
        context.writeAndFlush(wrapOutboundOut(out), promise: nil)
    }

    private func sendConnect(_ context: ChannelHandlerContext) {
        var out = context.channel.allocator.buffer(capacity: 300)
        out.writeBytes([0x05, 0x01, 0x00])
        if let v4 = Self.ipv4Bytes(targetHost) {
            out.writeInteger(UInt8(0x01))
            out.writeBytes(v4)
        } else {
            let host = Array(targetHost.utf8.prefix(255))
            out.writeInteger(UInt8(0x03))
            out.writeInteger(UInt8(host.count))
            out.writeBytes(host)
        }
        out.writeInteger(UInt16(targetPort))
        context.writeAndFlush(wrapOutboundOut(out), promise: nil)
    }

    private func process(_ context: ChannelHandlerContext) {
        while true {
            switch stage {
            case .greeting:
                guard let bytes = buffer.readBytes(length: 2) else { return }
                guard bytes[0] == 0x05 else { return fail(SOCKSError.badReply) }
                switch bytes[1] {
                case 0x00:
                    stage = .connect
                    sendConnect(context)
                case 0x02 where !username.isEmpty:
                    stage = .auth
                    sendAuth(context)
                default:
                    return fail(SOCKSError.noAcceptableMethod)
                }
            case .auth:
                guard let bytes = buffer.readBytes(length: 2) else { return }
                guard bytes[1] == 0x00 else { return fail(SOCKSError.authFailed) }
                stage = .connect
                sendConnect(context)
            case .connect:
                guard buffer.readableBytes >= 5,
                      let head = buffer.getBytes(at: buffer.readerIndex, length: 5) else { return }
                let total: Int
                switch head[3] {
                case 0x01: total = 10
                case 0x03: total = 7 + Int(head[4])
                case 0x04: total = 22
                default: return fail(SOCKSError.badReply)
                }
                guard buffer.readableBytes >= total else { return }
                guard head[1] == 0x00 else { return fail(SOCKSError.connectFailed(head[1])) }
                buffer.moveReaderIndex(forwardBy: total)
                stage = .done
                if buffer.readableBytes > 0 {
                    leftover = buffer.readSlice(length: buffer.readableBytes)
                }
                buffer = ByteBuffer()
                promise?.succeed(())
                return
            case .done, .failed:
                return
            }
        }
    }

    private func fail(_ error: Error) {
        guard stage != .failed else { return }
        stage = .failed
        promise?.fail(error)
    }

    private static func ipv4Bytes(_ host: String) -> [UInt8]? {
        let parts = host.split(separator: ".")
        guard parts.count == 4 else { return nil }
        let nums = parts.compactMap { UInt8($0) }
        return nums.count == 4 ? nums : nil
    }
}

/// Склеивает два канала: всё, что пришло в один, пишется в другой (для проброса портов).
final class GlueHandler: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer

    private var partner: GlueHandler?
    private var context: ChannelHandlerContext?
    private var pendingRead = false
    private var pending: [ByteBuffer] = []

    static func matchedPair() -> (GlueHandler, GlueHandler) {
        let a = GlueHandler(), b = GlueHandler()
        a.partner = b
        b.partner = a
        return (a, b)
    }

    private func partnerWrite(_ data: ByteBuffer) {
        guard let context else {
            pending.append(data)
            return
        }
        context.write(wrapOutboundOut(data), promise: nil)
    }

    private func partnerFlush() { context?.flush() }

    private func partnerWriteEOF() {
        context?.close(mode: .output, promise: nil)
    }

    private func partnerCloseFull() { context?.close(promise: nil) }

    private func partnerBecameWritable() {
        if pendingRead {
            pendingRead = false
            context?.read()
        }
    }

    private var partnerWritable: Bool { context?.channel.isWritable ?? false }

    func handlerAdded(context: ChannelHandlerContext) {
        self.context = context
        if !pending.isEmpty {
            for data in pending { context.write(wrapOutboundOut(data), promise: nil) }
            pending.removeAll()
            context.flush()
        }
    }

    func handlerRemoved(context: ChannelHandlerContext) {
        self.context = nil
        partner = nil
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        partner?.partnerWrite(unwrapInboundIn(data))
    }

    func channelReadComplete(context: ChannelHandlerContext) {
        partner?.partnerFlush()
    }

    func channelInactive(context: ChannelHandlerContext) {
        partner?.partnerCloseFull()
    }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let event = event as? ChannelEvent, case .inputClosed = event {
            partner?.partnerWriteEOF()
        }
        context.fireUserInboundEventTriggered(event)
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        partner?.partnerCloseFull()
        context.close(promise: nil)
    }

    func channelWritabilityChanged(context: ChannelHandlerContext) {
        if context.channel.isWritable {
            partner?.partnerBecameWritable()
        }
    }

    func read(context: ChannelHandlerContext) {
        if let partner, partner.partnerWritable {
            context.read()
        } else if partner?.context == nil {
            context.read()
        } else {
            pendingRead = true
        }
    }
}
