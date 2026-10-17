import SwiftUI

struct SnippetsView: View {
    @EnvironmentObject var store: Store
    @State private var editing: Snippet?

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.snippets) { snippet in
                    Button { editing = snippet } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(snippet.name).font(.body.weight(.semibold)).foregroundStyle(.primary)
                                Spacer()
                                if snippet.runImmediately {
                                    Image(systemName: "return").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Text(snippet.command)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }
                }
                .onDelete { store.snippets.remove(atOffsets: $0) }
                .onMove { store.snippets.move(fromOffsets: $0, toOffset: $1) }
            }
            .overlay {
                if store.snippets.isEmpty {
                    ContentUnavailableView("Нет сниппетов", systemImage: "text.badge.plus",
                                           description: Text("Сохраняйте частые команды и отправляйте их в терминал одним касанием."))
                }
            }
            .navigationTitle("Сниппеты")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = Snippet() } label: { Image(systemName: "plus.circle.fill").font(.title3) }
                }
            }
            .sheet(item: $editing) { snippet in
                NavigationStack { SnippetEditView(snippet: snippet) }
            }
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
            Section("Команда") {
                TextEditor(text: $snippet.command)
                    .font(.body.monospaced())
                    .frame(minHeight: 120)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
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
                    if snippet.name.isEmpty { snippet.name = String(snippet.command.prefix(24)) }
                    store.upsert(snippet)
                    dismiss()
                }
                .disabled(snippet.command.isEmpty)
            }
        }
    }
}
