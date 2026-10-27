import SwiftUI

private enum PendingAction {
    case terminal
    case sftp
    case monitor
}

/// Сервер + пароль, введённый перед подключением (для листов SFTP и мониторинга).
struct ConnectTarget: Identifiable {
    let id = UUID()
    let server: Server
    let password: String?
}

struct HostsView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var sessions: SessionManager
    @EnvironmentObject var router: AppRouter

    @State private var search = ""
    @State private var editing: Server?
    @State private var creatingNew = false
    @State private var deleting: Server?

    @State private var promptServer: Server?
    @State private var promptAction: PendingAction = .terminal
    @State private var promptPassword = ""
    @State private var promptIsQuick = false

    @State private var askQuick = false
    @State private var quickText = ""

    @State private var sftpTarget: ConnectTarget?
    @State private var monitorTarget: ConnectTarget?

    private var filtered: [Server] {
        let list = store.hosts.sorted { ($0.lastConnected ?? .distantPast) > ($1.lastConnected ?? .distantPast) }
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return list }
        return list.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.hostname.localizedCaseInsensitiveContains(query)
                || $0.username.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack(path: $router.hostsPath) {
            List {
                if !store.hosts.isEmpty && search.isEmpty {
                    Section {
                        quickConnectPill
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
                }

                if !sessions.sessions.isEmpty {
                    Section("Активные сессии") {
                        ForEach(sessions.sessions) { session in
                            NavigationLink(value: Route.terminal(session.id)) {
                                SessionRow(session: session)
                            }
                            .swipeActions {
                                Button(role: .destructive) { sessions.close(session) } label: {
                                    Label("Закрыть", systemImage: "xmark")
                                }
                            }
                        }
                    }
                }

                if !store.hosts.isEmpty {
                    Section {
                        ForEach(filtered) { server in
                            Button { start(server, action: .terminal) } label: {
                                HostRow(server: server)
                            }
                            .contextMenu { menu(for: server) }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { deleting = server } label: {
                                    Label("Удалить", systemImage: "trash")
                                }
                                Button { editing = server } label: {
                                    Label("Изменить", systemImage: "pencil")
                                }
                                .tint(.orange)
                            }
                            .swipeActions(edge: .leading) {
                                Button { start(server, action: .sftp) } label: {
                                    Label("SFTP", systemImage: "folder")
                                }
                                .tint(.blue)
                                Button { start(server, action: .monitor) } label: {
                                    Label("Мониторинг", systemImage: "chart.xyaxis.line")
                                }
                                .tint(.purple)
                            }
                        }
                    } header: {
                        Text("Серверы")
                    } footer: {
                        if !search.isEmpty && filtered.isEmpty {
                            Text("Ничего не найдено")
                        }
                    }
                }
            }
            .overlay {
                if store.hosts.isEmpty && sessions.sessions.isEmpty {
                    emptyState
                }
            }
            .searchable(text: $search, prompt: "Поиск серверов")
            .navigationTitle("Termuxx")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { creatingNew = true } label: { Label("Новый сервер", systemImage: "plus") }
                        Button { openQuickConnect() } label: { Label("Быстрое подключение", systemImage: "bolt") }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .terminal(let id):
                    TerminalScreen(sessionID: id)
                }
            }
            .sheet(item: $editing) { server in
                NavigationStack { HostEditView(server: server) }
            }
            .sheet(isPresented: $creatingNew) {
                NavigationStack { HostEditView(server: nil) }
            }
            .sheet(item: $sftpTarget) { target in
                NavigationStack { SFTPBrowser(server: target.server, password: target.password) }
            }
            .sheet(item: $monitorTarget) { target in
                NavigationStack { DashboardView(server: target.server, password: target.password) }
            }
            .alert("Пароль для \(promptServer?.subtitle ?? "")", isPresented: Binding(
                get: { promptServer != nil },
                set: { if !$0 { promptServer = nil } }
            )) {
                SecureField("Пароль", text: $promptPassword)
                Button("Подключиться") { finishPrompt(save: false) }
                Button(promptIsQuick ? "Сохранить сервер и подключиться" : "Подключиться и сохранить") {
                    finishPrompt(save: true)
                }
                Button("Отмена", role: .cancel) { promptServer = nil }
            } message: {
                Text(promptIsQuick ? "Пароль хранится только в Keychain этого устройства." : "Сохранённый пароль хранится в Keychain.")
            }
            .alert("Быстрое подключение", isPresented: $askQuick) {
                TextField("user@host:port", text: $quickText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                Button("Далее") {
                    if let server = Server.quick(quickText) {
                        promptPassword = ""
                        promptAction = .terminal
                        promptIsQuick = true
                        promptServer = server
                    }
                }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text("Например root@203.0.113.10 или admin@my.server:2222")
            }
            .confirmationDialog(
                "Удалить сервер?",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible,
                presenting: deleting
            ) { server in
                Button("Удалить «\(server.title)»", role: .destructive) {
                    store.delete(server)
                    deleting = nil
                }
                Button("Отмена", role: .cancel) { deleting = nil }
            } message: { server in
                Text("Настройки и сохранённый пароль для \(server.subtitle) будут удалены с этого устройства.")
            }
            .onChange(of: router.request) { _, request in
                handle(request)
            }
            .onAppear {
                handle(router.request)
            }
        }
    }

    // MARK: Части экрана

    private var quickConnectPill: some View {
        Button(action: openQuickConnect) {
            HStack(spacing: 10) {
                Image(systemName: "bolt.fill")
                    .foregroundStyle(Color.accentColor)
                Text("Быстрое подключение")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                Text(verbatim: "user@host:port")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Нет серверов", systemImage: "server.rack")
        } description: {
            Text("Добавьте свой VPS или воспользуйтесь быстрым подключением.")
        } actions: {
            Button {
                creatingNew = true
            } label: {
                Label("Добавить сервер", systemImage: "plus")
                    .padding(.horizontal, 6)
            }
            .glassButtonStyle(prominent: true)
            Button {
                openQuickConnect()
            } label: {
                Label("Быстрое подключение", systemImage: "bolt")
                    .padding(.horizontal, 6)
            }
            .glassButtonStyle()
        }
    }

    @ViewBuilder
    private func menu(for server: Server) -> some View {
        Button { start(server, action: .terminal) } label: { Label("Терминал", systemImage: "terminal") }
        Button { start(server, action: .sftp) } label: { Label("Файлы (SFTP)", systemImage: "folder") }
        Button { start(server, action: .monitor) } label: { Label("Мониторинг", systemImage: "chart.xyaxis.line") }
        Divider()
        Button { editing = server } label: { Label("Изменить", systemImage: "pencil") }
        Button {
            var copy = server
            copy.id = UUID()
            copy.name = server.title + " (копия)"
            copy.lastConnected = nil
            for i in copy.forwards.indices { copy.forwards[i].id = UUID() }
            store.upsert(copy)
            if let pw = store.password(for: server) { store.setPassword(pw, for: copy) }
            if let pw = store.proxyPassword(for: server) { store.setProxyPassword(pw, for: copy) }
        } label: { Label("Дублировать", systemImage: "plus.square.on.square") }
        Button {
            UIPasteboard.general.string = "ssh \(server.username)@\(server.hostname)" + (server.port == 22 ? "" : " -p \(server.port)")
        } label: { Label("Скопировать команду ssh", systemImage: "doc.on.doc") }
        Divider()
        Button(role: .destructive) { deleting = server } label: { Label("Удалить", systemImage: "trash") }
    }

    // MARK: Действия

    private func openQuickConnect() {
        quickText = ""
        askQuick = true
    }

    private func handle(_ request: RouterRequest?) {
        guard let request else { return }
        router.request = nil
        switch request {
        case .quickConnect:
            openQuickConnect()
        case .newServer:
            creatingNew = true
        case .connect(let id):
            if let server = store.host(id) {
                start(server, action: .terminal)
            }
        }
    }

    private func start(_ server: Server, action: PendingAction) {
        if server.auth == .password && store.password(for: server) == nil {
            promptPassword = ""
            promptAction = action
            promptIsQuick = false
            promptServer = server
            return
        }
        launch(server, password: nil, action: action)
    }

    private func finishPrompt(save: Bool) {
        guard let server = promptServer else { return }
        let pw = promptPassword
        let isQuick = promptIsQuick
        promptServer = nil
        promptPassword = ""
        promptIsQuick = false
        if save {
            if isQuick { store.upsert(server) }
            if !pw.isEmpty { store.setPassword(pw, for: server) }
        }
        launch(server, password: pw, action: promptAction)
    }

    private func launch(_ server: Server, password: String?, action: PendingAction) {
        switch action {
        case .terminal:
            let session = sessions.open(server, password: password)
            router.openTerminal(session.id)
        case .sftp:
            sftpTarget = ConnectTarget(server: server, password: password)
        case .monitor:
            monitorTarget = ConnectTarget(server: server, password: password)
        }
    }
}

struct HostRow: View {
    let server: Server

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(server.color.gradient)
                    .frame(width: 42, height: 42)
                Image(systemName: "server.rack")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.black.opacity(0.75))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(server.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(verbatim: server.subtitle)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                if server.useTmux { badge("rectangle.split.3x1") }
                if server.jumpHostID != nil { badge("arrow.triangle.branch") }
                if server.proxy != nil { badge("network") }
                if !server.forwards.isEmpty { badge("arrow.left.arrow.right") }
                Image(systemName: server.auth == .key ? "key.fill" : "lock.fill")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    private func badge(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}

struct SessionRow: View {
    @ObservedObject var session: TerminalSession

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(color)
                .frame(width: 9, height: 9)
                .shadow(color: color.opacity(0.7), radius: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.server.title).font(.body.weight(.medium))
                Text(verbatim: session.title == session.server.title ? session.server.subtitle : session.title)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text(session.startedAt, style: .relative)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var color: Color {
        switch session.state {
        case .connecting: return .orange
        case .connected: return .green
        case .closed: return .red
        }
    }
}
