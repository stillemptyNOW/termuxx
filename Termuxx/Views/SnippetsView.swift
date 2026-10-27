import SwiftUI

struct SnippetsView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var sessions: SessionManager
    @EnvironmentObject var router: AppRouter
    @State private var editing: Snippet?
    @State private var search = ""

    private var filtered: [Snippet] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return store.snippets }
        return store.snippets.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.command.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                let list = filtered
                ForEach(list) { snippet in
                    Button { editing = snippet } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(snippet.name).font(.body.weight(.semibold)).foregroundStyle(.primary)
                                Spacer()
                                if snippet.runImmediately {
                                    Image(systemName: "return").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Text(verbatim: snippet.command)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }
                    .contextMenu { menu(for: snippet) }
                }
                .onDelete { idx in
                    let ids = Set(idx.map { list[$0].id })
                    store.snippets.removeAll { ids.contains($0.id) }
                }
                .onMove(perform: search.isEmpty ? { (source: IndexSet, destination: Int) in
                    store.snippets.move(fromOffsets: source, toOffset: destination)
                } : nil)
            }
            .overlay {
                if store.snippets.isEmpty {
                    ContentUnavailableView {
                        Label("Нет сниппетов", systemImage: "text.badge.plus")
                    } description: {
                        Text("Сохраняйте частые команды и отправляйте их в терминал одним касанием.")
                    } actions: {
                        Button {
                            editing = Snippet()
                        } label: {
                            Label("Новый сниппет", systemImage: "plus")
                                .padding(.horizontal, 6)
                        }
                        .glassButtonStyle(prominent: true)
                    }
                } else if !search.isEmpty && filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
            .searchable(text: $search, prompt: "Поиск команд")
            .navigationTitle("Сниппеты")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = Snippet() } label: { Image(systemName: "plus") }
                }
            }
            .sheet(item: $editing) { snippet in
                NavigationStack { SnippetEditView(snippet: snippet) }
            }
        }
    }

    @ViewBuilder
    private func menu(for snippet: Snippet) -> some View {
        if !sessions.sessions.isEmpty {
            Menu {
                ForEach(sessions.sessions) { session in
                    Button(session.server.title) {
                        session.send(snippet.command + (snippet.runImmediately ? "\n" : ""))
                        router.openTerminal(session.id)
                    }
                }
            } label: {
                Label("Отправить в сессию", systemImage: "paperplane")
            }
        }
        Button {
            UIPasteboard.general.string = snippet.command
        } label: {
            Label("Скопировать команду", systemImage: "doc.on.doc")
        }
        Button {
            var copy = snippet
            copy.id = UUID()
            copy.name = snippet.name + " (копия)"
            store.upsert(copy)
        } label: {
            Label("Дублировать", systemImage: "plus.square.on.square")
        }
        Button(role: .destructive) {
            store.snippets.removeAll { $0.id == snippet.id }
        } label: {
            Label("Удалить", systemImage: "trash")
        }
    }
}

struct SnippetEditView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State var snippet: Snippet

    var body: some View {
        Form {
            Section("Название") {
                TextField("Например, Перезапуск прокси", text: $snippet.name)
            }
            Section {
                TextEditor(text: $snippet.command)
                    .font(.body.monospaced())
                    .frame(minHeight: 120)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Команда")
            } footer: {
                Text("Можно несколько строк — они отправятся в терминал как есть.")
            }
            Section {
                Toggle("Сразу выполнять (Enter)", isOn: $snippet.runImmediately)
            }
        }
        .navigationTitle(snippet.name.isEmpty ? "Новый сниппет" : snippet.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Сохранить") {
                    if snippet.name.trimmingCharacters(in: .whitespaces).isEmpty {
                        snippet.name = String(snippet.command.prefix(24))
                    }
                    store.upsert(snippet)
                    dismiss()
                }
                .disabled(snippet.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}
