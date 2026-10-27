import SwiftUI
import UIKit
import SwiftTerm

// MARK: - Контейнер для TerminalView

/// UIView, в который «вставляется» TerminalView сессии. Сам терминал живёт в сессии,
/// поэтому история сохраняется при переключении вкладок. Один TerminalView может быть
/// только в одном контейнере — при повторном подключении он просто переезжает.
final class TerminalContainerView: UIView {
    private weak var hosted: TerminalView?

    func attach(_ terminalView: TerminalView, focus: Bool) {
        backgroundColor = terminalView.nativeBackgroundColor
        hosted = terminalView
        guard terminalView.superview !== self else { return }
        terminalView.removeFromSuperview()
        terminalView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(terminalView)
        NSLayoutConstraint.activate([
            terminalView.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 4),
            terminalView.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -4),
            terminalView.topAnchor.constraint(equalTo: topAnchor),
            terminalView.bottomAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
        ])
        if focus {
            DispatchQueue.main.async { [weak terminalView] in
                _ = terminalView?.becomeFirstResponder()
            }
        }
    }

    /// Убирает терминал, только если он всё ещё здесь (его могли уже забрать в другой контейнер).
    func detachIfOwned() {
        if let hosted, hosted.superview === self {
            hosted.removeFromSuperview()
        }
    }
}

struct TerminalHost: UIViewRepresentable {
    let session: TerminalSession
    var focusOnAttach: Bool = true

    func makeUIView(context: Context) -> TerminalContainerView {
        let container = TerminalContainerView()
        container.attach(session.terminalView, focus: focusOnAttach)
        return container
    }

    func updateUIView(_ container: TerminalContainerView, context: Context) {
        container.attach(session.terminalView, focus: false)
    }

    static func dismantleUIView(_ container: TerminalContainerView, coordinator: Void) {
        container.detachIfOwned()
    }
}

// MARK: - Экран терминала

enum TerminalSheet: Identifiable {
    case sftp(Server, String?)
    case monitor(Server, String?)
    case tunnels(TerminalSession)

    var id: String {
        switch self {
        case .sftp: return "sftp"
        case .monitor: return "monitor"
        case .tunnels: return "tunnels"
        }
    }
}

struct TerminalScreen: View {
    @EnvironmentObject private var sessions: SessionManager
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("keepAwake") private var keepAwake = true

    @State private var currentID: UUID
    @State private var splitID: UUID?
    @State private var sheet: TerminalSheet?
    @Namespace private var glassNamespace

    init(sessionID: UUID) {
        _currentID = State(initialValue: sessionID)
    }

    private var current: TerminalSession? { sessions.session(currentID) }

    private var splitSession: TerminalSession? {
        guard horizontalSizeClass == .regular, let splitID, splitID != currentID else { return nil }
        return sessions.session(splitID)
    }

    private var themeColor: SwiftUI.Color {
        let ui = current?.terminalView.nativeBackgroundColor
            ?? TerminalTheme.by(id: UserDefaults.standard.string(forKey: "themeID") ?? "termuxx").uiBackground
        return SwiftUI.Color(uiColor: ui)
    }

    var body: some View {
        VStack(spacing: 0) {
            if sessions.sessions.count > 1 {
                SessionStrip(
                    currentID: currentID,
                    splitID: splitSession?.id,
                    namespace: glassNamespace,
                    onSelect: selectSession,
                    onClose: closeSession
                )
            }
            if let session = current {
                TerminalWorkspace(
                    session: session,
                    split: splitSession,
                    splitID: $splitID,
                    sheet: $sheet,
                    onSelect: selectSession,
                    onCycle: cycleSessions,
                    onSelectIndex: selectSessionIndex,
                    onClose: closeSession
                )
                .id(session.id)
            } else {
                ContentUnavailableView(
                    "Сессия закрыта",
                    systemImage: "xmark.circle",
                    description: Text("Откройте сервер из списка, чтобы начать новую сессию.")
                )
                .frame(maxHeight: .infinity)
            }
        }
        .background(themeColor.ignoresSafeArea())
        .toolbar(.hidden, for: .tabBar)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = keepAwake }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .onChange(of: keepAwake) { _, value in
            UIApplication.shared.isIdleTimerDisabled = value
        }
        .onChange(of: sessions.sessions.map { $0.id }) { _, ids in
            if let splitID, !ids.contains(splitID) {
                self.splitID = nil
            }
            if !ids.contains(currentID) {
                if let first = ids.first {
                    currentID = first
                } else {
                    dismiss()
                }
            }
        }
        .sheet(item: $sheet) { sheet in
            sheetContent(sheet)
                .environmentObject(store)
                .environmentObject(sessions)
                .environmentObject(AppRouter.shared)
        }
    }

    @ViewBuilder
    private func sheetContent(_ sheet: TerminalSheet) -> some View {
        switch sheet {
        case .sftp(let server, let password):
            NavigationStack {
                SFTPBrowser(server: server, password: password)
            }
        case .monitor(let server, let password):
            NavigationStack {
                DashboardView(server: server, password: password)
            }
        case .tunnels(let session):
            NavigationStack {
                TunnelsView(session: session)
            }
        }
    }

    // MARK: Вкладки

    private func selectSession(_ id: UUID) {
        guard id != currentID, sessions.session(id) != nil else { return }
        withAnimation(.spring(duration: 0.3)) {
            if splitID == id { splitID = currentID }
            currentID = id
        }
    }

    private func cycleSessions(_ offset: Int) {
        guard let next = sessions.neighbour(of: currentID, offset: offset), next.id != currentID else { return }
        selectSession(next.id)
    }

    private func selectSessionIndex(_ index: Int) {
        let all = sessions.sessions
        guard index >= 1, index <= all.count else { return }
        selectSession(all[index - 1].id)
    }

    private func closeSession(_ session: TerminalSession) {
        let wasCurrent = session.id == currentID
        let next = wasCurrent ? sessions.neighbour(of: session.id, offset: 1) : nil
        if splitID == session.id { splitID = nil }
        sessions.close(session)
        guard wasCurrent else { return }
        if let next, next.id != session.id, sessions.session(next.id) != nil {
            if splitID == next.id { splitID = nil }
            currentID = next.id
        } else {
            dismiss()
        }
    }
}

// MARK: - Рабочая область (текущая сессия + iPad-разделение)

private struct TerminalWorkspace: View {
    @ObservedObject var session: TerminalSession
    let split: TerminalSession?
    @Binding var splitID: UUID?
    @Binding var sheet: TerminalSheet?
    let onSelect: (UUID) -> Void
    let onCycle: (Int) -> Void
    let onSelectIndex: (Int) -> Void
    let onClose: (TerminalSession) -> Void

    @EnvironmentObject private var sessions: SessionManager
    @EnvironmentObject private var store: Store
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var themeColor: SwiftUI.Color {
        SwiftUI.Color(uiColor: session.terminalView.nativeBackgroundColor)
    }

    var body: some View {
        HStack(spacing: 0) {
            TerminalPane(session: session, isPrimary: true)
            if let split {
                Rectangle()
                    .fill(SwiftUI.Color.white.opacity(0.14))
                    .frame(width: 1)
                    .ignoresSafeArea(.container, edges: .bottom)
                TerminalPane(session: split, isPrimary: false)
            }
        }
        .background(themeColor.ignoresSafeArea())
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .terminalNavigationBar(themeColor)
        .toolbar {
            ToolbarItem(placement: .principal) {
                StatusTitle(session: session)
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                snippetsMenu
                actionsMenu
            }
        }
        .background { shortcuts }
    }

    // MARK: Меню

    private var snippetsMenu: some View {
        Menu {
            if store.snippets.isEmpty {
                Text("Нет сниппетов — добавьте их во вкладке «Сниппеты»")
            }
            ForEach(store.snippets) { snippet in
                Button {
                    session.send(snippet.command + (snippet.runImmediately ? "\r" : ""))
                } label: {
                    Label(snippet.name, systemImage: snippet.runImmediately ? "return" : "text.cursor")
                }
            }
        } label: {
            Image(systemName: "text.badge.plus")
        }
        .accessibilityLabel("Сниппеты")
    }

    private var actionsMenu: some View {
        Menu {
            Section {
                Button { session.paste() } label: {
                    Label("Вставить", systemImage: "doc.on.clipboard")
                }
                Button { session.adjustFont(by: 1) } label: {
                    Label("Крупнее", systemImage: "textformat.size.larger")
                }
                Button { session.adjustFont(by: -1) } label: {
                    Label("Мельче", systemImage: "textformat.size.smaller")
                }
            }
            Section {
                Button { sheet = .sftp(session.server, session.password) } label: {
                    Label("Файлы (SFTP)", systemImage: "folder")
                }
                Button { sheet = .monitor(session.server, session.password) } label: {
                    Label("Мониторинг", systemImage: "gauge.with.dots.needle.67percent")
                }
                Button { sheet = .tunnels(session) } label: {
                    Label("Туннели", systemImage: "point.3.connected.trianglepath.dotted")
                }
            }
            if horizontalSizeClass == .regular {
                Section {
                    splitControls
                }
            }
            Section {
                if session.isAlive {
                    Button(role: .destructive) { session.disconnect() } label: {
                        Label("Отключиться", systemImage: "bolt.slash")
                    }
                } else {
                    Button { session.start() } label: {
                        Label("Переподключиться", systemImage: "arrow.clockwise")
                    }
                }
                Button(role: .destructive) { onClose(session) } label: {
                    Label("Закрыть вкладку", systemImage: "xmark.square")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Действия")
    }

    @ViewBuilder
    private var splitControls: some View {
        if split != nil {
            Button { splitID = nil } label: {
                Label("Убрать разделение", systemImage: "rectangle")
            }
        } else {
            let others = sessions.sessions.filter { $0.id != session.id }
            if others.isEmpty {
                Button {} label: {
                    Label("Разделить экран — нужна вторая сессия", systemImage: "rectangle.split.2x1")
                }
                .disabled(true)
            } else {
                Menu {
                    ForEach(others) { other in
                        Button(other.server.title) { splitID = other.id }
                    }
                } label: {
                    Label("Разделить экран", systemImage: "rectangle.split.2x1")
                }
            }
        }
    }

    // MARK: Горячие клавиши (внешняя клавиатура)

    private var shortcuts: some View {
        ZStack {
            Button("Закрыть вкладку") { onClose(session) }
                .keyboardShortcut("w", modifiers: .command)
            Button("Следующая вкладка") { onCycle(1) }
                .keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Предыдущая вкладка") { onCycle(-1) }
                .keyboardShortcut("[", modifiers: [.command, .shift])
            Button("Крупнее") { session.adjustFont(by: 1) }
                .keyboardShortcut("+", modifiers: .command)
            Button("Крупнее") { session.adjustFont(by: 1) }
                .keyboardShortcut("=", modifiers: .command)
            Button("Мельче") { session.adjustFont(by: -1) }
                .keyboardShortcut("-", modifiers: .command)
            Button("Очистить экран") { session.sendKey(.ctrlL) }
                .keyboardShortcut("k", modifiers: .command)
            Button("Переподключиться") {
                if !session.isAlive { session.start() }
            }
            .keyboardShortcut("r", modifiers: .command)
            ForEach(1...9, id: \.self) { index in
                Button("Вкладка \(index)") { onSelectIndex(index) }
                    .keyboardShortcut(KeyEquivalent(Character(String(index))), modifiers: .command)
            }
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .accessibilityHidden(true)
    }
}

// MARK: - Панель терминала с баннерами

private struct TerminalPane: View {
    @ObservedObject var session: TerminalSession
    let isPrimary: Bool

    var body: some View {
        TerminalHost(session: session, focusOnAttach: isPrimary)
            .ignoresSafeArea(.container, edges: .bottom)
            .ignoresSafeArea(.keyboard)
            .overlay(alignment: .top) {
                banner
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }
            .animation(.spring(duration: 0.35), value: session.state)
            .animation(.spring(duration: 0.35), value: session.trustRequest)
    }

    @ViewBuilder
    private var banner: some View {
        if let request = session.trustRequest {
            TrustBanner(
                request: request,
                onTrust: { session.trustAndReconnect() },
                onCancel: { session.trustRequest = nil }
            )
            .transition(.move(edge: .top).combined(with: .opacity))
        } else if case .closed(let reason) = session.state {
            ReconnectBanner(reason: reason) { session.start() }
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

private struct TrustBanner: View {
    let request: HostKeyRequest
    let onTrust: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.title2)
                    .foregroundStyle(SwiftUI.Color.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Новый сервер")
                        .font(.subheadline.weight(.semibold))
                    Text(request.hostLabel)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Text(request.fingerprint)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text("Сверьте отпечаток на сервере: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Отмена", role: .cancel, action: onCancel)
                    .glassButtonStyle()
                Spacer(minLength: 8)
                Button(action: onTrust) {
                    Label("Доверять и подключиться", systemImage: "checkmark")
                }
                .glassButtonStyle(prominent: true)
            }
        }
        .padding(14)
        .frame(maxWidth: 520, alignment: .leading)
        .glassCard(cornerRadius: 22)
    }
}

private struct ReconnectBanner: View {
    let reason: String?
    let action: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: reason == nil ? "checkmark.circle.fill" : "bolt.horizontal.circle.fill")
                .font(.title2)
                .foregroundStyle(reason == nil ? SwiftUI.Color.secondary : SwiftUI.Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(reason == nil ? "Сессия завершена" : "Соединение закрыто")
                    .font(.subheadline.weight(.semibold))
                if let reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 8)
            Button(action: action) {
                Label("Снова", systemImage: "arrow.clockwise")
            }
            .glassButtonStyle(prominent: true)
        }
        .padding(14)
        .frame(maxWidth: 520)
        .glassCard(cornerRadius: 22)
    }
}

// MARK: - Заголовок со статусом

private struct StatusTitle: View {
    @ObservedObject var session: TerminalSession

    var body: some View {
        VStack(spacing: 1) {
            Text(session.server.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            HStack(spacing: 4) {
                Circle()
                    .fill(session.state.statusDotColor)
                    .frame(width: 6, height: 6)
                Text(statusText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        switch session.state {
        case .connecting:
            return "подключение…"
        case .connected:
            return session.title == session.server.title ? session.server.subtitle : session.title
        case .closed:
            return "отключено"
        }
    }
}

fileprivate extension TerminalSession.State {
    var statusDotColor: SwiftUI.Color {
        switch self {
        case .connecting: return .orange
        case .connected: return .green
        case .closed: return .red
        }
    }
}

// MARK: - Полоса вкладок (Liquid Glass)

private struct SessionStrip: View {
    @EnvironmentObject private var sessions: SessionManager
    let currentID: UUID
    let splitID: UUID?
    let namespace: Namespace.ID
    let onSelect: (UUID) -> Void
    let onClose: (TerminalSession) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                GlassGroup(spacing: 8) {
                    HStack(spacing: 8) {
                        ForEach(sessions.sessions) { session in
                            Button {
                                onSelect(session.id)
                            } label: {
                                SessionChip(
                                    session: session,
                                    isCurrent: session.id == currentID,
                                    isSplit: session.id == splitID,
                                    namespace: namespace
                                )
                            }
                            .buttonStyle(.plain)
                            .id(session.id)
                            .contextMenu {
                                Button { onSelect(session.id) } label: {
                                    Label("Открыть", systemImage: "terminal")
                                }
                                Button(role: .destructive) { onClose(session) } label: {
                                    Label("Закрыть вкладку", systemImage: "xmark")
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
            }
            .onAppear { proxy.scrollTo(currentID, anchor: .center) }
            .onChange(of: currentID) { _, id in
                withAnimation(.easeInOut(duration: 0.25)) {
                    proxy.scrollTo(id, anchor: .center)
                }
            }
        }
    }
}

private struct SessionChip: View {
    @ObservedObject var session: TerminalSession
    let isCurrent: Bool
    let isSplit: Bool
    let namespace: Namespace.ID

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(session.state.statusDotColor)
                .frame(width: 7, height: 7)
            Text(session.server.title)
                .font(.footnote.weight(isCurrent ? .semibold : .regular))
                .lineLimit(1)
            if isSplit {
                Image(systemName: "rectangle.split.2x1")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .foregroundStyle(isCurrent ? SwiftUI.Color.primary : SwiftUI.Color.secondary)
        .glassCapsule(tint: isCurrent ? SwiftUI.Color.accentColor.opacity(0.4) : nil, interactive: true)
        .glassID(session.id, in: namespace)
        .contentShape(Capsule())
    }
}

// MARK: - Навигационная панель

private extension View {
    /// На iOS 26 оставляем системную стеклянную панель, на старых — красим в цвет терминала.
    @ViewBuilder
    func terminalNavigationBar(_ color: SwiftUI.Color) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self
        } else {
            self
                .toolbarBackground(color, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        }
        #else
        self
            .toolbarBackground(color, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        #endif
    }
}
