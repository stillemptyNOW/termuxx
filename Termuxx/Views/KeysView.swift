import SwiftUI
import UniformTypeIdentifiers
import Citadel
import NIO

struct KeysView: View {
    @EnvironmentObject var store: Store
    @State private var showImport = false
    @State private var showFileImport = false
    @State private var importText = ""
    @State private var askGenerateName = false
    @State private var newName = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.keys) { key in
                    NavigationLink {
                        KeyDetailView(key: key)
                    } label: {
                        KeyRow(key: key)
                    }
                }
                .onDelete { idx in
                    let items = idx.map { store.keys[$0] }
                    for item in items { store.deleteKey(item) }
                }
            }
            .overlay {
                if store.keys.isEmpty {
                    ContentUnavailableView {
                        Label("Нет ключей", systemImage: "key")
                    } description: {
                        Text("Вход по ключу надёжнее пароля. Создайте ключ и установите его на сервер в одно касание.")
                    } actions: {
                        Button {
                            newName = "termuxx"
                            askGenerateName = true
                        } label: {
                            Label("Создать ключ", systemImage: "wand.and.stars")
                                .padding(.horizontal, 6)
                        }
                        .glassButtonStyle(prominent: true)
                        Button {
                            importText = UIPasteboard.general.string ?? ""
                            showImport = true
                        } label: {
                            Label("Импортировать", systemImage: "square.and.arrow.down")
                                .padding(.horizontal, 6)
                        }
                        .glassButtonStyle()
                    }
                }
            }
            .navigationTitle("Ключи")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { newName = "termuxx"; askGenerateName = true } label: {
                            Label("Создать Ed25519", systemImage: "wand.and.stars")
                        }
                        Button { importText = ""; showImport = true } label: {
                            Label("Вставить ключ", systemImage: "doc.on.clipboard")
                        }
                        Button { showFileImport = true } label: {
                            Label("Импорт из файла", systemImage: "folder")
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .alert("Имя ключа", isPresented: $askGenerateName) {
                TextField("Имя", text: $newName)
                Button("Создать") { generate() }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text("Будет создан ключ Ed25519. Приватная часть останется в Keychain этого устройства.")
            }
            .sheet(isPresented: $showImport) {
                NavigationStack {
                    ImportKeyView(text: importText)
                }
            }
            .fileImporter(isPresented: $showFileImport, allowedContentTypes: [.item]) { result in
                guard case .success(let url) = result else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let text = try? String(contentsOf: url, encoding: .utf8) {
                    importText = text
                    showImport = true
                } else {
                    error = "Не удалось прочитать файл."
                }
            }
            .alert("Ошибка", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }

    private func generate() {
        let name = newName.trimmingCharacters(in: .whitespaces).isEmpty ? "termuxx" : newName
        let pair = KeyTools.generateEd25519(comment: name)
        store.addKey(SSHKeyItem(name: name, type: "ED25519", publicKey: pair.publicKey), privateKey: pair.privateKey)
    }
}

struct KeyRow: View {
    let key: SSHKeyItem

    var body: some View {
        HStack(spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: "key.horizontal.fill")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 32, height: 32)
                if key.encrypted == true {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.orange)
                        .offset(x: 2, y: 2)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(key.name).font(.body.weight(.semibold))
                Text(verbatim: "\(key.type) · \(key.created.formatted(date: .abbreviated, time: .omitted))" + (key.encrypted == true ? " · с паролем" : ""))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct ImportKeyView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State var text: String
    @State private var name = ""
    @State private var passphrase = ""
    @State private var error: String?

    private var isEncrypted: Bool { KeyTools.isEncrypted(text) }

    var body: some View {
        Form {
            Section("Имя") {
                TextField("Например, laptop", text: $name)
            }
            Section {
                TextEditor(text: $text)
                    .font(.caption.monospaced())
                    .frame(minHeight: 220)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    text = UIPasteboard.general.string ?? ""
                } label: {
                    Label("Вставить из буфера", systemImage: "doc.on.clipboard")
                }
            } header: {
                Text("Приватный ключ")
            } footer: {
                Text("Формат OpenSSH (-----BEGIN OPENSSH PRIVATE KEY-----). Поддерживаются Ed25519 и RSA, в том числе защищённые паролем.")
            }
            if isEncrypted {
                Section {
                    SecureField("Пароль от ключа", text: $passphrase)
                } header: {
                    Label("Ключ защищён паролем", systemImage: "lock.fill")
                } footer: {
                    Text("Пароль сохранится в Keychain, чтобы не вводить его при каждом подключении.")
                }
            }
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.footnote)
                }
            }
        }
        .navigationTitle("Импорт ключа")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Сохранить") { save() }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (isEncrypted && passphrase.isEmpty))
            }
        }
    }

    private func save() {
        let keyName = name.trimmingCharacters(in: .whitespaces).isEmpty ? "Импортированный ключ" : name
        let pem = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let encrypted = KeyTools.isEncrypted(pem)
        if encrypted && passphrase.isEmpty {
            error = "Ключ защищён паролем — введите его."
            return
        }
        do {
            let info = try KeyTools.inspect(privateKey: pem, passphrase: encrypted ? passphrase : nil, comment: keyName)
            let item = SSHKeyItem(name: keyName, type: info.type, publicKey: info.publicKey, encrypted: encrypted ? true : nil)
            store.addKey(item, privateKey: pem, passphrase: encrypted ? passphrase : nil)
            dismiss()
        } catch {
            self.error = TerminalSession.describe(error)
        }
    }
}

struct KeyDetailView: View {
    @EnvironmentObject var store: Store
    let key: SSHKeyItem
    @State private var showInstall = false
    @State private var copied = false

    var body: some View {
        List {
            Section("Ключ") {
                LabeledContent("Имя", value: key.name)
                LabeledContent("Тип", value: key.type)
                LabeledContent("Пароль", value: key.encrypted == true ? "есть" : "нет")
                LabeledContent("Создан", value: key.created.formatted(date: .abbreviated, time: .shortened))
                let users = store.hosts.filter { $0.auth == .key && $0.keyID == key.id }
                if !users.isEmpty {
                    LabeledContent("Используется", value: users.map(\.title).joined(separator: ", "))
                }
            }
            if !key.publicKey.isEmpty {
                Section {
                    Text(verbatim: key.publicKey)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = key.publicKey
                        copied = true
                    } label: {
                        Label(copied ? "Скопировано" : "Скопировать", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    ShareLink(item: key.publicKey) {
                        Label("Поделиться", systemImage: "square.and.arrow.up")
                    }
                } header: {
                    Text("Публичный ключ")
                } footer: {
                    Text("Эту строку нужно добавить в ~/.ssh/authorized_keys на сервере. Termuxx может сделать это сам.")
                }
                Section {
                    Button {
                        showInstall = true
                    } label: {
                        Label("Установить на сервер…", systemImage: "arrow.up.doc.on.clipboard")
                    }
                }
            } else {
                Section {
                    Text("Публичная часть недоступна. Импортируйте ключ заново, чтобы установить его на сервер из приложения.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(key.name)
        .sheet(isPresented: $showInstall) {
            NavigationStack { InstallKeyView(key: key) }
        }
    }
}

struct InstallKeyView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let key: SSHKeyItem

    @State private var selected: Server?
    @State private var password = ""
    @State private var switchToKey = true
    @State private var working = false
    @State private var result: String?
    @State private var trustRequest: HostKeyRequest?

    var body: some View {
        Form {
            Section("Сервер") {
                if store.hosts.isEmpty {
                    Text("Сначала добавьте сервер.").foregroundStyle(.secondary)
                }
                ForEach(store.hosts) { server in
                    Button {
                        selected = server
                        password = store.password(for: server) ?? ""
                        result = nil
                    } label: {
                        HStack {
                            HostRow(server: server)
                            if selected?.id == server.id {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                }
            }
            if let selected, selected.auth == .password {
                Section {
                    SecureField("Пароль", text: $password)
                } header: {
                    Text("Текущий пароль")
                } footer: {
                    Text("Нужен один раз, чтобы добавить ключ в authorized_keys.")
                }
            }
            Section {
                Toggle("Дальше входить по этому ключу", isOn: $switchToKey)
            }
            if let result {
                Section { Text(result).font(.footnote) }
            }
        }
        .navigationTitle("Установка ключа")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                if working {
                    ProgressView()
                } else {
                    Button("Установить") { Task { await install() } }
                        .disabled(selected == nil)
                }
            }
        }
        .hostKeyAlert($trustRequest) {
            Task { await install() }
        }
    }

    private func install() async {
        guard let server = selected else { return }
        working = true
        defer { working = false }
        do {
            let connection = try await SSHConnector.connect(server, password: password.isEmpty ? nil : password)
            let output: ByteBuffer
            do {
                output = try await connection.client.executeCommand(
                    KeyTools.installCommand(publicKey: key.publicKey),
                    mergeStreams: true
                )
            } catch {
                await connection.close()
                throw error
            }
            await connection.close()
            let text = String(buffer: output).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.hasSuffix("OK") {
                if switchToKey {
                    var updated = server
                    updated.auth = .key
                    updated.keyID = key.id
                    store.upsert(updated)
                    selected = updated
                }
                result = "✅ Ключ установлен на \(server.title)." + (switchToKey ? " Теперь вход — по ключу." : "")
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else {
                result = "Сервер ответил: \(text)"
            }
        } catch {
            if let request = error.hostKeyRequest {
                trustRequest = request
                return
            }
            result = "❌ " + TerminalSession.describe(error)
        }
    }
}
