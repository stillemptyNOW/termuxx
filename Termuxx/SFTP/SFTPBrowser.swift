import SwiftUI
import UIKit
import QuickLook
import UniformTypeIdentifiers

/// Файловый менеджер сервера (SFTP). Показывается внутри NavigationStack в шите.
struct SFTPBrowser: View {
    let server: Server
    var password: String? = nil

    @StateObject private var model: SFTPModel
    @Environment(\.dismiss) private var dismiss

    @State private var showImporter = false
    @State private var askNewFolder = false
    @State private var newFolderName = ""
    @State private var askGoTo = false
    @State private var goToPath = ""
    @State private var renaming: RemoteItem?
    @State private var renameText = ""
    @State private var pendingDelete: RemoteItem?
    @State private var pendingUploads: [URL] = []
    @State private var askReplace = false
    @State private var sharedFile: SFTPSharedFile?
    @State private var previewURL: URL?
    @State private var editing: SFTPEditingFile?

    init(server: Server, password: String? = nil) {
        self.server = server
        self.password = password
        _model = StateObject(wrappedValue: SFTPModel(server: server, password: password))
    }

    /// Пока показан дочерний экран (QuickLook, «Поделиться», редактор), соединение не закрываем.
    private var presentingChild: Bool {
        previewURL != nil || sharedFile != nil || editing != nil || showImporter
    }

    var body: some View {
        ZStack {
            Group {
                fileList
                    .alert("Новая папка", isPresented: $askNewFolder) {
                        TextField("Имя папки", text: $newFolderName)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Создать") {
                            let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task { await model.makeDirectory(name) }
                        }
                        Button("Отмена", role: .cancel) {}
                    }
                    .alert("Переименовать", isPresented: Binding(
                        get: { renaming != nil },
                        set: { if !$0 { renaming = nil } }
                    )) {
                        TextField("Новое имя", text: $renameText)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Сохранить") {
                            if let item = renaming {
                                let name = renameText
                                Task { await model.rename(item, to: name) }
                            }
                            renaming = nil
                        }
                        Button("Отмена", role: .cancel) { renaming = nil }
                    }
            }
            .alert("Перейти к папке", isPresented: $askGoTo) {
                TextField("/etc/nginx", text: $goToPath)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Перейти") {
                    let target = goToPath.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !target.isEmpty else { return }
                    Task {
                        if target.hasPrefix("/") {
                            await model.go(to: target)
                        } else if target == "~" {
                            await model.goHome()
                        } else {
                            await model.go(to: model.fullPath(target))
                        }
                    }
                }
                Button("Отмена", role: .cancel) {}
            }
        }
        .alert("Ошибка", isPresented: Binding(
            get: { model.error != nil },
            set: { if !$0 { model.error = nil } }
        )) {
            Button("OK", role: .cancel) { model.error = nil }
        } message: {
            Text(model.error ?? "")
        }
        .hostKeyAlert($model.trustRequest) {
            Task { await model.retry() }
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Удалить", role: .destructive) {
                if let item = pendingDelete {
                    Task { await model.delete(item) }
                }
                pendingDelete = nil
            }
            Button("Отмена", role: .cancel) { pendingDelete = nil }
        } message: {
            Text(pendingDelete?.isDirectory == true
                 ? "Папка удаляется, только если она пуста."
                 : "Это действие нельзя отменить.")
        }
        .confirmationDialog("Заменить файлы?", isPresented: $askReplace, titleVisibility: .visible) {
            Button("Заменить", role: .destructive) {
                let urls = pendingUploads
                pendingUploads = []
                Task { await model.upload(urls) }
            }
            let fresh = pendingUploads.filter { !model.contains(name: $0.lastPathComponent) }
            if !fresh.isEmpty {
                Button("Пропустить существующие") {
                    pendingUploads = []
                    Task { await model.upload(fresh) }
                }
            }
            Button("Отмена", role: .cancel) { pendingUploads = [] }
        } message: {
            Text("В папке уже есть: " + pendingUploads
                .filter { model.contains(name: $0.lastPathComponent) }
                .map(\.lastPathComponent)
                .joined(separator: ", "))
        }
        .navigationTitle(server.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .task { await model.start() }
        .onDisappear {
            if !presentingChild { model.close() }
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result, !urls.isEmpty else { return }
            let clashes = urls.filter { model.contains(name: $0.lastPathComponent) }
            if clashes.isEmpty {
                Task { await model.upload(urls) }
            } else {
                pendingUploads = urls
                askReplace = true
            }
        }
        .sheet(item: $sharedFile) { file in
            ActivityView(items: [file.url])
        }
        .sheet(item: $editing) { file in
            NavigationStack {
                SFTPFileEditor(file: file) { name, text, isNew in
                    await model.writeText(text, to: name, isNew: isNew)
                }
            }
        }
        .quickLookPreview($previewURL)
    }

    private var deleteTitle: String {
        guard let item = pendingDelete else { return "Удалить?" }
        return item.isDirectory ? "Удалить папку «\(item.name)»?" : "Удалить «\(item.name)»?"
    }

    // MARK: Список

    private var fileList: some View {
        List {
            if model.isConnected {
                Section {
                    if model.path != "/" && model.search.isEmpty {
                        Button {
                            Task { await model.goUp() }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "arrow.turn.left.up")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 36, height: 36)
                                Text("..")
                                    .font(.body.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    ForEach(model.visibleItems) { item in
                        row(item)
                    }
                } footer: {
                    if !model.items.isEmpty {
                        Text(footerText)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $model.search, prompt: "Поиск в папке")
        .refreshable { await model.reload() }
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.isConnected {
                breadcrumbBar
            }
        }
        .overlay { stateOverlay }
        .overlay(alignment: .bottom) { hud }
        .animation(.spring(duration: 0.35), value: model.transfer?.id)
        .animation(.easeInOut(duration: 0.2), value: model.busyText)
    }

    private var footerText: String {
        let dirs = model.items.filter(\.isDirectory).count
        let files = model.items.count - dirs
        var text = "Папок: \(dirs), файлов: \(files)"
        if !model.showHidden && model.hiddenCount > 0 {
            text += " · скрыто: \(model.hiddenCount)"
        }
        return text
    }

    private func row(_ item: RemoteItem) -> some View {
        Button {
            open(item)
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color(hex: item.kind.colorHex).opacity(0.18))
                    Image(systemName: item.kind.icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color(hex: item.kind.colorHex))
                }
                .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(item.name)
                            .foregroundStyle(item.isHidden ? Color.secondary : Color.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if item.isLink {
                            Image(systemName: "arrow.turn.up.right")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(subtitle(for: item))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if item.isDirectory {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .contextMenu { contextMenu(for: item) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                pendingDelete = item
            } label: {
                Label("Удалить", systemImage: "trash")
            }
            .tint(.red)
            Button {
                renameText = item.name
                renaming = item
            } label: {
                Label("Имя", systemImage: "pencil")
            }
            .tint(.orange)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if !item.isDirectory {
                Button {
                    Task { await downloadAndPresent(item, share: true) }
                } label: {
                    Label("Скачать", systemImage: "square.and.arrow.down")
                }
                .tint(.blue)
            }
        }
    }

    @ViewBuilder
    private func contextMenu(for item: RemoteItem) -> some View {
        if item.isDirectory {
            Button { open(item) } label: { Label("Открыть", systemImage: "folder") }
        } else {
            if (item.size ?? 0) <= SFTPModel.editorLimit {
                Button { openInEditor(item) } label: {
                    Label("Открыть в редакторе", systemImage: "square.and.pencil")
                }
            }
            Button {
                Task { await downloadAndPresent(item, share: false) }
            } label: { Label("Просмотр", systemImage: "eye") }
            Button {
                Task { await downloadAndPresent(item, share: true) }
            } label: { Label("Поделиться / Сохранить в Файлы", systemImage: "square.and.arrow.up") }
        }
        Divider()
        Button {
            UIPasteboard.general.string = model.fullPath(item.name)
        } label: { Label("Скопировать путь", systemImage: "doc.on.doc") }
        Button {
            UIPasteboard.general.string = item.name
        } label: { Label("Скопировать имя", systemImage: "character.cursor.ibeam") }
        Button {
            renameText = item.name
            renaming = item
        } label: { Label("Переименовать", systemImage: "pencil") }
        Divider()
        Button(role: .destructive) {
            pendingDelete = item
        } label: { Label("Удалить", systemImage: "trash") }
    }

    private func subtitle(for item: RemoteItem) -> String {
        var parts: [String] = []
        if !item.isDirectory, let size = item.size {
            parts.append(SFTPFormat.bytes(Int64(size)))
        }
        if let date = item.modified {
            parts.append(SFTPFormat.date(date))
        }
        if !item.permissionString.isEmpty {
            parts.append(item.permissionString)
        }
        return parts.joined(separator: " · ")
    }

    // MARK: Хлебные крошки

    private var breadcrumbBar: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                GlassGroup(spacing: 6) {
                    HStack(spacing: 6) {
                        Button {
                            Task { await model.goHome() }
                        } label: {
                            Image(systemName: "house.fill")
                                .font(.footnote.weight(.semibold))
                                .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .glassCircle(tint: model.path == model.homePath ? Color.accentColor.opacity(0.35) : nil)

                        let crumbs = model.breadcrumbs
                        ForEach(Array(crumbs.enumerated()), id: \.offset) { index, crumb in
                            let isLast = index == crumbs.count - 1
                            Button {
                                Task { await model.go(to: crumb.path) }
                            } label: {
                                Text(crumb.name)
                                    .font(.footnote.monospaced().weight(isLast ? .semibold : .regular))
                                    .lineLimit(1)
                                    .padding(.horizontal, 11)
                                    .padding(.vertical, 7)
                            }
                            .buttonStyle(.plain)
                            .glassCapsule(tint: isLast ? Color.accentColor.opacity(0.35) : nil)
                            .id(index)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                }
            }
            .onChange(of: model.path) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) {
                    proxy.scrollTo(model.breadcrumbs.count - 1, anchor: .trailing)
                }
            }
            .onAppear {
                proxy.scrollTo(model.breadcrumbs.count - 1, anchor: .trailing)
            }
        }
    }

    // MARK: Состояния

    @ViewBuilder
    private var stateOverlay: some View {
        if !model.isConnected {
            if let message = model.connectionError {
                ContentUnavailableView {
                    Label("Нет подключения", systemImage: "bolt.horizontal.circle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Повторить") {
                        Task { await model.retry() }
                    }
                    .glassButtonStyle(prominent: true)
                }
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                        .controlSize(.large)
                    Text("Подключение к \(server.title)…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
                .glassCard(cornerRadius: 24)
            }
        } else if model.visibleItems.isEmpty && !model.isLoading {
            if !model.search.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView.search(text: model.search)
            } else {
                ContentUnavailableView {
                    Label("Папка пуста", systemImage: "folder")
                } description: {
                    if model.hiddenCount > 0 && !model.showHidden {
                        Text("Здесь есть скрытые файлы: \(model.hiddenCount). Включите их показ в меню.")
                    } else {
                        Text("Загрузите сюда файлы кнопкой «+».")
                    }
                } actions: {
                    Button {
                        showImporter = true
                    } label: {
                        Label("Загрузить файлы", systemImage: "square.and.arrow.up")
                    }
                    .glassButtonStyle(prominent: true)
                }
            }
        }
    }

    @ViewBuilder
    private var hud: some View {
        if let transfer = model.transfer {
            SFTPTransferHUD(progress: transfer) {
                model.cancelTransfer()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if let text = model.busyText {
            HStack(spacing: 10) {
                ProgressView()
                Text(text).font(.subheadline)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .glassCapsule(interactive: false)
            .padding(.bottom, 16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: Панель инструментов

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Готово") {
                model.close()
                dismiss()
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Picker(selection: $model.sortOrder) {
                    ForEach(SFTPSortOrder.allCases) { order in
                        Label(order.title, systemImage: order.icon).tag(order)
                    }
                } label: {
                    Label("Сортировка", systemImage: "arrow.up.arrow.down")
                }
                .pickerStyle(.inline)
                Toggle(isOn: $model.showHidden) {
                    Label("Скрытые файлы", systemImage: "eye")
                }
                Divider()
                Button {
                    Task { await model.goHome() }
                } label: { Label("Домашняя папка", systemImage: "house") }
                Button {
                    goToPath = model.path
                    askGoTo = true
                } label: { Label("Перейти к папке…", systemImage: "arrow.right.circle") }
                Button {
                    UIPasteboard.general.string = model.path
                } label: { Label("Скопировать путь папки", systemImage: "doc.on.doc") }
                Button {
                    Task { await model.reload() }
                } label: { Label("Обновить", systemImage: "arrow.clockwise") }
            } label: {
                Image(systemName: "line.3.horizontal.decrease.circle")
            }
            .disabled(!model.isConnected)
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button { showImporter = true } label: {
                    Label("Загрузить файлы", systemImage: "square.and.arrow.up")
                }
                Button {
                    newFolderName = ""
                    askNewFolder = true
                } label: {
                    Label("Новая папка", systemImage: "folder.badge.plus")
                }
                Button {
                    editing = SFTPEditingFile(name: "", text: "", isNew: true)
                } label: {
                    Label("Новый файл", systemImage: "doc.badge.plus")
                }
            } label: {
                Image(systemName: "plus")
            }
            .disabled(!model.isConnected || model.isTransferring)
        }
    }

    // MARK: Действия

    private func open(_ item: RemoteItem) {
        Task {
            if item.isDirectory || item.isLink {
                if await model.enter(item) { return }
            }
            if item.looksTextual, (item.size ?? 0) <= SFTPModel.editorLimit {
                if let text = await model.readText(item) {
                    editing = SFTPEditingFile(name: item.name, text: text, isNew: false)
                    return
                }
                if model.error != nil { return }
            }
            await downloadAndPresent(item, share: false)
        }
    }

    private func openInEditor(_ item: RemoteItem) {
        Task {
            if let text = await model.readText(item) {
                editing = SFTPEditingFile(name: item.name, text: text, isNew: false)
            } else if model.error == nil {
                model.error = "«\(item.name)» не похож на текстовый файл. Откройте его через «Просмотр»."
            }
        }
    }

    private func downloadAndPresent(_ item: RemoteItem, share: Bool) async {
        guard let url = await model.download(item) else { return }
        if !share && QLPreviewController.canPreview(url as NSURL) {
            previewURL = url
        } else {
            sharedFile = SFTPSharedFile(url: url)
        }
    }
}

// MARK: - Вспомогательные типы

struct SFTPSharedFile: Identifiable {
    let id = UUID()
    let url: URL
}

struct SFTPEditingFile: Identifiable {
    let id = UUID()
    var name: String
    var text: String
    var isNew: Bool
}

enum SFTPFormat {
    static func bytes(_ count: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: count, countStyle: .file)
    }

    static func speed(_ bytesPerSecond: Double) -> String {
        bytes(Int64(bytesPerSecond)) + "/с"
    }

    static func date(_ date: Date) -> String {
        if Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year) {
            return date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
        }
        return date.formatted(.dateTime.day().month(.abbreviated).year())
    }

    static func duration(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        if s < 60 { return "\(max(s, 1)) с" }
        if s < 3600 { return "\(s / 60) мин \(s % 60) с" }
        return "\(s / 3600) ч \((s % 3600) / 60) мин"
    }
}

/// Стеклянная карточка прогресса передачи с кнопкой отмены.
private struct SFTPTransferHUD: View {
    let progress: SFTPTransferProgress
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: progress.direction == .download ? "arrow.down.circle.fill" : "arrow.up.circle.fill")
                .font(.title2)
                .foregroundStyle(Color.accentColor)
                .symbolEffect(.pulse, options: .repeating)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(progress.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    if progress.count > 1 {
                        Text("\(progress.index) из \(progress.count)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                if let fraction = progress.fraction {
                    ProgressView(value: fraction)
                        .tint(Color.accentColor)
                } else {
                    ProgressView(value: 0)
                        .tint(Color.accentColor)
                        .opacity(0.4)
                }
                Text(details)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.bold))
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .glassCircle()
            .accessibilityLabel("Отменить передачу")
        }
        .padding(14)
        .glassCard(cornerRadius: 24)
    }

    private var details: String {
        var parts: [String] = []
        if let total = progress.total {
            parts.append("\(SFTPFormat.bytes(progress.done)) из \(SFTPFormat.bytes(total))")
        } else {
            parts.append(SFTPFormat.bytes(progress.done))
        }
        if progress.bytesPerSecond > 1 {
            parts.append(SFTPFormat.speed(progress.bytesPerSecond))
        }
        if let remaining = progress.remainingSeconds, progress.bytesPerSecond > 1 {
            parts.append("осталось \(SFTPFormat.duration(remaining))")
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Редактор

struct SFTPFileEditor: View {
    @State private var file: SFTPEditingFile
    private let original: String
    let onSave: (String, String, Bool) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var confirmDiscard = false
    @AppStorage("fontSize") private var fontSize = 13.0

    init(file: SFTPEditingFile, onSave: @escaping (String, String, Bool) async -> Bool) {
        _file = State(initialValue: file)
        self.original = file.text
        self.onSave = onSave
    }

    private var hasChanges: Bool {
        file.text != original || (file.isNew && !file.name.isEmpty)
    }

    private var stats: String {
        let lines = file.text.utf8.reduce(1) { $1 == 10 ? $0 + 1 : $0 }
        return "Строк: \(lines) · символов: \(file.text.count)"
    }

    var body: some View {
        VStack(spacing: 0) {
            if file.isNew {
                TextField("имя_файла.txt", text: $file.name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                Divider()
            }
            SFTPCodeTextView(text: $file.text, fontSize: CGFloat(fontSize))
            HStack {
                Text(stats)
                Spacer()
                if hasChanges {
                    Label("Изменён", systemImage: "circle.fill")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(.orange)
                }
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .navigationTitle(file.isNew ? "Новый файл" : file.name)
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(hasChanges)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Отмена") {
                    if hasChanges { confirmDiscard = true } else { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("Сохранить") {
                        Task {
                            saving = true
                            let ok = await onSave(file.name, file.text, file.isNew)
                            saving = false
                            if ok { dismiss() }
                        }
                    }
                    .fontWeight(.semibold)
                    .disabled(!SFTPModel.isValidName(file.name))
                }
            }
        }
        .confirmationDialog("Закрыть без сохранения?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Не сохранять", role: .destructive) { dismiss() }
            Button("Продолжить редактирование", role: .cancel) {}
        }
    }
}

/// UITextView без «умных» кавычек и автозамен — чтобы не портить конфиги и скрипты.
struct SFTPCodeTextView: UIViewRepresentable {
    @Binding var text: String
    var fontSize: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textColor = .label
        view.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        view.autocorrectionType = .no
        view.autocapitalizationType = .none
        view.spellCheckingType = .no
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
        view.text = text
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text {
            view.text = text
        }
        let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        if view.font != font {
            view.font = font
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        func textViewDidChange(_ textView: UITextView) {
            text.wrappedValue = textView.text
        }
    }
}
