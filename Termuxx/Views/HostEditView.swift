import SwiftUI

struct HostEditView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss

    private let isNew: Bool
    @State private var server: Server
    @State private var password = ""
    @State private var portText: String

    init(server: Server?) {
        isNew = server == nil
        let s = server ?? Server()
        _server = State(initialValue: s)
        _portText = State(initialValue: String(s.port))
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
                    Text(fingerprint)
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
                        store.delete(server)
                        dismiss()
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
                    .disabled(server.hostname.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .onAppear {
            if !isNew { password = store.password(for: server) ?? "" }
        }
    }

    private func save() {
        server.hostname = server.hostname.trimmingCharacters(in: .whitespacesAndNewlines)
        server.username = server.username.trimmingCharacters(in: .whitespacesAndNewlines)
        if server.username.isEmpty { server.username = "root" }
        server.port = Int(portText) ?? 22
        store.upsert(server)
        if server.auth == .password {
            store.setPassword(password.isEmpty ? nil : password, for: server)
        }
        dismiss()
    }
}
