import Foundation
import UIKit
import SwiftTerm
import Citadel
import NIO
import NIOSSH

/// Мост между TerminalView (UIKit) и SSH-каналом. Работает только с потокобезопасными continuation.
final class TerminalBridge: TerminalViewDelegate {
    var input: AsyncStream<Data>.Continuation?
    var resize: AsyncStream<(Int, Int)>.Continuation?
    var onTitle: ((String) -> Void)?

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        input?.yield(Data(data))
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        resize?.yield((newCols, newRows))
    }

    func setTerminalTitle(source: TerminalView, title: String) {
        onTitle?(title)
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func scrolled(source: TerminalView, position: Double) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url) }
    }

    func bell(source: TerminalView) {
        DispatchQueue.main.async { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        if let text = String(data: content, encoding: .utf8) {
            DispatchQueue.main.async { UIPasteboard.general.string = text }
        }
    }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// Цели для жестов (UIKit требует NSObject).
final class TerminalGestureTarget: NSObject {
    weak var session: TerminalSession?
    private var pinchAccumulator: CGFloat = 1

    @MainActor @objc func swipe(_ g: UISwipeGestureRecognizer) {
        guard let session else { return }
        switch g.direction {
        case .left: session.sendKey(.left)
        case .right: session.sendKey(.right)
        case .up: session.sendKey(.up)
        case .down: session.sendKey(.down)
        default: break
        }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    @MainActor @objc func pinch(_ g: UIPinchGestureRecognizer) {
        guard let session else { return }
        switch g.state {
        case .began:
            pinchAccumulator = 1
        case .changed:
            if g.scale / pinchAccumulator > 1.12 {
                session.adjustFont(by: 1)
                pinchAccumulator = g.scale
            } else if g.scale / pinchAccumulator < 0.89 {
                session.adjustFont(by: -1)
                pinchAccumulator = g.scale
            }
        default:
            break
        }
    }
}

@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    enum State: Equatable {
        case connecting
        case connected
        case closed(String?)
    }

    let id = UUID()
    let server: Server
    let terminalView: TerminalView
    private let bridge = TerminalBridge()
    private let gestureTarget = TerminalGestureTarget()

    @Published private(set) var state: State = .connecting
    @Published var title: String
    @Published private(set) var startedAt = Date()
    @Published var trustRequest: HostKeyRequest?

    private(set) var password: String?
    private(set) var connection: SSHConnection?
    private(set) var manuallyClosed = false
    private var task: Task<Void, Never>?
    private var hasStartedOnce = false
    private var retryCount = 0
    private var lastErrorWasFatal = false

    init(server: Server, password: String?) {
        self.server = server
        self.password = password
        self.title = server.title
        self.terminalView = TerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        terminalView.terminalDelegate = bridge
        terminalView.optionAsMetaKey = true
        terminalView.inputAccessoryView = KeyBar(terminalView: terminalView)
        bridge.onTitle = { [weak self] title in
            DispatchQueue.main.async {
                guard let self, !title.isEmpty else { return }
                self.title = title
            }
        }
        installGestures()
        applyAppearance()
    }

    var isAlive: Bool {
        if case .closed = state { return false }
        return true
    }

    // MARK: Внешний вид и ввод

    private func installGestures() {
        gestureTarget.session = self
        // Двумя пальцами — стрелки, одним — прокрутка истории.
        terminalView.panGestureRecognizer.maximumNumberOfTouches = 1
        for direction: UISwipeGestureRecognizer.Direction in [.left, .right, .up, .down] {
            let swipe = UISwipeGestureRecognizer(target: gestureTarget, action: #selector(TerminalGestureTarget.swipe(_:)))
            swipe.direction = direction
            swipe.numberOfTouchesRequired = 2
            terminalView.addGestureRecognizer(swipe)
        }
        let pinch = UIPinchGestureRecognizer(target: gestureTarget, action: #selector(TerminalGestureTarget.pinch(_:)))
        terminalView.addGestureRecognizer(pinch)
    }

    func applyAppearance() {
        let defaults = UserDefaults.standard
        let size = CGFloat(defaults.object(forKey: "fontSize") as? Double ?? 13)
        let fontName = defaults.string(forKey: "fontName") ?? TerminalFont.defaultName
        let theme = TerminalTheme.by(id: defaults.string(forKey: "themeID") ?? "termuxx")
        terminalView.font = TerminalFont.uiFont(name: fontName, size: size)
        terminalView.nativeBackgroundColor = theme.uiBackground
        terminalView.nativeForegroundColor = theme.uiForeground
        terminalView.caretColor = theme.uiCursor
        terminalView.installColors(theme.swiftTermColors)
        terminalView.backgroundColor = theme.uiBackground
        (terminalView.inputAccessoryView as? KeyBar)?.rebuild()
    }

    func adjustFont(by delta: Double) {
        let defaults = UserDefaults.standard
        let size = (defaults.object(forKey: "fontSize") as? Double ?? 13) + delta
        defaults.set(min(max(size, 7), 32), forKey: "fontSize")
        SessionManager.shared.refreshAppearance()
    }

    func send(_ text: String) {
        bridge.input?.yield(Data(text.utf8))
    }

    func sendKey(_ key: KeyBarItem) {
        if let bytes = key.bytes(applicationCursor: terminalView.getTerminal().applicationCursor) {
            bridge.input?.yield(Data(bytes))
        }
    }

    func focus() {
        _ = terminalView.becomeFirstResponder()
    }

    // MARK: Подключение

    func start() {
        task?.cancel()
        manuallyClosed = false
        trustRequest = nil
        state = .connecting
        startedAt = Date()
        task = Task { [weak self] in
            await self?.run()
        }
    }

    func trustAndReconnect() {
        trustRequest?.trust()
        trustRequest = nil
        start()
    }

    func disconnect() {
        manuallyClosed = true
        task?.cancel()
        let connection = self.connection
        self.connection = nil
        bridge.input?.finish()
        bridge.input = nil
        TunnelManager.shared.stopAll(sessionID: id)
        Task { await connection?.close() }
        state = .closed("Отключено")
    }

    /// Нужно ли переподключиться при возврате в приложение.
    var needsReconnect: Bool {
        guard server.autoReconnect, !manuallyClosed, !lastErrorWasFatal, trustRequest == nil else { return false }
        switch state {
        case .closed: return true
        case .connected: return !(connection?.isConnected ?? false)
        case .connecting: return false
        }
    }

    private func echo(_ text: String) {
        terminalView.feed(text: text)
    }

    private func run() async {
        if hasStartedOnce {
            echo("\r\n\u{1b}[2m— переподключение к \(server.subtitle) —\u{1b}[0m\r\n")
        } else {
            echo("\u{1b}[2m→ Подключение к \(server.subtitle)…\u{1b}[0m\r\n")
        }
        let isReconnect = hasStartedOnce
        hasStartedOnce = true
        lastErrorWasFatal = false
        var droppedWhileConnected = false

        do {
            let connection = try await SSHConnector.connect(server, password: password)
            if Task.isCancelled {
                await connection.close()
                return
            }
            self.connection = connection
            state = .connected
            retryCount = 0
            echo("\u{1b}[32m✓ Подключено\u{1b}[0m\r\n")
            UINotificationFeedbackGenerator().notificationOccurred(.success)

            await TunnelManager.shared.startAuto(for: self)

            let terminal = terminalView.getTerminal()
            let cols = max(terminal.cols, 20)
            let rows = max(terminal.rows, 5)

            let (inputStream, inputCont) = AsyncStream<Data>.makeStream()
            let (resizeStream, resizeCont) = AsyncStream<(Int, Int)>.makeStream(bufferingPolicy: .bufferingNewest(1))
            bridge.input = inputCont
            bridge.resize = resizeCont

            if server.useTmux {
                let tmux = " printf '\\033[2J\\033[H'; if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s termuxx; else echo 'tmux не установлен: apt install tmux'; fi\n"
                inputCont.yield(Data(tmux.utf8))
            }
            if !(server.useTmux && isReconnect),
               let snippetID = server.startupSnippetID, let snippet = Store.shared.snippet(snippetID) {
                inputCont.yield(Data((snippet.command + "\n").utf8))
            }

            let request = SSHChannelRequestEvent.PseudoTerminalRequest(
                wantReply: true,
                term: "xterm-256color",
                terminalCharacterWidth: cols,
                terminalRowHeight: rows,
                terminalPixelWidth: 0,
                terminalPixelHeight: 0,
                terminalModes: SSHTerminalModes([:])
            )
            let env = [
                SSHChannelRequestEvent.EnvironmentRequest(wantReply: false, name: "LANG", value: "en_US.UTF-8"),
                SSHChannelRequestEvent.EnvironmentRequest(wantReply: false, name: "COLORTERM", value: "truecolor"),
            ]

            try await connection.client.withPTY(request, environment: env) { inbound, outbound in
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        for await data in inputStream {
                            try await outbound.write(ByteBuffer(bytes: data))
                        }
                    }
                    group.addTask {
                        for await (c, r) in resizeStream {
                            try? await outbound.changeSize(cols: c, rows: r, pixelWidth: 0, pixelHeight: 0)
                        }
                    }
                    group.addTask { [weak self] in
                        for try await chunk in inbound {
                            let bytes: [UInt8]
                            switch chunk {
                            case .stdout(let buffer): bytes = Array(buffer.readableBytesView)
                            case .stderr(let buffer): bytes = Array(buffer.readableBytesView)
                            }
                            await self?.feed(bytes)
                        }
                    }
                    _ = try await group.next()
                    group.cancelAll()
                }
            }
            droppedWhileConnected = !(connection.isConnected)
            finishConnection()
            if !Task.isCancelled {
                if droppedWhileConnected {
                    echo("\r\n\u{1b}[33m⚠ Соединение потеряно\u{1b}[0m\r\n")
                    state = .closed("Соединение потеряно")
                    scheduleRetry()
                } else {
                    echo("\r\n\u{1b}[2m— Сессия завершена —\u{1b}[0m\r\n")
                    manuallyClosed = true
                    state = .closed(nil)
                }
            }
        } catch {
            let wasConnected = connection != nil
            finishConnection()
            guard !Task.isCancelled else { return }
            if let request = error.hostKeyRequest {
                trustRequest = request
                lastErrorWasFatal = true
                echo("\r\n\u{1b}[33m? Новый сервер. Отпечаток ключа:\r\n  \(request.fingerprint)\u{1b}[0m\r\n")
                state = .closed("Подтвердите ключ сервера")
                return
            }
            let message = Self.describe(error)
            lastErrorWasFatal = Self.isFatal(error)
            echo("\r\n\u{1b}[31m✗ \(message.replacingOccurrences(of: "\n", with: "\r\n"))\u{1b}[0m\r\n")
            state = .closed(message)
            if wasConnected || !lastErrorWasFatal { scheduleRetry() }
        }
    }

    private func finishConnection() {
        bridge.input = nil
        bridge.resize = nil
        TunnelManager.shared.stopAll(sessionID: id)
        let connection = self.connection
        self.connection = nil
        Task { await connection?.close() }
    }

    /// Автоматический повтор при обрыве (до 3 раз, если приложение на экране).
    private func scheduleRetry() {
        guard server.autoReconnect, !manuallyClosed, !lastErrorWasFatal, retryCount < 3 else { return }
        guard UIApplication.shared.applicationState == .active else { return }
        retryCount += 1
        let delay = UInt64(retryCount) * 2_000_000_000
        echo("\u{1b}[2m  повтор через \(retryCount * 2) с…\u{1b}[0m\r\n")
        task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self, !Task.isCancelled, !self.manuallyClosed, !self.isAlive else { return }
            self.state = .connecting
            await self.run()
        }
    }

    private func feed(_ bytes: [UInt8]) {
        terminalView.feed(byteArray: bytes[...])
    }

    static func isFatal(_ error: Error) -> Bool {
        if error is TermuxxError { return true }
        let text = String(describing: error)
        return text.contains("allAuthenticationOptionsFailed") || text.contains("unsupported")
    }

    static func describe(_ error: Error) -> String {
        if let e = error as? LocalizedError, let d = e.errorDescription { return d }
        let text = String(describing: error)
        if text.contains("allAuthenticationOptionsFailed") || text.contains("authentication") {
            return "Неверный логин, пароль или ключ."
        }
        if text.contains("unsupportedPasswordAuthentication") {
            return "Сервер не разрешает вход по паролю — используйте ключ."
        }
        if text.contains("connectTimeout") || text.contains("timeout") {
            return "Сервер не отвечает (таймаут)."
        }
        if text.contains("connectionRefused") || text.contains("refused") {
            return "Соединение отклонено. Проверьте адрес и порт."
        }
        if text.contains("nameResolution") || text.contains("NXDOMAIN") || text.contains("getaddrinfo") {
            return "Не удалось найти сервер по имени. Проверьте адрес."
        }
        if text.contains("ioOnClosedChannel") || text.contains("Disconnected") {
            return "Соединение закрыто сервером."
        }
        return text
    }
}

@MainActor
final class SessionManager: ObservableObject {
    static let shared = SessionManager()
    @Published var sessions: [TerminalSession] = []

    func open(_ server: Server, password: String?) -> TerminalSession {
        let session = TerminalSession(server: server, password: password)
        sessions.append(session)
        session.start()
        return session
    }

    func session(_ id: UUID?) -> TerminalSession? {
        sessions.first { $0.id == id }
    }

    func close(_ session: TerminalSession) {
        session.disconnect()
        sessions.removeAll { $0.id == session.id }
    }

    func neighbour(of id: UUID, offset: Int) -> TerminalSession? {
        guard let i = sessions.firstIndex(where: { $0.id == id }), !sessions.isEmpty else { return nil }
        let j = (i + offset + sessions.count) % sessions.count
        return sessions[j]
    }

    func refreshAppearance() {
        sessions.forEach { $0.applyAppearance() }
    }

    /// Вызывается при возврате приложения на экран.
    func appDidBecomeActive() {
        for session in sessions where session.needsReconnect {
            session.start()
        }
    }
}
