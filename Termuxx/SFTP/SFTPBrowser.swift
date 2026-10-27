import SwiftUI
import UniformTypeIdentifiers

struct SFTPBrowser: View {
    let server: Server
    var password: String? = nil

    @StateObject private var model: SFTPModel
    @Environment(\.dismiss) private var dismiss

    @State private var showImporter = false
    @State private var newFolderName = ""
    @State private var askNewFolder = false
    @State private var renaming: RemoteItem?
    @State private var renameText = ""
    @State private var sharedFile: SharedFile?
    @State private var editing: EditingFile?

    init(server: Server, password: String? = nil) {
        self.server = server
        self.password = password
        _model = StateObject(wrappedValue: SFTPModel(server: server, password: password))
    }

    var body: some View {
        List {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(Array(model.breadcrumbs.enumerated()), id: \.offset) { index, crumb in
                            if index > 1 {
                                Image(systemName: "chevron.compact.right").foregroundStyle(.tertiary)
                            }
                            Button(crumb.name) {
                                Task { await model.go(to: crumb.path) }
                            }
                            .font(.footnote.monospaced())
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
            }

            Section {
                if model.path != "/" {
                    Button {
                        Task { await model.goUp() }
                    } label: {
                        Label("..", systemImage: "arrow.turn.left.up")
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(model.visibleItems) { item in
                    row(item)
                }
            } footer: {
                if !model.isLoading {
                    Text("\(model.visibleItems.count) объектов")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(server.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.reload() }
        .overlay {
            if model.isLoading && model.items.isEmpty {
                ProgressView("Подключение…")
            }
        }
        .overlay(alignment: .bottom) {
            if let text = model.busyText {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(text).font(.subheadline)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.thinMaterial, in: Capsule())
                .padding(.bottom, 20)
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Готово") { dismiss() }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { showImporter = true } label: { Label("Загрузить файл", systemImage: "square.and.arrow.up") }
                    Button { newFolderName = ""; askNewFolder = true } label: { Label("Новая папка", systemImage: "folder.badge.plus") }
                    Button {
                        editing = EditingFile(name: "", text: "", isNew: true)
                    } label: { Label("Новый файл", systemImage: "doc.badge.plus") }
                    Toggle(isOn: $model.showHidden) { Label("Скрытые файлы", systemImage: "eye") }
                    Button { Task { await model.reload() } } label: { Label("Обновить", systemImage: "arrow.clockwise") }
                } label: {
                    Image(systemName: "plus.circle.fill")
                }
            }
        }
        .task { await model.connect() }
        .onDisappear { model.close() }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task {
                    for url in urls { await model.upload(url) }
                }
            }
        }
        .alert("Новая папка", isPresented: $askNewFolder) {
            TextField("Имя", text: $newFolderName)
            Button("Создать") {
                let name = newFolderName.trimmingCharacters(in: .whitespaces)
                guard !name.isEmpty else { return }
                Task { await model.makeDirectory(name) }
            }
            Button("Отмена", role: .cancel) {}
        }
        .alert("Переименовать", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Имя", text: $renameText)
            Button("Сохранить") {
                if let item = renaming, !renameText.isEmpty, renameText != item.name {
                    Task { await model.rename(item, to: renameText) }
                }
                renaming = nil
            }
            Button("Отмена", role: .cancel) { renaming = nil }
        }
        .alert("Ошибка", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
        .sheet(item: $sharedFile) { file in
            ActivityView(items: [file.url])
        }
        .sheet(item: $editing) { file in
            NavigationStack {
                FileEditor(file: file) { name, text in
                    await model.writeText(text, to: name)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ item: RemoteItem) -> some View {
        Button {
            Task {
                let opened = await model.open(item)
                if !opened { await openFile(item) }
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.icon)
                    .font(.title3)
                    .frame(width: 30)
                    .foregroundStyle(item.isDirectory ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        if !item.isDirectory, let size = item.size {
                            Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                        }
                        if let date = item.modified {
                            Text(date, format: .dateTime.day().month(.abbreviated).year().hour().minute())
                        }
                        Text(item.permissionString).monospaced()
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if item.isDirectory {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .contextMenu {
            if !item.isDirectory {
                Button { Task { await openFile(item) } } label: { Label("Открыть в редакторе", systemImage: "pencil") }
                Button {
                    Task {
                        if let url = await model.download(item) { sharedFile = SharedFile(url: url) }
                    }
                } label: { Label("Скачать / поделиться", systemImage: "square.and.arrow.down") }
            }
            Button {
                UIPasteboard.general.string = model.fullPath(item.name)
            } label: { Label("Скопировать путь", systemImage: "doc.on.doc") }
            Button {
                renameText = item.name
                renaming = item
            } label: { Label("Переименовать", systemImage: "character.cursor.ibeam") }
            Button(role: .destructive) {
                Task { await model.delete(item) }
            } label: { Label("Удалить", systemImage: "trash") }
        }
        .swipeActions {
            Button(role: .destructive) {
                Task { await model.delete(item) }
            } label: { Label("Удалить", systemImage: "trash") }
        }
    }

    private func openFile(_ item: RemoteItem) async {
        if let text = await model.readText(item) {
            editing = EditingFile(name: item.name, text: text, isNew: false)
        } else if model.error == "Это не текстовый файл." {
            model.error = nil
            if let url = await model.download(item) { sharedFile = SharedFile(url: url) }
        }
    }
}

struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL
}

struct EditingFile: Identifiable {
    let id = UUID()
    var name: String
    var text: String
    var isNew: Bool
}

struct FileEditor: View {
    @State var file: EditingFile
    let onSave: (String, String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @AppStorage("fontSize") private var fontSize = 13.0

    var body: some View {
        VStack(spacing: 0) {
            if file.isNew {
                TextField("имя_файла.txt", text: $file.name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                    .padding(12)
                Divider()
            }
            TextEditor(text: $file.text)
                .font(.system(size: fontSize, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 8)
        }
        .navigationTitle(file.isNew ? "Новый файл" : file.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Отмена") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("Сохранить") {
                        Task {
                            saving = true
                            let ok = await onSave(file.name, file.text)
                            saving = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(file.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
