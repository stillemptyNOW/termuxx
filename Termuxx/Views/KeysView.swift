import SwiftUI
import UniformTypeIdentifiers
import Citadel

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
                        HStack(spacing: 14) {
                            Image(systemName: "key.horizontal.fill")
                                .font(.title3)
                                .foregroundStyle(Color.accentColor)
                                .frame(width: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(key.name).font(.body.weight(.semibold))
                                Text("\(key.type) · \(key.created.formatted(date: .abbreviated, time: .omitted))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .onDelete { idx in
                    idx.map { store.keys[$0] }.forEach(store.deleteKey)
                }
            }
            .overlay {
                if store.keys.isEmpty {
                    ContentUnavailableView {
                        Label("Нет ключей", systemImage: "key")
                    } description: {
                        Text("Вход по ключу надёжнее пароля. Создайте ключ и установите его на сервер в одно касание.")
                    } actions: {
                        Button("Создать ключ") { newName = "termuxx"; askGenerateName = true }
                            .buttonStyle(.borderedProminent)
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
                        Image(systemName: "plus.circle.fill").font(.title3)
                    }
                }
            }
            .alert("Имя ключа", isPresented: $askGenerateName) {
                TextField("Имя", text: $newName)
                Button("Создать") { generate() }
                Button("Отмена", role: .cancel) {}
            }
            .sheet(isPresented: $showImport) {
                NavigationStack {
                    ImportKeyView(initialText: importText)
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

struct ImportKeyView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State var initialText: String
    @State private var name = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section("Имя") {
                TextField("Например, laptop", text: $name)
            }
            Section {
                TextEditor(text: $initialText)
                    .font(.caption.monospaced())
                    .frame(minHeight: 220)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Вставить из буфера") {
                    initialText = UIPasteboard.general.string ?? ""
                }
            } header: {
                Text("Приватный ключ")
            } footer: {
                Text("Формат OpenSSH (-----BEGIN OPENSSH PRIVATE KEY-----). Поддерживаются Ed25519 и RSA без пароля.")
            }
            if let error {
                Text(error).foregroundStyle(.red).font(.footnote)
            }
        }
        .navigationTitle("Импорт ключа")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Сохранить") { save() }
                    .disabled(initialText.isEmpty)
            }
        }
    }

    private func save() {
        let keyName = name.trimmingCharacters(in: .whitespaces).isEmpty ? "Импортированный ключ" : name
        do {
            let info = try KeyTools.inspect(privateKey: initialText, comment: keyName)
            store.addKey(SSHKeyItem(name: keyName, type: info.type, publicKey: info.publicKey),
                         privateKey: initialText.trimmingCharacters(in: .whitespacesAndNewlines))
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
                LabeledContent("Создан", value: key.created.formatted(date: .abbreviated, time: .shortened))
            }
            if !key.publicKey.isEmpty {
                Section {
                    Text(key.publicKey)
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
                Section("Текущий пароль") {
                    SecureField("Пароль", text: $password)
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
    }

    private func install() async {
        guard let server = selected else { return }
        working = true
        defer { working = false }
        do {
            let client = try await SSHConnector.connect(server, password: password.isEmpty ? nil : password)
            let output = try await client.executeCommand(KeyTools.installCommand(publicKey: key.publicKey), mergeStreams: true)
            try? await client.close()
            let text = String(buffer: output).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.hasSuffix("OK") {
                if switchToKey {
                    var updated = server
                    updated.auth = .key
                    updated.keyID = key.id
                    store.upsert(updated)
                }
                result = "✅ Ключ установлен на \(server.title)." + (switchToKey ? " Теперь вход — по ключу." : "")
            } else {
                result = "Сервер ответил: \(text)"
            }
        } catch {
            result = "❌ " + TerminalSession.describe(error)
        }
    }
}
