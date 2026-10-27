import SwiftUI

/// Туннели (пробросы портов) текущей SSH-сессии.
struct TunnelsView: View {
    @ObservedObject var session: TerminalSession
    @ObservedObject private var manager = TunnelManager.shared
    @ObservedObject private var store = Store.shared
    @Environment(\.dismiss) private var dismiss

    /// Пробросы для серверов, которых нет в списке (быстрое подключение).
    @State private var transientForwards: [PortForward]
    @State private var editing: PortForward?
    @State private var browser: IdentifiedURL?
    @State private var copiedID: UUID?

    init(session: TerminalSession) {
        _session = ObservedObject(wrappedValue: session)
        _transientForwards = State(initialValue: session.server.forwards)
    }

    private var isSavedServer: Bool { store.host(session.server.id) != nil }

    private var forwards: [PortForward] {
        if let saved = store.host(session.server.id) { return saved.forwards }
        return transientForwards
    }

    var body: some View {
        ZStack {
            AuroraBackground()
            ScrollView {
                VStack(spacing: 14) {
                    intro
                    if !session.isAlive || session.connection == nil {
                        notConnectedBanner
                    }
                    if forwards.isEmpty {
                        emptyState
                    } else {
                        GlassGroup(spacing: 14) {
                            VStack(spacing: 12) {
                                ForEach(forwards) { forward in
                                    TunnelCard(
                                        forward: forward,
                                        isActive: manager.isActive(forward.id),
                                        isStarting: manager.isStarting(forward.id),
                                        copied: copiedID == forward.id,
                                        onToggle: { toggle(forward, on: $0) },
                                        onOpen: { open(forward) },
                                        onCopy: { copy(forward) },
                                        onEdit: { editing = forward },
                                        onDelete: { delete(forward) }
                                    )
                                }
                            }
                        }
                    }
                    Button {
                        editing = PortForward()
                    } label: {
                        Label("Добавить туннель", systemImage: "plus")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                    .glassButtonStyle(prominent: true)
                    .controlSize(.large)
                    .padding(.top, 4)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        }
        .navigationTitle("Туннели")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Готово") { dismiss() }
            }
        }
        .sheet(item: $editing) { forward in
            NavigationStack {
                PortForwardEditor(forward: forward, isNew: !forwards.contains { $0.id == forward.id }) { saved in
                    save(saved)
                } onDelete: {
                    delete(forward)
                }
            }
        }
        .sheet(item: $browser) { item in
            SafariView(url: item.url)
                .ignoresSafeArea()
        }
        .alert("Туннель", isPresented: Binding(
            get: { manager.lastError != nil },
            set: { if !$0 { manager.lastError = nil } }
        )) {
            Button("OK", role: .cancel) { manager.lastError = nil }
        } message: {
            Text(manager.lastError ?? "")
        }
    }

    // MARK: Части экрана

    private var intro: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.title2)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("Проброс портов")
                    .font(.headline)
                Text("Порт на iPhone (127.0.0.1) ведёт через SSH на адрес со стороны сервера. Удобно для веб-панелей и баз данных, закрытых от интернета. Туннели работают, пока Termuxx открыт.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(cornerRadius: 22)
    }

    private var notConnectedBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "bolt.horizontal.circle")
                .foregroundStyle(.orange)
            Text("Сессия не подключена. Туннели с автозапуском откроются после подключения.")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassCard(cornerRadius: 18, tint: .orange.opacity(0.18))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "network")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Туннелей пока нет")
                .font(.headline)
            Text("Например: локальный 8080 → 127.0.0.1:80 откроет веб-панель сервера по адресу http://127.0.0.1:8080")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .glassCard(cornerRadius: 22)
    }

    // MARK: Действия

    private func toggle(_ forward: PortForward, on: Bool) {
        if on {
            Task { await manager.start(forward, session: session) }
        } else {
            manager.stop(forward.id)
        }
    }

    private func open(_ forward: PortForward) {
        guard let url = forward.localURL else { return }
        browser = IdentifiedURL(url: url)
    }

    private func copy(_ forward: PortForward) {
        UIPasteboard.general.string = "127.0.0.1:\(forward.localPort)"
        copiedID = forward.id
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if copiedID == forward.id { copiedID = nil }
        }
    }

    private func save(_ forward: PortForward) {
        let wasActive = manager.isActive(forward.id)
        if wasActive { manager.stop(forward.id) }
        if var server = store.host(session.server.id) {
            if let i = server.forwards.firstIndex(where: { $0.id == forward.id }) {
                server.forwards[i] = forward
            } else {
                server.forwards.append(forward)
            }
            store.upsert(server)
        } else if let i = transientForwards.firstIndex(where: { $0.id == forward.id }) {
            transientForwards[i] = forward
        } else {
            transientForwards.append(forward)
        }
        // Сессия хранит копию сервера, поэтому запускаем туннель напрямую.
        if wasActive || forward.autoStart {
            Task { await manager.start(forward, session: session) }
        }
    }

    private func delete(_ forward: PortForward) {
        manager.stop(forward.id)
        if var server = store.host(session.server.id) {
            server.forwards.removeAll { $0.id == forward.id }
            store.upsert(server)
        } else {
            transientForwards.removeAll { $0.id == forward.id }
        }
    }
}

/// Карточка одного туннеля.
private struct TunnelCard: View {
    let forward: PortForward
    let isActive: Bool
    let isStarting: Bool
    let copied: Bool
    let onToggle: (Bool) -> Void
    let onOpen: () -> Void
    let onCopy: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle()
                        .fill((isActive ? Color.green : Color.secondary).opacity(0.18))
                        .frame(width: 38, height: 38)
                    Image(systemName: isActive ? "antenna.radiowaves.left.and.right" : "pause.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(isActive ? Color.green : Color.secondary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(forward.name.isEmpty ? "Порт \(forward.localPort)" : forward.name)
                        .font(.headline)
                        .lineLimit(1)
                    Text("127.0.0.1:\(forward.localPort) → \(forward.remoteHost):\(forward.remotePort)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    statusLine
                }
                Spacer(minLength: 4)
                if isStarting {
                    ProgressView()
                        .padding(.top, 6)
                } else {
                    Toggle("", isOn: Binding(get: { isActive }, set: onToggle))
                        .labelsHidden()
                }
            }

            if isActive {
                HStack(spacing: 10) {
                    Button(action: onOpen) {
                        Label("Открыть", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButtonStyle()
                    Button(action: onCopy) {
                        Label(copied ? "Скопировано" : "Адрес", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButtonStyle()
                }
                .font(.subheadline.weight(.medium))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(16)
        .glassCard(cornerRadius: 22, tint: isActive ? Color.green.opacity(0.10) : nil)
        .contextMenu {
            Button(action: onEdit) { Label("Изменить", systemImage: "pencil") }
            if isActive {
                Button(action: onOpen) { Label("Открыть в браузере", systemImage: "safari") }
                Button(action: onCopy) { Label("Скопировать адрес", systemImage: "doc.on.doc") }
            }
            Button(role: .destructive, action: onDelete) { Label("Удалить", systemImage: "trash") }
        }
        .onTapGesture(perform: onEdit)
        .animation(.spring(duration: 0.3), value: isActive)
    }

    @ViewBuilder
    private var statusLine: some View {
        if isActive {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                let count = TunnelManager.shared.connectionCount(forward.id)
                Text(count == 0 ? "Работает · нет подключений" : "Работает · подключений: \(count)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.green)
            }
        } else {
            Text(forward.autoStart ? "Остановлен · автозапуск включён" : "Остановлен")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

/// Редактор проброса порта. Можно использовать и из настроек сервера.
struct PortForwardEditor: View {
    @State private var forward: PortForward
    @State private var localPort: String
    @State private var remotePort: String
    let isNew: Bool
    let onSave: (PortForward) -> Void
    var onDelete: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    init(forward: PortForward, isNew: Bool, onSave: @escaping (PortForward) -> Void, onDelete: (() -> Void)? = nil) {
        _forward = State(initialValue: forward)
        _localPort = State(initialValue: String(forward.localPort))
        _remotePort = State(initialValue: String(forward.remotePort))
        self.isNew = isNew
        self.onSave = onSave
        self.onDelete = onDelete
    }

    private var localValue: Int? { Int(localPort).flatMap { (1...65535).contains($0) ? $0 : nil } }
    private var remoteValue: Int? { Int(remotePort).flatMap { (1...65535).contains($0) ? $0 : nil } }
    private var isValid: Bool {
        localValue != nil && remoteValue != nil && !forward.remoteHost.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        Form {
            Section("Название") {
                TextField("Например, Веб-панель", text: $forward.name)
            }
            Section {
                LabeledContent("Порт на iPhone") {
                    TextField("8080", text: $localPort)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                }
            } header: {
                Text("Локально")
            } footer: {
                if let port = localValue, port < 1024 {
                    Text("Порты ниже 1024 iOS может не разрешить — лучше взять 8080, 8443 и т.п.")
                } else {
                    Text("Откроется как 127.0.0.1:\(localPort.isEmpty ? "…" : localPort)")
                }
            }
            Section {
                LabeledContent("Адрес") {
                    TextField("127.0.0.1", text: $forward.remoteHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("Порт") {
                    TextField("80", text: $remotePort)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                }
            } header: {
                Text("Со стороны сервера")
            } footer: {
                Text("127.0.0.1 — сам сервер. Можно указать и другой адрес, доступный серверу (например, 10.0.0.5).")
            }
            Section {
                Toggle("Запускать автоматически", isOn: $forward.autoStart)
            } footer: {
                Text("Туннель откроется сразу после подключения к серверу.")
            }
            Section("Шаблоны") {
                templateButton("Веб-панель", local: 8080, remote: 80)
                templateButton("HTTPS-панель", local: 8443, remote: 443)
                templateButton("PostgreSQL", local: 5432, remote: 5432)
                templateButton("MySQL", local: 3306, remote: 3306)
                templateButton("Redis", local: 6379, remote: 6379)
            }
            if !isNew, let onDelete {
                Section {
                    Button("Удалить туннель", role: .destructive) {
                        onDelete()
                        dismiss()
                    }
                }
            }
        }
        .navigationTitle(isNew ? "Новый туннель" : "Туннель")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Отмена") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Сохранить") {
                    var result = forward
                    result.localPort = localValue ?? forward.localPort
                    result.remotePort = remoteValue ?? forward.remotePort
                    result.remoteHost = forward.remoteHost.trimmingCharacters(in: .whitespaces)
                    result.name = forward.name.trimmingCharacters(in: .whitespaces)
                    onSave(result)
                    dismiss()
                }
                .disabled(!isValid)
            }
        }
    }

    private func templateButton(_ title: String, local: Int, remote: Int) -> some View {
        Button {
            if forward.name.isEmpty { forward.name = title }
            localPort = String(local)
            remotePort = String(remote)
            if forward.remoteHost.isEmpty { forward.remoteHost = "127.0.0.1" }
        } label: {
            HStack {
                Text(title)
                    .foregroundStyle(.primary)
                Spacer()
                Text("\(local) → \(remote)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
    }
}
