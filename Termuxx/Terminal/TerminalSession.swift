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

    @Published private(set) var state: State = .connecting
    @Published var title: String
    @Published private(set) var startedAt = Date()

    private(set) var password: String?
    private var task: Task<Void, Never>?
    private var client: SSHClient?

    init(server: Server, password: String?) {
        self.server = server
        self.password = password
        self.title = server.title
        self.terminalView = TerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        terminalView.terminalDelegate = bridge
        terminalView.optionAsMetaKey = true
        bridge.onTitle = { [weak self] title in
            DispatchQueue.main.async {
                guard let self, !title.isEmpty else { return }
                self.title = title
            }
        }
        applyAppearance()
    }

    var isAlive: Bool {
        if case .closed = state { return false }
        return true
    }

    func applyAppearance() {
        let defaults = UserDefaults.standard
        let size = defaults.object(forKey: "fontSize") as? Double ?? 13
        let theme = TerminalTheme.by(id: defaults.string(forKey: "themeID") ?? "termuxx")
        terminalView.font = UIFont.monospacedSystemFont(ofSize: CGFloat(size), weight: .regular)
        terminalView.nativeBackgroundColor = theme.uiBackground
        terminalView.nativeForegroundColor = theme.uiForeground
        terminalView.caretColor = theme.uiCursor
        terminalView.installColors(theme.swiftTermColors)
        terminalView.backgroundColor = theme.uiBackground
    }

    func adjustFont(by delta: Double) {
        let defaults = UserDefaults.standard
        let size = (defaults.object(forKey: "fontSize") as? Double ?? 13) + delta
        defaults.set(min(max(size, 8), 28), forKey: "fontSize")
        applyAppearance()
    }

    // MARK: Connection

    func start() {
        task?.cancel()
        state = .connecting
        startedAt = Date()
        task = Task { [weak self] in
            await self?.run()
        }
    }

    func send(_ text: String) {
        bridge.input?.yield(Data(text.utf8))
    }

    func disconnect() {
        task?.cancel()
        let client = self.client
        Task { try? await client?.close() }
        bridge.input?.finish()
        state = .closed("Отключено")
    }

    private func echo(_ text: String) {
        terminalView.feed(text: text)
    }

    private func run() async {
        echo("\u{1b}[2m→ Подключение к \(server.subtitle)…\u{1b}[0m\r\n")
        do {
            let client = try await SSHConnector.connect(server, password: password)
            self.client = client
            state = .connected
            echo("\u{1b}[32m✓ Подключено\u{1b}[0m\r\n")

            let terminal = terminalView.getTerminal()
            let cols = max(terminal.cols, 20)
            let rows = max(terminal.rows, 5)

            let (inputStream, inputCont) = AsyncStream<Data>.makeStream()
            let (resizeStream, resizeCont) = AsyncStream<(Int, Int)>.makeStream(bufferingPolicy: .bufferingNewest(1))
            bridge.input = inputCont
            bridge.resize = resizeCont

            if let snippetID = server.startupSnippetID, let snippet = Store.shared.snippet(snippetID) {
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

            try await client.withPTY(request, environment: env) { inbound, outbound in
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
            bridge.input = nil
            bridge.resize = nil
            try? await client.close()
            if !Task.isCancelled {
                echo("\r\n\u{1b}[2m— Сессия завершена —\u{1b}[0m\r\n")
                state = .closed(nil)
            }
        } catch {
            bridge.input = nil
            bridge.resize = nil
            if let client { try? await client.close() }
            guard !Task.isCancelled else { return }
            let message = Self.describe(error)
            echo("\r\n\u{1b}[31m✗ \(message.replacingOccurrences(of: "\n", with: "\r\n"))\u{1b}[0m\r\n")
            state = .closed(message)
        }
    }

    private func feed(_ bytes: [UInt8]) {
        terminalView.feed(byteArray: bytes[...])
    }

    static func describe(_ error: Error) -> String {
        if let e = error as? LocalizedError, let d = e.errorDescription { return d }
        let text = String(describing: error)
        if text.contains("authentication") || text.contains("allAuthenticationOptionsFailed") {
            return "Неверный логин, пароль или ключ."
        }
        if text.contains("connectTimeout") || text.contains("timeout") {
            return "Сервер не отвечает (таймаут)."
        }
        if text.contains("connectionRefused") || text.contains("refused") {
            return "Соединение отклонено. Проверьте адрес и порт."
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

    func session(_ id: UUID) -> TerminalSession? {
        sessions.first { $0.id == id }
    }

    func close(_ session: TerminalSession) {
        session.disconnect()
        sessions.removeAll { $0.id == session.id }
    }

    func refreshAppearance() {
        sessions.forEach { $0.applyAppearance() }
    }
}
