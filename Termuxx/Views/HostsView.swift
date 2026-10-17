import SwiftUI

enum Route: Hashable {
    case terminal(UUID)
}

private enum PendingAction {
    case terminal
    case sftp
}

struct HostsView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var sessions: SessionManager

    @State private var path: [Route] = []
    @State private var search = ""
    @State private var editing: Server?
    @State private var creatingNew = false

    @State private var promptServer: Server?
    @State private var promptAction: PendingAction = .terminal
    @State private var promptPassword = ""

    @State private var askQuick = false
    @State private var quickText = ""

    @State private var sftpTarget: SFTPTarget?

    private var filtered: [Server] {
        let list = store.hosts.sorted { ($0.lastConnected ?? .distantPast) > ($1.lastConnected ?? .distantPast) }
        guard !search.isEmpty else { return list }
        return list.filter {
            $0.title.localizedCaseInsensitiveContains(search) || $0.hostname.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
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

                Section(store.hosts.isEmpty ? "" : "Серверы") {
                    ForEach(filtered) { server in
                        Button { start(server, action: .terminal) } label: {
                            HostRow(server: server)
                        }
                        .contextMenu { menu(for: server) }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { store.delete(server) } label: {
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
                        }
                    }
                }
            }
            .overlay {
                if store.hosts.isEmpty && sessions.sessions.isEmpty {
                    ContentUnavailableView {
                        Label("Нет серверов", systemImage: "server.rack")
                    } description: {
                        Text("Добавьте свой VPS или воспользуйтесь быстрым подключением.")
                    } actions: {
                        Button("Добавить сервер") { creatingNew = true }
                            .buttonStyle(.borderedProminent)
                        Button("Быстрое подключение") { quickText = ""; askQuick = true }
                    }
                }
            }
            .searchable(text: $search, prompt: "Поиск серверов")
            .navigationTitle("Termuxx")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { creatingNew = true } label: { Label("Новый сервер", systemImage: "plus") }
                        Button { quickText = ""; askQuick = true } label: { Label("Быстрое подключение", systemImage: "bolt") }
                    } label: {
                        Image(systemName: "plus.circle.fill").font(.title3)
                    }
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .terminal(let id):
                    if let session = sessions.session(id) {
                        TerminalScreen(session: session)
                    } else {
                        ContentUnavailableView("Сессия закрыта", systemImage: "xmark.circle")
                    }
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
            .alert("Пароль для \(promptServer?.subtitle ?? "")", isPresented: Binding(
                get: { promptServer != nil },
                set: { if !$0 { promptServer = nil } }
            )) {
                SecureField("Пароль", text: $promptPassword)
                Button("Подключиться") { finishPrompt(save: false) }
                if let s = promptServer, store.hosts.contains(where: { $0.id == s.id }) {
                    Button("Подключиться и сохранить") { finishPrompt(save: true) }
                }
                Button("Отмена", role: .cancel) { promptServer = nil }
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
                        promptServer = server
                    }
                }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text("Например root@203.0.113.10 или admin@my.server:2222")
            }
        }
    }

    @ViewBuilder
    private func menu(for server: Server) -> some View {
        Button { start(server, action: .terminal) } label: { Label("Терминал", systemImage: "terminal") }
        Button { start(server, action: .sftp) } label: { Label("Файлы (SFTP)", systemImage: "folder") }
        Divider()
        Button { editing = server } label: { Label("Изменить", systemImage: "pencil") }
        Button {
            var copy = server
            copy.id = UUID()
            copy.name = server.title + " (копия)"
            copy.lastConnected = nil
            store.upsert(copy)
        } label: { Label("Дублировать", systemImage: "plus.square.on.square") }
        Button {
            UIPasteboard.general.string = "ssh \(server.username)@\(server.hostname)" + (server.port == 22 ? "" : " -p \(server.port)")
        } label: { Label("Скопировать команду ssh", systemImage: "doc.on.doc") }
        Divider()
        Button(role: .destructive) { store.delete(server) } label: { Label("Удалить", systemImage: "trash") }
    }

    private func start(_ server: Server, action: PendingAction) {
        if server.auth == .password && store.password(for: server) == nil {
            promptPassword = ""
            promptAction = action
            promptServer = server
            return
        }
        launch(server, password: nil, action: action)
    }

    private func finishPrompt(save: Bool) {
        guard let server = promptServer else { return }
        let pw = promptPassword
        promptServer = nil
        if save { store.setPassword(pw, for: server) }
        launch(server, password: pw, action: promptAction)
    }

    private func launch(_ server: Server, password: String?, action: PendingAction) {
        switch action {
        case .terminal:
            let session = sessions.open(server, password: password)
            path.append(.terminal(session.id))
        case .sftp:
            sftpTarget = SFTPTarget(server: server, password: password)
        }
    }
}

struct SFTPTarget: Identifiable {
    let id = UUID()
    let server: Server
    let password: String?
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
                Text(server.subtitle)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: server.auth == .key ? "key.fill" : "lock.fill")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
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
                Text(session.title == session.server.title ? session.server.subtitle : session.title)
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
