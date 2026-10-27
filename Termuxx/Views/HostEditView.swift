import SwiftUI

struct HostEditView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss

    private let isNew: Bool
    @State private var server: Server
    @State private var password = ""
    @State private var portText: String
    @State private var proxyPortText: String
    @State private var proxyPassword = ""
    @State private var editingForward: PortForward?
    @State private var confirmDelete = false

    init(server: Server?) {
        isNew = server == nil
        let s = server ?? Server()
        _server = State(initialValue: s)
        _portText = State(initialValue: String(s.port))
        _proxyPortText = State(initialValue: String(s.proxy?.port ?? 1080))
    }

    static func parsePort(_ text: String) -> Int? {
        guard let value = Int(text.trimmingCharacters(in: .whitespaces)), (1...65535).contains(value) else { return nil }
        return value
    }

    private var jumpCandidates: [Server] {
        store.hosts.filter { $0.id != server.id }
    }

    private var proxyActive: Bool { server.proxy != nil && server.jumpHostID == nil }

    private var canSave: Bool {
        guard !server.hostname.trimmingCharacters(in: .whitespaces).isEmpty,
              Self.parsePort(portText) != nil else { return false }
        if proxyActive {
            guard !(server.proxy?.host ?? "").trimmingCharacters(in: .whitespaces).isEmpty,
                  Self.parsePort(proxyPortText) != nil else { return false }
        }
        return true
    }

    // MARK: Привязки для прокси

    private var proxyEnabled: Binding<Bool> {
        Binding(
            get: { server.proxy != nil },
            set: { enabled in server.proxy = enabled ? (server.proxy ?? ProxyConfig()) : nil }
        )
    }

    private var proxyHost: Binding<String> {
        Binding(get: { server.proxy?.host ?? "" }, set: { server.proxy?.host = $0 })
    }

    private var proxyUser: Binding<String> {
        Binding(get: { server.proxy?.username ?? "" }, set: { server.proxy?.username = $0 })
    }

    var body: some View {
        Form {
            Section("Сервер") {
                LabeledContent("Название") {
                    TextField("Мой VPS", text: $server.name)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("Адрес") {
                    TextField("IP или домен", text: $server.hostname)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                LabeledContent("Порт") {
                    TextField("22", text: $portText)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.numberPad)
                        .foregroundStyle(Self.parsePort(portText) == nil ? Color.red : Color.primary)
                }
                LabeledContent("Пользователь") {
                    TextField("root", text: $server.username)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }

            Section {
                Picker("Вход", selection: $server.auth) {
                    ForEach(AuthMethod.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)

                switch server.auth {
                case .password:
                    SecureField("Пароль (пусто — спрашивать)", text: $password)
                case .key:
                    if store.keys.isEmpty {
                        Text("Ключей пока нет. Создайте или импортируйте ключ во вкладке «Ключи».")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Ключ", selection: $server.keyID) {
                            Text("Не выбран").tag(UUID?.none)
                            ForEach(store.keys) { key in
                                Text("\(key.name) · \(key.type)").tag(UUID?.some(key.id))
                            }
                        }
                    }
                }
            } header: {
                Text("Авторизация")
            } footer: {
                Text("Пароли и ключи хранятся только в Keychain этого устройства.")
            }

            Section {
                Toggle(isOn: $server.useTmux) {
                    Label("Работать через tmux", systemImage: "rectangle.split.3x1")
                }
                Toggle(isOn: $server.autoReconnect) {
                    Label("Автопереподключение", systemImage: "arrow.triangle.2.circlepath")
                }
                Toggle(isOn: $server.keepAlive) {
                    Label("Keep-alive", systemImage: "waveform.path.ecg")
                }
            } header: {
                Text("Сессия")
            } footer: {
                Text("tmux — после переподключения вы попадёте в ту же сессию: открытые программы и вывод сохранятся. На сервере должен быть tmux (apt install tmux).\nАвтопереподключение — при обрыве связи и при возврате в приложение.\nKeep-alive — не даёт роутерам и NAT обрывать простаивающее соединение.")
            }

            Section {
                Picker("Через сервер", selection: $server.jumpHostID) {
                    Text("Напрямую").tag(UUID?.none)
                    ForEach(jumpCandidates) { candidate in
                        Text(candidate.title).tag(UUID?.some(candidate.id))
                    }
                }
                Toggle("SOCKS5-прокси", isOn: proxyEnabled)
                    .disabled(server.jumpHostID != nil)
                if proxyActive {
                    LabeledContent("Хост прокси") {
                        TextField("proxy.example.com", text: proxyHost)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                    LabeledContent("Порт прокси") {
                        TextField("1080", text: $proxyPortText)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numberPad)
                            .foregroundStyle(Self.parsePort(proxyPortText) == nil ? Color.red : Color.primary)
                    }
                    LabeledContent("Логин") {
                        TextField("необязательно", text: proxyUser)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    LabeledContent("Пароль") {
                        SecureField("необязательно", text: $proxyPassword)
                            .multilineTextAlignment(.trailing)
                    }
                }
            } header: {
                Text("Маршрут")
            } footer: {
                Text(routeFooter)
            }

            Section {
                ForEach(server.forwards) { forward in
                    Button { editingForward = forward } label: {
                        HostForwardRow(forward: forward)
                    }
                }
                .onDelete { server.forwards.remove(atOffsets: $0) }
                Button {
                    editingForward = PortForward(localPort: suggestedLocalPort())
                } label: {
                    Label("Добавить проброс", systemImage: "plus.circle")
                }
            } header: {
                Text("Проброс портов")
            } footer: {
                Text("Порт открывается на телефоне (127.0.0.1), пока подключён терминал этого сервера. Веб-панели можно открыть во встроенном браузере.")
            }

            Section("Дополнительно") {
                Picker("Команда при входе", selection: $server.startupSnippetID) {
                    Text("Нет").tag(UUID?.none)
                    ForEach(store.snippets) { s in
                        Text(s.name).tag(UUID?.some(s.id))
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Цвет")
                    HStack(spacing: 10) {
                        ForEach(HostColor.palette, id: \.self) { hex in
                            Circle()
                                .fill(Color(hex: hex))
                                .frame(width: 28, height: 28)
                                .overlay {
                                    if server.colorHex == hex {
                                        Image(systemName: "checkmark")
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(.black.opacity(0.7))
                                    }
                                }
                                .onTapGesture { server.colorHex = hex }
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            if let fingerprint = store.knownHosts[server.knownHostsKey] {
                Section {
                    Text(verbatim: fingerprint)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                    Button("Забыть ключ сервера", role: .destructive) {
                        store.knownHosts[server.knownHostsKey] = nil
                    }
                } header: {
                    Text("Отпечаток ключа сервера")
                } footer: {
                    Text("Сбросьте, только если переустанавливали сервер. Иначе это может быть подмена.")
                }
            }

            if !isNew {
                Section {
                    Button("Удалить сервер", role: .destructive) {
                        confirmDelete = true
                    }
                }
            }
        }
        .navigationTitle(isNew ? "Новый сервер" : "Изменить")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Отмена") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Сохранить", action: save)
                    .disabled(!canSave)
            }
        }
        .sheet(item: $editingForward) { forward in
            NavigationStack {
                HostForwardEditor(
                    forward: forward,
                    isNew: !server.forwards.contains(where: { $0.id == forward.id }),
                    otherForwards: server.forwards.filter { $0.id != forward.id }
                ) { updated in
                    if let i = server.forwards.firstIndex(where: { $0.id == updated.id }) {
                        server.forwards[i] = updated
                    } else {
                        server.forwards.append(updated)
                    }
                } onDelete: { id in
                    server.forwards.removeAll { $0.id == id }
                }
            }
        }
        .confirmationDialog("Удалить сервер?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive) {
                store.delete(server)
                dismiss()
            }
            Button("Отмена", role: .cancel) {}
        }
        .onAppear {
            if !isNew {
                password = store.password(for: server) ?? ""
                proxyPassword = store.proxyPassword(for: server) ?? ""
            }
        }
    }

    private var routeFooter: String {
        if let jumpID = server.jumpHostID, let jump = store.host(jumpID) {
            return "Подключение пойдёт через «\(jump.title)» (как ssh -J). Пароль или ключ промежуточного сервера должен быть сохранён. SOCKS5 при этом не используется."
        }
        return "Можно подключаться через другой свой сервер (ssh -J) или через SOCKS5-прокси — например, если прямой доступ к серверу закрыт."
    }

    private func suggestedLocalPort() -> Int {
        let used = Set(server.forwards.map(\.localPort))
        var port = 8080
        while used.contains(port) { port += 1 }
        return port
    }

    private func save() {
        server.hostname = server.hostname.trimmingCharacters(in: .whitespacesAndNewlines)
        server.username = server.username.trimmingCharacters(in: .whitespacesAndNewlines)
        if server.username.isEmpty { server.username = "root" }
        server.port = Self.parsePort(portText) ?? 22
        if server.jumpHostID == server.id { server.jumpHostID = nil }
        if var proxy = server.proxy {
            proxy.host = proxy.host.trimmingCharacters(in: .whitespacesAndNewlines)
            proxy.username = proxy.username.trimmingCharacters(in: .whitespacesAndNewlines)
            proxy.port = Self.parsePort(proxyPortText) ?? 1080
            server.proxy = proxy.host.isEmpty ? nil : proxy
        }
        store.upsert(server)
        if server.auth == .password {
            store.setPassword(password.isEmpty ? nil : password, for: server)
        }
        store.setProxyPassword(server.proxy == nil || proxyPassword.isEmpty ? nil : proxyPassword, for: server)
        dismiss()
    }
}

// MARK: - Проброс портов

struct HostForwardRow: View {
    let forward: PortForward

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.left.arrow.right.circle.fill")
                .font(.title3)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: forward.name.isEmpty ? "Порт \(forward.localPort)" : forward.name)
                    .foregroundStyle(.primary)
                Text(verbatim: "localhost:\(forward.localPort) → \(forward.remoteHost):\(forward.remotePort)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if forward.autoStart {
                Text("авто")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.accentColor.opacity(0.15), in: Capsule())
            }
        }
    }
}

struct HostForwardEditor: View {
    @Environment(\.dismiss) private var dismiss

    private let isNew: Bool
    private let otherForwards: [PortForward]
    private let onSave: (PortForward) -> Void
    private let onDelete: ((UUID) -> Void)?

    @State private var forward: PortForward
    @State private var localText: String
    @State private var remoteText: String

    private struct Preset: Identifiable {
        var id: String { name }
        let name: String
        let remotePort: Int
        let localPort: Int
    }

    private let presets: [Preset] = [
        Preset(name: "Веб-сервер", remotePort: 80, localPort: 8080),
        Preset(name: "HTTPS", remotePort: 443, localPort: 8443),
        Preset(name: "Grafana", remotePort: 3000, localPort: 3000),
        Preset(name: "Portainer", remotePort: 9000, localPort: 9000),
        Preset(name: "Proxmox", remotePort: 8006, localPort: 8006),
        Preset(name: "PostgreSQL", remotePort: 5432, localPort: 5432),
        Preset(name: "MySQL", remotePort: 3306, localPort: 3306),
        Preset(name: "Redis", remotePort: 6379, localPort: 6379),
    ]

    init(forward: PortForward, isNew: Bool, otherForwards: [PortForward],
         onSave: @escaping (PortForward) -> Void, onDelete: ((UUID) -> Void)? = nil) {
        self.isNew = isNew
        self.otherForwards = otherForwards
        self.onSave = onSave
        self.onDelete = onDelete
        _forward = State(initialValue: forward)
        _localText = State(initialValue: String(forward.localPort))
        _remoteText = State(initialValue: String(forward.remotePort))
    }

    private var localPort: Int? { HostEditView.parsePort(localText) }
    private var remotePort: Int? { HostEditView.parsePort(remoteText) }
    private var localPortTaken: Bool {
        guard let port = localPort else { return false }
        return otherForwards.contains { $0.localPort == port }
    }

    private var problem: String? {
        if localPort == nil { return "Локальный порт должен быть от 1 до 65535." }
        if localPortTaken { return "Этот локальный порт уже используется другим пробросом." }
        if forward.remoteHost.trimmingCharacters(in: .whitespaces).isEmpty { return "Укажите адрес на стороне сервера." }
        if remotePort == nil { return "Порт на сервере должен быть от 1 до 65535." }
        return nil
    }

    var body: some View {
        Form {
            Section {
                Menu {
                    ForEach(presets) { preset in
                        Button("\(preset.name) — порт \(String(preset.remotePort))") {
                            forward.name = preset.name
                            remoteText = String(preset.remotePort)
                            localText = String(preset.localPort)
                            if forward.remoteHost.isEmpty { forward.remoteHost = "127.0.0.1" }
                        }
                    }
                } label: {
                    Label("Заполнить по шаблону", systemImage: "wand.and.stars")
                }
            }

            Section("Название") {
                TextField("Например, Веб-панель", text: $forward.name)
            }

            Section {
                LabeledContent("Порт на телефоне") {
                    TextField("8080", text: $localText)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.numberPad)
                }
            } header: {
                Text("На телефоне")
            } footer: {
                Text(verbatim: "Откроется как 127.0.0.1:\(localPort.map { String($0) } ?? "…"). Лучше использовать порты от 1024.")
            }

            Section {
                LabeledContent("Адрес") {
                    TextField("127.0.0.1", text: $forward.remoteHost)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                LabeledContent("Порт") {
                    TextField("80", text: $remoteText)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.numberPad)
                }
            } header: {
                Text("На стороне сервера")
            } footer: {
                Text("127.0.0.1 — сам сервер. Можно указать и другую машину из его сети.")
            }

            Section {
                Toggle("Запускать при подключении", isOn: $forward.autoStart)
            }

            if let problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .font(.footnote)
                }
            }

            if !isNew, let onDelete {
                Section {
                    Button("Удалить проброс", role: .destructive) {
                        onDelete(forward.id)
                        dismiss()
                    }
                }
            }
        }
        .navigationTitle(isNew ? "Новый проброс" : "Проброс порта")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Отмена") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Готово") {
                    var result = forward
                    result.localPort = localPort ?? result.localPort
                    result.remotePort = remotePort ?? result.remotePort
                    result.remoteHost = result.remoteHost.trimmingCharacters(in: .whitespacesAndNewlines)
                    result.name = result.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    onSave(result)
                    dismiss()
                }
                .disabled(problem != nil)
            }
        }
    }
}
