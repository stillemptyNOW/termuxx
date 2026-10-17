import Foundation
import Citadel
import NIO

struct RemoteItem: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let isDirectory: Bool
    let isLink: Bool
    let size: UInt64?
    let modified: Date?
    let permissions: UInt32?

    var permissionString: String {
        guard let p = permissions else { return "" }
        let chars: [Character] = ["r", "w", "x"]
        var s = isDirectory ? "d" : (isLink ? "l" : "-")
        for i in (0..<9).reversed() {
            s.append((p >> UInt32(i)) & 1 == 1 ? chars[(8 - i) % 3] : "-")
        }
        return s
    }

    var icon: String {
        if isDirectory { return "folder.fill" }
        if isLink { return "link" }
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "png", "jpg", "jpeg", "gif", "webp", "heic": return "photo"
        case "mp4", "mov", "mkv", "avi": return "film"
        case "mp3", "wav", "flac", "ogg", "m4a": return "music.note"
        case "zip", "gz", "tgz", "xz", "bz2", "tar", "7z", "rar": return "archivebox"
        case "sh", "py", "js", "ts", "swift", "go", "rs", "c", "cpp", "h", "rb", "php", "java", "kt": return "chevron.left.forwardslash.chevron.right"
        case "conf", "cfg", "ini", "yml", "yaml", "toml", "json", "xml", "env": return "gearshape"
        case "log", "txt", "md": return "doc.text"
        case "pem", "key", "pub", "crt": return "key"
        default: return "doc"
        }
    }
}

@MainActor
final class SFTPModel: ObservableObject {
    let server: Server
    private let password: String?

    @Published var path = "/"
    @Published var items: [RemoteItem] = []
    @Published var isLoading = false
    @Published var busyText: String?
    @Published var error: String?
    @Published var showHidden = false

    private var client: SSHClient?
    private var sftp: SFTPClient?

    init(server: Server, password: String?) {
        self.server = server
        self.password = password
    }

    var visibleItems: [RemoteItem] {
        showHidden ? items : items.filter { !$0.name.hasPrefix(".") }
    }

    func connect() async {
        guard sftp == nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let client = try await SSHConnector.connect(server, password: password)
            self.client = client
            let sftp = try await client.openSFTP()
            self.sftp = sftp
            path = (try? await sftp.getRealPath(atPath: ".")) ?? "/"
            await reload()
        } catch {
            self.error = TerminalSession.describe(error)
        }
    }

    func close() {
        let sftp = self.sftp, client = self.client
        self.sftp = nil
        self.client = nil
        Task {
            try? await sftp?.close()
            try? await client?.close()
        }
    }

    func reload() async {
        guard let sftp else { return }
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
                .sorted { a, b in
                    if a.isDirectory != b.isDirectory { return a.isDirectory }
                    return a.name.localizedStandardCompare(b.name) == .orderedAscending
                }
        } catch {
            self.error = "Не удалось открыть \(path): \(TerminalSession.describe(error))"
        }
    }

    func fullPath(_ name: String) -> String {
        path == "/" ? "/" + name : path + "/" + name
    }

    func open(_ item: RemoteItem) async -> Bool {
        let target = fullPath(item.name)
        if item.isDirectory || item.isLink {
            let previous = path
            path = (try? await sftp?.getRealPath(atPath: target)) ?? target
            await reload()
            if error != nil && item.isLink {
                // Ссылка на файл, а не на папку.
                error = nil
                path = previous
                await reload()
                return false
            }
            return true
        }
        return false
    }

    func go(to newPath: String) async {
        path = newPath.isEmpty ? "/" : newPath
        await reload()
    }

    func goUp() async {
        guard path != "/" else { return }
        let parent = (path as NSString).deletingLastPathComponent
        await go(to: parent.isEmpty ? "/" : parent)
    }

    var breadcrumbs: [(name: String, path: String)] {
        var result: [(String, String)] = [("/", "/")]
        var current = ""
        for part in path.split(separator: "/") {
            current += "/" + part
            result.append((String(part), current))
        }
        return result
    }

    // MARK: Операции

    func makeDirectory(_ name: String) async {
        await perform("Создаю папку…") { sftp in
            try await sftp.createDirectory(atPath: self.fullPath(name))
        }
    }

    func delete(_ item: RemoteItem) async {
        await perform("Удаляю…") { sftp in
            if item.isDirectory {
                try await sftp.rmdir(at: self.fullPath(item.name))
            } else {
                try await sftp.remove(at: self.fullPath(item.name))
            }
        }
    }

    func rename(_ item: RemoteItem, to newName: String) async {
        await perform("Переименовываю…") { sftp in
            try await sftp.rename(at: self.fullPath(item.name), to: self.fullPath(newName))
        }
    }

    func download(_ item: RemoteItem) async -> URL? {
        guard let sftp else { return nil }
        busyText = "Скачиваю \(item.name)…"
        defer { busyText = nil }
        do {
            let remote = fullPath(item.name)
            let buffer = try await sftp.withFile(filePath: remote, flags: .read) { file in
                try await file.readAll()
            }
            let data = Data(buffer.readableBytesView)
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Downloads", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(item.name)
            try? FileManager.default.removeItem(at: url)
            try data.write(to: url)
            return url
        } catch {
            self.error = "Ошибка скачивания: \(TerminalSession.describe(error))"
            return nil
        }
    }

    func upload(_ localURL: URL) async {
        let scoped = localURL.startAccessingSecurityScopedResource()
        defer { if scoped { localURL.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: localURL) else {
            error = "Не удалось прочитать файл."
            return
        }
        let remote = fullPath(localURL.lastPathComponent)
        await perform("Загружаю \(localURL.lastPathComponent)…") { sftp in
            try await Self.write(data, to: remote, sftp: sftp)
        }
    }

    func readText(_ item: RemoteItem) async -> String? {
        guard let sftp else { return nil }
        if let size = item.size, size > 2_000_000 {
            error = "Файл слишком большой для редактора (больше 2 МБ)."
            return nil
        }
        busyText = "Открываю…"
        defer { busyText = nil }
        do {
            let buffer = try await sftp.withFile(filePath: fullPath(item.name), flags: .read) { file in
                try await file.readAll()
            }
            guard let text = String(data: Data(buffer.readableBytesView), encoding: .utf8) else {
                error = "Это не текстовый файл."
                return nil
            }
            return text
        } catch {
            self.error = TerminalSession.describe(error)
            return nil
        }
    }

    func writeText(_ text: String, to name: String) async -> Bool {
        guard let sftp else { return false }
        busyText = "Сохраняю…"
        defer { busyText = nil }
        do {
            try await Self.write(Data(text.utf8), to: fullPath(name), sftp: sftp)
            await reload()
            return true
        } catch {
            self.error = "Не удалось сохранить: \(TerminalSession.describe(error))"
            return false
        }
    }

    private static func write(_ data: Data, to remote: String, sftp: SFTPClient) async throws {
        try await sftp.withFile(filePath: remote, flags: [.write, .create, .truncate]) { file in
            let chunk = 32 * 1024
            var offset = 0
            while offset < data.count {
                let end = min(offset + chunk, data.count)
                try await file.write(ByteBuffer(bytes: data[offset..<end]), at: UInt64(offset))
                offset = end
            }
        }
    }

    private func perform(_ text: String, _ op: @escaping (SFTPClient) async throws -> Void) async {
        guard let sftp else { return }
        busyText = text
        do {
            try await op(sftp)
        } catch {
            self.error = TerminalSession.describe(error)
        }
        busyText = nil
        await reload()
    }
}
