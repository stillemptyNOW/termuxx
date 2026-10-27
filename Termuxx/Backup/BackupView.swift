import SwiftUI
import UniformTypeIdentifiers

/// Экран «Резервная копия»: перенос серверов, ключей и сниппетов на другое устройство
/// (iPhone, iPad, Termuxx для Linux) и обратно.
struct BackupView: View {
    @ObservedObject private var store = Store.shared

    // Экспорт
    @State private var includeSecrets = true
    @State private var exportPassword = ""
    @State private var exportPasswordRepeat = ""
    @State private var isExporting = false
    @State private var exportedFile: IdentifiedURL?

    // Импорт
    @State private var showImporter = false
    @State private var pending: PendingBackupImport?
    @State private var importPassword = ""
    @State private var isImporting = false
    @State private var summary: ImportSummary?

    @State private var errorMessage: String?
    @FocusState private var focus: BackupFocus?

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                header
                exportSection
                importSection
                if let summary {
                    resultCard(summary)
                        .transition(.scale(scale: 0.96).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 36)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
            .animation(.snappy, value: includeSecrets)
            .animation(.snappy, value: pending == nil)
            .animation(.snappy, value: summary)
        }
        .scrollDismissesKeyboard(.interactively)
        .background { AuroraBackground() }
        .navigationTitle("Резервная копия")
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: [.json, .data, .item],
            allowsMultipleSelection: false
        ) { result in
            handlePicked(result)
        }
        .sheet(item: $exportedFile) { file in
            ActivityView(items: [file.url])
                .presentationDetents([.medium, .large])
                .ignoresSafeArea()
        }
        .alert("Не получилось", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    // MARK: - Шапка

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "archivebox.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 48, height: 48)
                .background(Color.accentColor.opacity(0.16), in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                Text("Перенос на другое устройство")
                    .font(.headline)
                Text("Сохраните серверы, ключи и сниппеты в файл и откройте его в Termuxx на другом iPhone, iPad или на компьютере с Linux.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(inventoryText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(cornerRadius: 26)
    }

    private var inventoryText: String {
        let h = store.hosts.count
        let k = store.keys.count
        let s = store.snippets.count
        return "На этом устройстве: \(h) \(BackupManager.plural(h, "сервер", "сервера", "серверов")) · "
            + "\(k) \(BackupManager.plural(k, "ключ", "ключа", "ключей")) · "
            + "\(s) \(BackupManager.plural(s, "сниппет", "сниппета", "сниппетов"))"
    }

    // MARK: - Экспорт

    private var exportSection: some View {
        BackupSection(title: "Экспорт", systemImage: "tray.and.arrow.up.fill", footer: exportFooter) {
            Toggle(isOn: $includeSecrets) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Включить пароли и ключи")
                    Text("Будут зашифрованы паролем бэкапа")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tint(Color.accentColor)

            if includeSecrets {
                VStack(alignment: .leading, spacing: 10) {
                    SecureField("Пароль бэкапа", text: $exportPassword)
                        .focused($focus, equals: .exportPassword)
                        .submitLabel(.next)
                        .onSubmit { focus = .exportRepeat }
                        .modifier(BackupFieldStyle())
                    SecureField("Повторите пароль", text: $exportPasswordRepeat)
                        .focused($focus, equals: .exportRepeat)
                        .submitLabel(.done)
                        .onSubmit { focus = nil }
                        .modifier(BackupFieldStyle())
                    BackupStrengthMeter(password: exportPassword)
                    if passwordsMismatch {
                        Label("Пароли не совпадают", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        } actions: {
            Button {
                Task { await runExport() }
            } label: {
                HStack(spacing: 8) {
                    if isExporting {
                        ProgressView()
                    } else {
                        Image(systemName: "square.and.arrow.up")
                    }
                    Text(isExporting ? "Шифрую…" : "Создать бэкап")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .glassButtonStyle(prominent: true)
            .controlSize(.large)
            .disabled(!canExport || isExporting)
        }
    }

    private var passwordsMismatch: Bool {
        !exportPasswordRepeat.isEmpty && exportPasswordRepeat != exportPassword
    }

    private var canExport: Bool {
        guard includeSecrets else { return true }
        return exportPassword.count >= BackupManager.minimumPasswordLength && exportPassword == exportPasswordRepeat
    }

    private var exportFooter: String {
        if includeSecrets {
            return "Пароли серверов и прокси, приватные ключи и их пароли шифруются AES-256-GCM (ключ — PBKDF2-SHA256, 200 000 итераций). Termuxx нигде не сохраняет пароль бэкапа: без него секреты не восстановить."
        }
        return "В файл попадут только адреса, настройки, публичные ключи и сниппеты. Пароли и приватные ключи останутся на этом устройстве."
    }

    private func runExport() async {
        guard !isExporting else { return }
        focus = nil
        isExporting = true
        defer { isExporting = false }
        do {
            let url = try await BackupManager.exportAsync(
                includeSecrets: includeSecrets,
                password: includeSecrets ? exportPassword : nil
            )
            exportedFile = IdentifiedURL(url: url)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    // MARK: - Импорт

    private var importSection: some View {
        BackupSection(
            title: "Импорт",
            systemImage: "tray.and.arrow.down.fill",
            footer: "Серверы, ключи и сниппеты с теми же ID обновятся, новые добавятся. Ничего не удаляется. Подходят бэкапы с iPhone, iPad и Termuxx для Linux."
        ) {
            if let pending {
                pendingPreview(pending)
            } else {
                HStack(spacing: 12) {
                    Image(systemName: "doc.fill")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Выберите файл .termuxx — из «Файлов», iCloud Drive или полученный по AirDrop.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } actions: {
            if let pending {
                importActions(pending)
            } else {
                Button {
                    showImporter = true
                } label: {
                    Label("Выбрать файл бэкапа…", systemImage: "folder")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .glassButtonStyle(prominent: false)
                .controlSize(.large)
            }
        }
    }

    private func pendingPreview(_ item: PendingBackupImport) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "doc.fill")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 40, height: 40)
                    .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.fileName)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(sourceLine(item.preview))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Button {
                    pending = nil
                    importPassword = ""
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Убрать файл")
            }

            HStack(spacing: 8) {
                BackupCountPill(
                    value: item.preview.hosts,
                    label: BackupManager.plural(item.preview.hosts, "сервер", "сервера", "серверов"),
                    systemImage: "server.rack"
                )
                BackupCountPill(
                    value: item.preview.keys,
                    label: BackupManager.plural(item.preview.keys, "ключ", "ключа", "ключей"),
                    systemImage: "key.horizontal.fill"
                )
                BackupCountPill(
                    value: item.preview.snippets,
                    label: BackupManager.plural(item.preview.snippets, "сниппет", "сниппета", "сниппетов"),
                    systemImage: "text.badge.plus"
                )
            }

            if item.preview.hasSecrets {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Внутри зашифрованные пароли и ключи", systemImage: "lock.fill")
                        .font(.footnote.weight(.medium))
                    SecureField("Пароль бэкапа", text: $importPassword)
                        .focused($focus, equals: .importPassword)
                        .submitLabel(.go)
                        .onSubmit {
                            guard !importPassword.isEmpty else { return }
                            Task { await runImport(item, useSecrets: true) }
                        }
                        .modifier(BackupFieldStyle())
                }
            } else {
                Label("Без паролей и приватных ключей", systemImage: "lock.open.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func importActions(_ item: PendingBackupImport) -> some View {
        GlassGroup(spacing: 10) {
            VStack(spacing: 10) {
                Button {
                    Task { await runImport(item, useSecrets: item.preview.hasSecrets) }
                } label: {
                    HStack(spacing: 8) {
                        if isImporting {
                            ProgressView()
                        } else {
                            Image(systemName: "square.and.arrow.down")
                        }
                        Text(isImporting ? "Импортирую…" : "Импортировать")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }
                .glassButtonStyle(prominent: true)
                .controlSize(.large)
                .disabled(isImporting || (item.preview.hasSecrets && importPassword.isEmpty))

                if item.preview.hasSecrets {
                    Button {
                        Task { await runImport(item, useSecrets: false) }
                    } label: {
                        Text("Импортировать без паролей и ключей")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 2)
                    }
                    .glassButtonStyle(prominent: false)
                    .disabled(isImporting)
                }
            }
        }
    }

    private func sourceLine(_ preview: BackupPreview) -> String {
        var parts = ["Из: \(preview.sourceTitle)"]
        if let date = preview.createdAt {
            parts.append(date.formatted(date: .abbreviated, time: .shortened))
        }
        if preview.knownHosts > 0 {
            let n = preview.knownHosts
            parts.append("\(n) \(BackupManager.plural(n, "отпечаток", "отпечатка", "отпечатков"))")
        }
        return parts.joined(separator: " · ")
    }

    private func handlePicked(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            do {
                let data = try BackupManager.readData(url)
                let preview = try BackupManager.inspect(data: data)
                summary = nil
                importPassword = ""
                pending = PendingBackupImport(fileName: url.lastPathComponent, data: data, preview: preview)
            } catch {
                errorMessage = error.localizedDescription
            }
        case .failure(let error):
            errorMessage = error.localizedDescription
        }
    }

    private func runImport(_ item: PendingBackupImport, useSecrets: Bool) async {
        guard !isImporting else { return }
        focus = nil
        isImporting = true
        defer { isImporting = false }
        do {
            let result = try await BackupManager.importBackupAsync(
                data: item.data,
                password: useSecrets ? importPassword : nil
            )
            summary = result
            pending = nil
            importPassword = ""
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    // MARK: - Итог

    private func resultCard(_ result: ImportSummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: result.isEmpty ? "checkmark.circle" : "checkmark.seal.fill")
                    .font(.title2)
                    .foregroundStyle(.green)
                Text(result.isEmpty ? "Нечего добавлять" : "Импорт завершён")
                    .font(.headline)
                Spacer(minLength: 0)
                Button {
                    summary = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Скрыть")
            }
            ForEach(result.lines, id: \.self) { line in
                Label(line, systemImage: "checkmark")
                    .font(.subheadline)
            }
            ForEach(result.warnings, id: \.self) { warning in
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(cornerRadius: 24, tint: Color.green.opacity(0.12))
    }
}

// MARK: - Вспомогательные элементы

private enum BackupFocus: Hashable {
    case exportPassword
    case exportRepeat
    case importPassword
}

private struct PendingBackupImport {
    let fileName: String
    let data: Data
    let preview: BackupPreview
}

/// Стеклянная карточка с заголовком; кнопки — под карточкой, подпись — ниже.
private struct BackupSection<Content: View, Actions: View>: View {
    let title: String
    let systemImage: String
    let footer: String?
    @ViewBuilder var content: () -> Content
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 14) {
                Label(title, systemImage: systemImage)
                    .font(.headline)
                content()
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(cornerRadius: 24)

            actions()

            if let footer {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
            }
        }
    }
}

private struct BackupFieldStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
            )
    }
}

private struct BackupCountPill: View {
    let value: Int
    let label: String
    let systemImage: String

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: String(value))
                .font(.title3.weight(.bold))
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// Индикатор надёжности пароля бэкапа.
private struct BackupStrengthMeter: View {
    let password: String

    private var level: Int {
        guard password.count >= BackupManager.minimumPasswordLength else { return 1 }
        var score = 0
        if password.count >= 12 { score += 1 }
        if password.count >= 16 { score += 1 }
        let hasLower = password.contains { $0.isLowercase }
        let hasUpper = password.contains { $0.isUppercase }
        let hasDigit = password.contains { $0.isNumber }
        let hasSymbol = password.contains { !$0.isLetter && !$0.isNumber }
        if hasLower && hasUpper { score += 1 }
        if hasDigit { score += 1 }
        if hasSymbol { score += 1 }
        switch score {
        case 0...1: return 2
        case 2...3: return 3
        default: return 4
        }
    }

    private var title: String {
        switch level {
        case 1: return "Слишком короткий"
        case 2: return "Слабый"
        case 3: return "Средний"
        default: return "Надёжный"
        }
    }

    private var color: Color {
        switch level {
        case 1: return .red
        case 2: return .orange
        case 3: return .yellow
        default: return .green
        }
    }

    var body: some View {
        if password.isEmpty {
            Text("Минимум \(BackupManager.minimumPasswordLength) символов. Запомните пароль — восстановить его нельзя.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            HStack(spacing: 10) {
                HStack(spacing: 4) {
                    ForEach(1...4, id: \.self) { index in
                        Capsule()
                            .fill(index <= level ? color : Color.white.opacity(0.12))
                            .frame(height: 5)
                    }
                }
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
                    .frame(minWidth: 110, alignment: .trailing)
            }
            .animation(.snappy, value: level)
        }
    }
}
