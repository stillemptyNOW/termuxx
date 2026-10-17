import SwiftUI
import SwiftTerm

/// Контейнер, в который «вставляется» TerminalView сессии. Сам терминал живёт в сессии,
/// поэтому история и состояние сохраняются при переключении между экранами.
struct TerminalHost: UIViewRepresentable {
    let session: TerminalSession

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = session.terminalView.nativeBackgroundColor
        attach(to: container)
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        container.backgroundColor = session.terminalView.nativeBackgroundColor
        if session.terminalView.superview !== container {
            attach(to: container)
        }
    }

    private func attach(to container: UIView) {
        let tv = session.terminalView
        tv.removeFromSuperview()
        tv.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(tv)
        NSLayoutConstraint.activate([
            tv.leadingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.leadingAnchor, constant: 4),
            tv.trailingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.trailingAnchor, constant: -4),
            tv.topAnchor.constraint(equalTo: container.topAnchor),
            tv.bottomAnchor.constraint(equalTo: container.keyboardLayoutGuide.topAnchor),
        ])
        DispatchQueue.main.async { _ = tv.becomeFirstResponder() }
    }
}

struct TerminalScreen: View {
    @ObservedObject var session: TerminalSession
    @EnvironmentObject var store: Store
    @EnvironmentObject var sessions: SessionManager
    @Environment(\.dismiss) private var dismiss
    @AppStorage("keepAwake") private var keepAwake = true
    @State private var showSFTP = false

    var body: some View {
        TerminalHost(session: session)
            .ignoresSafeArea(.container, edges: .bottom)
            .ignoresSafeArea(.keyboard)
            .background(SwiftUI.Color(uiColor: session.terminalView.nativeBackgroundColor))
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(SwiftUI.Color(uiColor: session.terminalView.nativeBackgroundColor), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(session.server.title).font(.subheadline.weight(.semibold))
                        HStack(spacing: 4) {
                            Circle().fill(statusColor).frame(width: 6, height: 6)
                            Text(statusText).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        if store.snippets.isEmpty {
                            Text("Нет сниппетов")
                        }
                        ForEach(store.snippets) { snippet in
                            Button(snippet.name) {
                                session.send(snippet.command + (snippet.runImmediately ? "\n" : ""))
                            }
                        }
                    } label: {
                        Image(systemName: "text.badge.plus")
                    }
                    Menu {
                        Button {
                            if let text = UIPasteboard.general.string { session.send(text) }
                        } label: { Label("Вставить", systemImage: "doc.on.clipboard") }
                        Button { session.adjustFont(by: 1) } label: { Label("Крупнее", systemImage: "plus.magnifyingglass") }
                        Button { session.adjustFont(by: -1) } label: { Label("Мельче", systemImage: "minus.magnifyingglass") }
                        Button { showSFTP = true } label: { Label("Файлы (SFTP)", systemImage: "folder") }
                        Divider()
                        if session.isAlive {
                            Button(role: .destructive) { session.disconnect() } label: {
                                Label("Отключиться", systemImage: "xmark.circle")
                            }
                        } else {
                            Button { session.start() } label: { Label("Переподключиться", systemImage: "arrow.clockwise") }
                        }
                        Button(role: .destructive) {
                            sessions.close(session)
                            dismiss()
                        } label: { Label("Закрыть вкладку", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if case .closed(let reason) = session.state {
                    ReconnectBanner(reason: reason) { session.start() }
                        .padding()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.spring(duration: 0.3), value: session.state)
            .sheet(isPresented: $showSFTP) {
                NavigationStack {
                    SFTPBrowser(server: session.server, password: session.password)
                }
            }
            .onAppear { UIApplication.shared.isIdleTimerDisabled = keepAwake }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private var statusColor: SwiftUI.Color {
        switch session.state {
        case .connecting: return .orange
        case .connected: return .green
        case .closed: return .red
        }
    }

    private var statusText: String {
        switch session.state {
        case .connecting: return "подключение…"
        case .connected: return session.server.subtitle
        case .closed: return "отключено"
        }
    }
}

private struct ReconnectBanner: View {
    let reason: String?
    let action: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "bolt.horizontal.circle.fill")
                .font(.title2)
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Соединение закрыто").font(.subheadline.weight(.semibold))
                if let reason {
                    Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            Button("Снова", action: action)
                .buttonStyle(.borderedProminent)
                .tint(.accentColor)
        }
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
