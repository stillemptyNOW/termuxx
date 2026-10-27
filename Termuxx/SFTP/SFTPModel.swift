import Foundation
import Citadel
import NIO

// MARK: - Элемент списка

/// Тип файла — для иконки, цвета и поведения при открытии.
enum RemoteFileKind: Hashable {
    case folder, link, image, video, audio, archive, code, config, text, document, key, executable, other

    var icon: String {
        switch self {
        case .folder: return "folder.fill"
        case .link: return "link"
        case .image: return "photo"
        case .video: return "film"
        case .audio: return "music.note"
        case .archive: return "archivebox.fill"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .config: return "gearshape.fill"
        case .text: return "doc.text.fill"
        case .document: return "doc.richtext.fill"
        case .key: return "key.fill"
        case .executable: return "terminal.fill"
        case .other: return "doc.fill"
        }
    }

    var colorHex: String {
        switch self {
        case .folder: return "#4EA8FF"
        case .link: return "#5CE1E6"
        case .image: return "#FF7AA2"
        case .video: return "#B48CFF"
        case .audio: return "#FFB454"
        case .archive: return "#E0B252"
        case .code: return "#3DDC97"
        case .config: return "#8FA3BF"
        case .text: return "#C7D0DA"
        case .document: return "#FF5C5C"
        case .key: return "#FFC66D"
        case .executable: return "#7AF0BC"
        case .other: return "#9AA4B2"
        }
    }

    /// Можно ли открыть во встроенном текстовом редакторе.
    var isTextual: Bool {
        switch self {
        case .code, .config, .text, .key, .executable: return true
        default: return false
        }
    }

    static func detect(name: String, isDirectory: Bool, isLink: Bool, permissions: UInt32?) -> RemoteFileKind {
        if isDirectory { return .folder }
        if isLink { return .link }
        let lower = name.lowercased()
        let ext = (lower as NSString).pathExtension
        switch ext {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "svg", "ico":
            return .image
        case "mp4", "mov", "mkv", "avi", "webm", "m4v", "flv":
            return .video
        case "mp3", "wav", "flac", "ogg", "m4a", "aac", "opus":
            return .audio
        case "zip", "gz", "tgz", "xz", "bz2", "tar", "7z", "rar", "zst", "deb", "rpm", "apk", "ipa", "iso", "img", "dmg":
            return .archive
        case "sh", "bash", "zsh", "fish", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "swift", "go", "rs", "c", "cc",
             "cpp", "h", "hpp", "rb", "php", "java", "kt", "kts", "lua", "pl", "r", "sql", "css", "scss", "html", "htm",
             "vue", "dart", "cs", "m", "mm", "zig", "nim", "ex", "exs", "erl", "hs", "ml", "scala", "groovy", "gradle":
            return .code
        case "conf", "cfg", "ini", "yml", "yaml", "toml", "json", "xml", "env", "properties", "service", "timer",
             "socket", "rules", "list", "plist", "lock", "cnf", "nginx", "htaccess":
            return .config
        case "log", "txt", "md", "markdown", "rst", "csv", "tsv", "out", "err", "diff", "patch", "srt", "nfo":
            return .text
        case "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "epub":
            return .document
        case "pem", "pub", "key", "crt", "cer", "csr", "der", "p12", "pfx", "gpg", "asc":
            return .key
        default:
            break
        }
        let textNames: Set<String> = [
            "dockerfile", "makefile", "readme", "license", "changelog", "procfile", "gemfile", "vagrantfile",
            "authorized_keys", "known_hosts", "config", "hosts", "hostname", "crontab", "fstab", "passwd", "group",
            "sudoers", "environment", "profile", "id_rsa", "id_ed25519", "id_ecdsa",
        ]
        if textNames.contains(lower) { return lower.hasPrefix("id_") ? .key : .text }
        if lower.hasPrefix(".") {
            // .bashrc, .profile, .gitignore, .env, .vimrc …
            return .config
        }
        if let p = permissions, p & 0o111 != 0 { return .executable }
        return .other
    }
}

struct RemoteItem: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let isDirectory: Bool
    let isLink: Bool
    let size: UInt64?
    let modified: Date?
    /// Только биты прав (0o777).
    let permissions: UInt32?
    let kind: RemoteFileKind

    init(name: String, isDirectory: Bool, isLink: Bool, size: UInt64?, modified: Date?, permissions: UInt32?) {
        self.name = name
        self.isDirectory = isDirectory
        self.isLink = isLink
        self.size = size
        self.modified = modified
        self.permissions = permissions
        self.kind = RemoteFileKind.detect(name: name, isDirectory: isDirectory, isLink: isLink, permissions: permissions)
    }

    var isHidden: Bool { name.hasPrefix(".") }

    var permissionString: String {
        guard let p = permissions else { return "" }
        let chars: [Character] = ["r", "w", "x"]
        var s = isDirectory ? "d" : (isLink ? "l" : "-")
        for i in (0..<9).reversed() {
            s.append((p >> UInt32(i)) & 1 == 1 ? chars[(8 - i) % 3] : "-")
        }
        return s
    }

    /// Стоит ли пробовать открыть файл как текст.
    var looksTextual: Bool {
        if isDirectory { return false }
        if kind.isTextual { return true }
        // Файлы без расширения и небольшого размера чаще всего текстовые (конфиги, скрипты).
        if kind == .other, (name as NSString).pathExtension.isEmpty, let size, size < 512 * 1024 { return true }
        return false
    }
}

// MARK: - Передача файлов

struct SFTPTransferProgress: Identifiable, Equatable {
    enum Direction: Equatable { case download, upload }

    let id = UUID()
    let name: String
    let direction: Direction
    var done: Int64 = 0
    var total: Int64?
    var bytesPerSecond: Double = 0
    /// Номер файла в очереди загрузки (1-based) и размер очереди.
    var index: Int = 1
    var count: Int = 1

    var fraction: Double? {
        guard let total, total > 0 else { return nil }
        return min(1, max(0, Double(done) / Double(total)))
    }

    var remainingSeconds: Double? {
        guard let total, bytesPerSecond > 1 else { return nil }
        return max(0, Double(total - done) / bytesPerSecond)
    }
}

enum SFTPSortOrder: String, CaseIterable, Identifiable {
    case name, size, date
    var id: String { rawValue }
    var title: String {
        switch self {
        case .name: return "По имени"
        case .size: return "По размеру"
        case .date: return "По дате"
        }
    }
    var icon: String {
        switch self {
        case .name: return "textformat"
        case .size: return "arrow.up.arrow.down"
        case .date: return "calendar"
        }
    }
}

/// Конвейерные (несколько запросов «в полёте») скачивание и загрузка. Ничего не держит целиком в памяти.
enum SFTPTransfer {
    /// Размер одного запроса чтения.
    static let readChunk: UInt32 = 64 * 1024
    /// Сколько запросов чтения одновременно в полёте.
    static let readWindow = 16
    /// Citadel режет запись на пакеты по 32 000 байт — пишем ровно такими кусками.
    static let writeChunk = 32_000
    static let writeWindow = 24

    static func download(
        sftp: SFTPClient,
        remotePath: String,
        to destination: URL,
        knownSize: UInt64?,
        onProgress: @escaping @Sendable (Int64) -> Void
    ) async throws {
        let fm = FileManager.default
        try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: destination.path) {
            try fm.removeItem(at: destination)
        }
        guard fm.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }

        let chunk = readChunk
        let window = readWindow
        try await sftp.withFile(filePath: remotePath, flags: .read) { file in
            var limit: UInt64? = knownSize.flatMap { $0 > 0 ? $0 : nil }
            if limit == nil, let attributes = try? await file.readAttributes(), let size = attributes.size, size > 0 {
                limit = size
            }
            var written: UInt64 = 0
            var finished = false

            while !finished {
                try Task.checkCancellation()

                var offsets: [UInt64] = []
                for i in 0..<window {
                    let offset = written + UInt64(i) * UInt64(chunk)
                    if let limit, offset >= limit, i > 0 { break }
                    offsets.append(offset)
                }

                let results = try await withThrowingTaskGroup(
                    of: (UInt64, ByteBuffer).self,
                    returning: [(UInt64, ByteBuffer)].self
                ) { group in
                    for offset in offsets {
                        group.addTask {
                            let data = try await file.read(from: offset, length: chunk)
                            return (offset, data)
                        }
                    }
                    var collected: [(UInt64, ByteBuffer)] = []
                    for try await result in group {
                        collected.append(result)
                    }
                    return collected.sorted { $0.0 < $1.0 }
                }

                for (offset, buffer) in results {
                    // После «короткого» ответа дальше будет дыра — перезапросим с `written`.
                    guard offset == written else { break }
                    let count = buffer.readableBytes
                    if count == 0 {
                        finished = true
                        break
                    }
                    try handle.write(contentsOf: Data(buffer.readableBytesView))
                    written += UInt64(count)
                    if count < Int(chunk) { break }
                }

                // Дошли до известного размера — дальше проверяем, не вырос ли файл (до пустого ответа).
                if let l = limit, written >= l { limit = nil }
                onProgress(Int64(written))
            }
        }
    }

    static func upload(
        sftp: SFTPClient,
        from localURL: URL,
        to remotePath: String,
        onProgress: @escaping @Sendable (Int64) -> Void
    ) async throws {
        let handle = try FileHandle(forReadingFrom: localURL)
        defer { try? handle.close() }
        let chunk = writeChunk
        let window = writeWindow

        try await sftp.withFile(filePath: remotePath, flags: [.write, .create, .truncate]) { file in
            var offset: UInt64 = 0
            var reachedEnd = false
            while !reachedEnd {
                try Task.checkCancellation()
                var batch: [(UInt64, Data)] = []
                for _ in 0..<window {
                    let data = try handle.read(upToCount: chunk) ?? Data()
                    if data.isEmpty {
                        reachedEnd = true
                        break
                    }
                    batch.append((offset, data))
                    offset += UInt64(data.count)
                }
                if batch.isEmpty { break }
                try await writeBatch(batch, to: file)
                onProgress(Int64(offset))
            }
        }
    }

    /// Записывает данные из памяти (для небольших файлов — сохранение из редактора).
    static func write(_ data: Data, to remotePath: String, sftp: SFTPClient, createIfMissing: Bool) async throws {
        let flags: SFTPOpenFileFlags = createIfMissing ? [.write, .create, .truncate] : [.write, .truncate]
        let chunk = writeChunk
        let window = writeWindow
        try await sftp.withFile(filePath: remotePath, flags: flags) { file in
            var pieces: [(UInt64, Data)] = []
            var offset = 0
            while offset < data.count {
                let end = min(offset + chunk, data.count)
                pieces.append((UInt64(offset), data.subdata(in: offset..<end)))
                offset = end
            }
            var start = 0
            while start < pieces.count {
                let end = min(start + window, pieces.count)
                try await writeBatch(Array(pieces[start..<end]), to: file)
                start = end
            }
        }
    }

    private static func writeBatch(_ batch: [(UInt64, Data)], to file: SFTPFile) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for (offset, data) in batch {
                group.addTask {
                    try await file.write(ByteBuffer(bytes: data), at: offset)
                }
            }
            try await group.waitForAll()
        }
    }

    static func readSmallFile(_ remotePath: String, sftp: SFTPClient) async throws -> Data {
        let buffer = try await sftp.withFile(filePath: remotePath, flags: .read) { file in
            try await file.readAll()
        }
        return Data(buffer.readableBytesView)
    }
}

// MARK: - Модель браузера

@MainActor
final class SFTPModel: ObservableObject {
    let server: Server
    private let password: String?

    @Published var path = "/"
    @Published private(set) var items: [RemoteItem] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isConnected = false
    /// Ошибка подключения (показывается на экране, а не алертом).
    @Published private(set) var connectionError: String?
    @Published var busyText: String?
    @Published var error: String?
    @Published var transfer: SFTPTransferProgress?
    @Published var trustRequest: HostKeyRequest?
    @Published var search = ""
    @Published var showHidden: Bool {
        didSet { UserDefaults.standard.set(showHidden, forKey: "sftpShowHidden") }
    }
    @Published var sortOrder: SFTPSortOrder {
        didSet { UserDefaults.standard.set(sortOrder.rawValue, forKey: "sftpSortOrder") }
    }

    private(set) var homePath = "/"
    private var connection: SSHConnection?
    private var sftp: SFTPClient?
    private var isConnecting = false
    private var transferWork: Task<Void, Error>?
    private var lastSample: (time: Date, done: Int64)?

    init(server: Server, password: String?) {
        self.server = server
        self.password = password
        self.showHidden = UserDefaults.standard.bool(forKey: "sftpShowHidden")
        self.sortOrder = SFTPSortOrder(rawValue: UserDefaults.standard.string(forKey: "sftpSortOrder") ?? "") ?? .name
    }

    // MARK: Список

    var visibleItems: [RemoteItem] {
        var list = showHidden ? items : items.filter { !$0.isHidden }
        let query = search.trimmingCharacters(in: .whitespaces)
        if !query.isEmpty {
            list = list.filter { $0.name.localizedCaseInsensitiveContains(query) }
        }
        return list.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            switch sortOrder {
            case .name:
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            case .size:
                let sa = a.size ?? 0, sb = b.size ?? 0
                if sa != sb { return sa > sb }
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            case .date:
                let da = a.modified ?? .distantPast, db = b.modified ?? .distantPast
                if da != db { return da > db }
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            }
        }
    }

    var hiddenCount: Int { items.filter(\.isHidden).count }

    var breadcrumbs: [(name: String, path: String)] {
        var result: [(String, String)] = [("/", "/")]
        var current = ""
        for part in path.split(separator: "/") {
            current += "/" + part
            result.append((String(part), current))
        }
        return result
    }

    func fullPath(_ name: String) -> String {
        path == "/" ? "/" + name : path + "/" + name
    }

    func contains(name: String) -> Bool {
        items.contains { $0.name == name }
    }

    // MARK: Подключение

    /// Подключается (если ещё не подключены) и показывает домашнюю папку.
    func start() async {
        if let sftp, sftp.isActive { return }
        guard await openConnection(resetPath: true) else { return }
        await reload()
    }

    var connectionFailed: Bool { connectionError != nil }

    func retry() async {
        error = nil
        connectionError = nil
        await start()
    }

    private func openConnection(resetPath: Bool) async -> Bool {
        guard !isConnecting else { return false }
        isConnecting = true
        isLoading = true
        connectionError = nil
        defer {
            isConnecting = false
            isLoading = false
        }
        do {
            let connection = try await SSHConnector.connect(server, password: password)
            self.connection = connection
            do {
                let sftp = try await connection.client.openSFTP()
                self.sftp = sftp
            } catch {
                self.connection = nil
                await connection.close()
                throw error
            }
            isConnected = true
            if resetPath, let sftp {
                homePath = (try? await sftp.getRealPath(atPath: ".")) ?? "/"
                path = homePath
            }
            return true
        } catch {
            isConnected = false
            if let request = error.hostKeyRequest {
                trustRequest = request
            } else {
                connectionError = Self.describe(error)
            }
            return false
        }
    }

    /// Живой SFTP-клиент; при обрыве переподключается, сохраняя текущую папку.
    private func activeClient() async -> SFTPClient? {
        if let sftp, sftp.isActive { return sftp }
        if sftp != nil || connection != nil { teardown() }
        guard await openConnection(resetPath: false) else { return nil }
        return sftp
    }

    private func teardown() {
        let sftp = self.sftp, connection = self.connection
        self.sftp = nil
        self.connection = nil
        isConnected = false
        Task {
            try? await sftp?.close()
            await connection?.close()
        }
    }

    func close() {
        transferWork?.cancel()
        transferWork = nil
        teardown()
    }

    // MARK: Навигация

    @discardableResult
    func reload() async -> Bool {
        guard let sftp = await activeClient() else { return false }
        isLoading = true
        defer { isLoading = false }
        do {
            let names = try await sftp.listDirectory(atPath: path)
            items = names.flatMap { $0.components }
                .filter { $0.filename != "." && $0.filename != ".." }
                .map { c in
                    let mode = c.attributes.permissions ?? 0
                    let type = mode & 0o170000
                    let longDir = c.longname.hasPrefix("d")
                    let longLink = c.longname.hasPrefix("l")
                    return RemoteItem(
                        name: c.filename,
                        isDirectory: type == 0o040000 || (type == 0 && longDir),
                        isLink: type == 0o120000 || (type == 0 && longLink),
                        size: c.attributes.size,
                        modified: c.attributes.accessModificationTime?.modificationTime,
                        permissions: c.attributes.permissions.map { $0 & 0o777 }
                    )
                }
            return true
        } catch {
            self.error = "Не удалось открыть \(path): \(Self.describe(error))"
            return false
        }
    }

    func go(to newPath: String) async {
        let previous = path
        path = newPath.isEmpty ? "/" : newPath
        search = ""
        if !(await reload()) {
            path = previous
        }
    }

    func goUp() async {
        guard path != "/" else { return }
        let parent = (path as NSString).deletingLastPathComponent
        await go(to: parent.isEmpty ? "/" : parent)
    }

    func goHome() async {
        await go(to: homePath)
    }

    /// Открывает папку (или ссылку на папку). Возвращает `false`, если это файл.
    func enter(_ item: RemoteItem) async -> Bool {
        let target = fullPath(item.name)
        if item.isDirectory {
            await go(to: target)
            return true
        }
        guard item.isLink, let sftp = await activeClient() else { return false }
        // stat идёт по ссылке: узнаём, куда она ведёт.
        if let attributes = try? await sftp.getAttributes(at: target),
           let mode = attributes.permissions, mode & 0o170000 == 0o040000 {
            let real = (try? await sftp.getRealPath(atPath: target)) ?? target
            await go(to: real)
            return true
        }
        return false
    }

    // MARK: Операции с файлами

    func makeDirectory(_ name: String) async {
        guard Self.isValidName(name) else {
            error = "Недопустимое имя."
            return
        }
        guard !contains(name: name) else {
            error = "«\(name)» уже существует."
            return
        }
        await perform("Создаю папку…") { sftp in
            try await sftp.createDirectory(atPath: self.fullPath(name))
        }
    }

    func delete(_ item: RemoteItem) async {
        guard let sftp = await activeClient() else { return }
        busyText = "Удаляю…"
        do {
            if item.isDirectory {
                try await sftp.rmdir(at: fullPath(item.name))
            } else {
                try await sftp.remove(at: fullPath(item.name))
            }
        } catch let status as SFTPMessage.Status where item.isDirectory && status.errorCode == .failure {
            error = "Папка «\(item.name)» не пуста. Сначала удалите её содержимое."
        } catch {
            self.error = "Не удалось удалить «\(item.name)»: \(Self.describe(error))"
        }
        busyText = nil
        await reload()
    }

    func rename(_ item: RemoteItem, to newName: String) async {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != item.name else { return }
        guard Self.isValidName(name) else {
            error = "Недопустимое имя."
            return
        }
        guard !contains(name: name) else {
            error = "«\(name)» уже существует."
            return
        }
        await perform("Переименовываю…") { sftp in
            try await sftp.rename(at: self.fullPath(item.name), to: self.fullPath(name))
        }
    }

    private func perform(_ text: String, _ op: (SFTPClient) async throws -> Void) async {
        guard let sftp = await activeClient() else { return }
        busyText = text
        do {
            try await op(sftp)
        } catch {
            self.error = Self.describe(error)
        }
        busyText = nil
        await reload()
    }

    // MARK: Передача

    var isTransferring: Bool { transfer != nil }

    func cancelTransfer() {
        transferWork?.cancel()
    }

    private func beginTransfer(_ progress: SFTPTransferProgress) {
        transfer = progress
        lastSample = (Date(), 0)
    }

    private func updateTransfer(id: UUID, done: Int64) {
        guard var current = transfer, current.id == id else { return }
        let now = Date()
        if let sample = lastSample {
            let dt = now.timeIntervalSince(sample.time)
            if dt >= 0.25 {
                let rate = Double(done - sample.done) / dt
                current.bytesPerSecond = current.bytesPerSecond == 0 ? rate : current.bytesPerSecond * 0.7 + rate * 0.3
                lastSample = (now, done)
            }
        } else {
            lastSample = (now, done)
        }
        current.done = done
        transfer = current
    }

    private func progressReporter(for id: UUID) -> @Sendable (Int64) -> Void {
        { [weak self] done in
            Task { @MainActor in
                self?.updateTransfer(id: id, done: done)
            }
        }
    }

    static var downloadsDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Downloads", isDirectory: true)
    }

    /// Скачивает файл в «Файлы → Termuxx → Downloads». Возвращает локальный URL.
    func download(_ item: RemoteItem) async -> URL? {
        guard !isTransferring else {
            error = "Дождитесь окончания текущей передачи."
            return nil
        }
        guard let sftp = await activeClient() else { return nil }
        let remote = fullPath(item.name)
        let destination = Self.downloadsDirectory.appendingPathComponent(item.name)
        let progress = SFTPTransferProgress(
            name: item.name,
            direction: .download,
            total: item.size.flatMap { $0 > 0 ? Int64($0) : nil }
        )
        beginTransfer(progress)
        let report = progressReporter(for: progress.id)
        let size = item.size
        let work = Task.detached(priority: .userInitiated) {
            try await SFTPTransfer.download(sftp: sftp, remotePath: remote, to: destination, knownSize: size, onProgress: report)
        }
        transferWork = work
        do {
            try await work.value
            transfer = nil
            transferWork = nil
            return destination
        } catch {
            transfer = nil
            transferWork = nil
            try? FileManager.default.removeItem(at: destination)
            if !(error is CancellationError) && !work.isCancelled {
                self.error = "Ошибка скачивания: \(Self.describe(error))"
            }
            return nil
        }
    }

    /// Загружает файлы в текущую папку по очереди.
    func upload(_ urls: [URL]) async {
        guard !urls.isEmpty else { return }
        guard !isTransferring else {
            error = "Дождитесь окончания текущей передачи."
            return
        }
        guard let sftp = await activeClient() else { return }

        for (index, url) in urls.enumerated() {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            let name = url.lastPathComponent
            let remote = fullPath(name)
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map { Int64($0) }
            let progress = SFTPTransferProgress(
                name: name,
                direction: .upload,
                total: size,
                index: index + 1,
                count: urls.count
            )
            beginTransfer(progress)
            let report = progressReporter(for: progress.id)
            let work = Task.detached(priority: .userInitiated) {
                try await SFTPTransfer.upload(sftp: sftp, from: url, to: remote, onProgress: report)
            }
            transferWork = work
            do {
                try await work.value
            } catch {
                transfer = nil
                transferWork = nil
                let cancelled = error is CancellationError || work.isCancelled
                if cancelled {
                    // Недокачанный файл на сервере не оставляем.
                    try? await sftp.remove(at: remote)
                } else {
                    self.error = "Ошибка загрузки «\(name)»: \(Self.describe(error))"
                }
                await reload()
                return
            }
        }
        transfer = nil
        transferWork = nil
        await reload()
    }

    // MARK: Редактор

    static let editorLimit: UInt64 = 2 * 1024 * 1024

    /// Читает текстовый файл. `nil` — не текст или ошибка (сообщение в `error`, кроме «не текст»).
    func readText(_ item: RemoteItem) async -> String? {
        if let size = item.size, size > Self.editorLimit {
            error = "Файл слишком большой для редактора (больше 2 МБ). Скачайте его."
            return nil
        }
        guard let sftp = await activeClient() else { return nil }
        busyText = "Открываю…"
        defer { busyText = nil }
        do {
            let data = try await SFTPTransfer.readSmallFile(fullPath(item.name), sftp: sftp)
            if data.isEmpty { return "" }
            if data.prefix(8192).contains(0) { return nil }
            if let text = String(data: data, encoding: .utf8) { return text }
            if let text = String(data: data, encoding: .windowsCP1251) { return text }
            return nil
        } catch {
            self.error = "Не удалось открыть «\(item.name)»: \(Self.describe(error))"
            return nil
        }
    }

    func writeText(_ text: String, to name: String, isNew: Bool) async -> Bool {
        let fileName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidName(fileName) else {
            error = "Недопустимое имя файла."
            return false
        }
        if isNew && contains(name: fileName) {
            error = "Файл «\(fileName)» уже существует."
            return false
        }
        guard let sftp = await activeClient() else { return false }
        busyText = "Сохраняю…"
        defer { busyText = nil }
        do {
            try await SFTPTransfer.write(Data(text.utf8), to: fullPath(fileName), sftp: sftp, createIfMissing: true)
            await reload()
            return true
        } catch {
            self.error = "Не удалось сохранить: \(Self.describe(error))"
            return false
        }
    }

    // MARK: Утилиты

    static func isValidName(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != "." && trimmed != ".." && !trimmed.contains("/")
    }

    static func describe(_ error: Error) -> String {
        if let status = error as? SFTPMessage.Status {
            return describe(status: status)
        }
        if let sftpError = error as? SFTPError {
            switch sftpError {
            case .errorStatus(let status):
                return describe(status: status)
            case .connectionClosed:
                return "Соединение закрыто."
            case .missingResponse:
                return "Сервер не ответил. Возможно, SFTP на нём отключён."
            case .fileHandleInvalid:
                return "Файл уже закрыт."
            case .unsupportedVersion:
                return "Сервер использует неподдерживаемую версию SFTP."
            default:
                return "Ошибка протокола SFTP."
            }
        }
        if error is CancellationError { return "Отменено." }
        if let cocoa = error as? CocoaError {
            return cocoa.localizedDescription
        }
        return TerminalSession.describe(error)
    }

    private static func describe(status: SFTPMessage.Status) -> String {
        switch status.errorCode {
        case .noSuchFile:
            return "Файл или папка не найдены."
        case .permissionDenied:
            return "Нет прав доступа."
        case .noConnection, .connectionLost:
            return "Соединение потеряно."
        case .unsupportedOperation:
            return "Сервер не поддерживает эту операцию."
        case .failure:
            return status.message.isEmpty ? "Сервер вернул ошибку." : "Ошибка сервера: \(status.message)"
        default:
            return status.message.isEmpty ? "Ошибка SFTP." : status.message
        }
    }
}
