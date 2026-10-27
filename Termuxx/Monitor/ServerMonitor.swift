import Foundation
import SwiftUI
import Citadel
import NIO

// MARK: - Модели

struct CPUSample: Identifiable, Hashable {
    let id: Int
    let date: Date
    let value: Double
}

struct NetSample: Identifiable, Hashable {
    let id: Int
    let date: Date
    let rx: Double
    let tx: Double
}

struct DiskInfo: Identifiable, Hashable {
    var id: String { mount }
    let filesystem: String
    let mount: String
    let total: UInt64
    let used: UInt64

    var fraction: Double { total > 0 ? min(1, Double(used) / Double(total)) : 0 }
}

struct RemoteProcess: Identifiable, Hashable {
    let id: Int
    let name: String
    let cpu: Double
    let mem: Double
}

struct ServiceInfo: Identifiable, Hashable {
    var id: String { unit }
    let unit: String
    let load: String
    let active: String
    let sub: String
    let description: String

    var name: String { unit.hasSuffix(".service") ? String(unit.dropLast(8)) : unit }
    var isFailed: Bool { active == "failed" || sub == "failed" }
    var isRunning: Bool { active == "active" && (sub == "running" || sub == "exited" || sub == "listening") }
}

struct ContainerInfo: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let status: String
    let image: String

    var isRunning: Bool { status.hasPrefix("Up") }
    var isUnhealthy: Bool { status.contains("unhealthy") || status.contains("Restarting") }
}

struct MonitorSnapshot {
    var hostname = ""
    var os = ""
    var kernel = ""
    var uptime: TimeInterval = 0
    var load: [Double] = [0, 0, 0]
    var cores = 1
    var cpuPercent: Double?
    var memTotal: UInt64 = 0
    var memAvailable: UInt64 = 0
    var swapTotal: UInt64 = 0
    var swapFree: UInt64 = 0
    var disks: [DiskInfo] = []
    var processes: [RemoteProcess] = []
    var rxRate: Double?
    var txRate: Double?
    var rxTotal: UInt64 = 0
    var txTotal: UInt64 = 0
    var isRoot = false
    var updatedAt = Date()

    var memUsed: UInt64 { memTotal > memAvailable ? memTotal - memAvailable : 0 }
    var memFraction: Double { memTotal > 0 ? Double(memUsed) / Double(memTotal) : 0 }
    var swapUsed: UInt64 { swapTotal > swapFree ? swapTotal - swapFree : 0 }
    var swapFraction: Double { swapTotal > 0 ? Double(swapUsed) / Double(swapTotal) : 0 }
}

enum ServiceAction: String, Identifiable {
    case restart, start, stop

    var id: String { rawValue }

    var title: String {
        switch self {
        case .restart: return "Перезапустить"
        case .start: return "Запустить"
        case .stop: return "Остановить"
        }
    }

    var icon: String {
        switch self {
        case .restart: return "arrow.clockwise"
        case .start: return "play.fill"
        case .stop: return "stop.fill"
        }
    }

    var isDestructive: Bool { self != .start }
}

// MARK: - Форматирование

enum MonitorFormat {
    static func bytes(_ value: Double) -> String {
        let units = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"]
        var v = max(0, value)
        var i = 0
        while v >= 1024 && i < units.count - 1 {
            v /= 1024
            i += 1
        }
        if i == 0 { return "\(Int(v)) \(units[i])" }
        return String(format: v < 10 ? "%.1f %@" : "%.0f %@", v, units[i])
    }

    static func bytes(_ value: UInt64) -> String { bytes(Double(value)) }

    static func rate(_ value: Double?) -> String {
        guard let value else { return "—" }
        return bytes(value) + "/с"
    }

    static func uptime(_ seconds: TimeInterval) -> String {
        let total = Int(seconds)
        let days = total / 86_400
        let hours = (total % 86_400) / 3600
        let minutes = (total % 3600) / 60
        if days > 0 { return "\(days) д \(hours) ч" }
        if hours > 0 { return "\(hours) ч \(minutes) мин" }
        return "\(max(minutes, 0)) мин"
    }

    static func percent(_ fraction: Double) -> String {
        "\(Int((fraction * 100).rounded()))%"
    }
}

// MARK: - Монитор

@MainActor
final class ServerMonitor: ObservableObject {
    enum Status: Equatable {
        case idle
        case connecting
        case live
        case reconnecting(String)
        case failed(String)
    }

    let server: Server
    private let password: String?

    @Published private(set) var status: Status = .idle
    @Published private(set) var snapshot: MonitorSnapshot?
    @Published private(set) var cpuHistory: [CPUSample] = []
    @Published private(set) var netHistory: [NetSample] = []
    @Published private(set) var services: [ServiceInfo] = []
    @Published private(set) var containers: [ContainerInfo] = []
    @Published private(set) var hasSystemd = true
    @Published private(set) var isRefreshingServices = false
    @Published var trustRequest: HostKeyRequest?
    @Published var toast: String?

    private var connection: SSHConnection?
    private var connectTask: Task<SSHConnection, Error>?
    private var pollTask: Task<Void, Never>?
    private var loopID = UUID()
    private var toastTask: Task<Void, Never>?
    private var prevCPU: (total: UInt64, idle: UInt64)?
    private var prevNet: (rx: UInt64, tx: UInt64, time: Date)?
    private var sampleCounter = 0
    private var lastServicesRefresh: Date?
    private var isRoot = false

    private let historyLimit = 60
    private let pollInterval: UInt64 = 3_000_000_000

    init(server: Server, password: String?) {
        self.server = server
        self.password = password
    }

    var isLive: Bool { status == .live }

    // MARK: Жизненный цикл

    /// Запускает (или возобновляет) опрос.
    func start() {
        guard pollTask == nil, trustRequest == nil else { return }
        if case .failed = status { status = .idle }
        let id = UUID()
        loopID = id
        pollTask = Task { [weak self] in
            await self?.loop(id: id)
        }
    }

    /// Ставит опрос на паузу (соединение сохраняется, если iOS его не закроет).
    func pause() {
        loopID = UUID()
        pollTask?.cancel()
        pollTask = nil
    }

    /// Полностью останавливает монитор и закрывает соединение.
    func shutdown() {
        pause()
        let connection = self.connection
        self.connection = nil
        Task { await connection?.close() }
        status = .idle
    }

    /// Перезапуск после доверия ключу или ошибки.
    func restart() {
        pause()
        let connection = self.connection
        self.connection = nil
        Task { await connection?.close() }
        status = .idle
        start()
    }

    func refreshAll() async {
        do {
            try await ensureConnected()
            try await poll()
            await refreshServices()
        } catch {
            handle(error)
        }
    }

    private func loop(id: UUID) async {
        var failures = 0
        while !Task.isCancelled && loopID == id {
            do {
                try await ensureConnected()
                try await poll()
                failures = 0
                if lastServicesRefresh == nil || Date().timeIntervalSince(lastServicesRefresh!) > 30 {
                    await refreshServices()
                }
                try await Task.sleep(nanoseconds: pollInterval)
            } catch is CancellationError {
                break
            } catch {
                if Task.isCancelled || loopID != id { break }
                if let request = error.hostKeyRequest {
                    trustRequest = request
                    status = .failed("Подтвердите ключ сервера")
                    break
                }
                let message = TerminalSession.describe(error)
                if error is TermuxxError || TerminalSession.isFatal(error) {
                    status = .failed(message)
                    break
                }
                failures += 1
                status = .reconnecting(message)
                dropConnection()
                let delay = UInt64(min(failures, 5)) * 2_000_000_000
                do {
                    try await Task.sleep(nanoseconds: delay)
                } catch {
                    break
                }
            }
        }
        if loopID == id { pollTask = nil }
    }

    private func handle(_ error: Error) {
        if let request = error.hostKeyRequest {
            trustRequest = request
            status = .failed("Подтвердите ключ сервера")
            return
        }
        showToast(TerminalSession.describe(error))
    }

    private func ensureConnected() async throws {
        if let connection, connection.isConnected { return }
        if let pending = connectTask {
            // Кто-то уже подключается — ждём его, а не открываем второе соединение.
            self.connection = try await pending.value
            return
        }
        dropConnection()
        if snapshot == nil { status = .connecting }
        let server = self.server
        let password = self.password
        let task = Task { @MainActor in
            try await SSHConnector.connect(server, password: password)
        }
        connectTask = task
        defer { connectTask = nil }
        let connection = try await task.value
        self.connection = connection
        prevCPU = nil
        prevNet = nil
        try Task.checkCancellation()
    }

    private func dropConnection() {
        let connection = self.connection
        self.connection = nil
        if let connection {
            Task { await connection.close() }
        }
    }

    // MARK: Выполнение команд

    /// Выполняет команду и возвращает весь вывод (stdout + stderr) и код выхода.
    private func execute(_ command: String, maxBytes: Int = 2_000_000) async throws -> (output: String, exitCode: Int) {
        guard let connection else { throw MonitorError.notConnected }
        let stream = try await connection.client.executeCommandStream(command)
        var buffer = ByteBuffer()
        var exitCode = 0
        do {
            for try await chunk in stream {
                switch chunk {
                case .stdout(let part), .stderr(let part):
                    if buffer.readableBytes < maxBytes {
                        buffer.writeImmutableBuffer(part)
                    }
                }
            }
        } catch let failed as SSHClient.CommandFailed {
            exitCode = failed.exitCode
        }
        return (String(buffer: buffer), exitCode)
    }

    /// Оборачивает скрипт в `sh -c '…'`, чтобы он работал при любом shell пользователя (bash, zsh, fish).
    static func sh(_ script: String) -> String {
        "sh -c '" + script.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    /// Экранирует аргумент для shell.
    static func quote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    private static let metricsScript = """
    export LC_ALL=C
    echo @@UID; id -u 2>/dev/null
    echo @@LOADAVG; cat /proc/loadavg 2>/dev/null
    echo @@NPROC; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null
    echo @@STAT; head -n 1 /proc/stat 2>/dev/null
    echo @@MEM; grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null
    echo @@DISK; df -kP 2>/dev/null | tail -n +2
    echo @@UPTIME; cat /proc/uptime 2>/dev/null
    echo @@HOST; hostname 2>/dev/null || cat /etc/hostname 2>/dev/null
    echo @@OS; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" )
    echo @@KERNEL; uname -r 2>/dev/null
    echo @@NET; tail -n +3 /proc/net/dev 2>/dev/null
    echo @@PROC; ps -eo pid=,comm=,pcpu=,pmem= --sort=-pcpu 2>/dev/null | head -n 8
    echo @@END
    """

    private static let servicesScript = """
    export LC_ALL=C
    echo @@SVC
    if command -v systemctl >/dev/null 2>&1; then systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null; else echo @@NOSYSTEMD; fi
    echo @@DOCKER
    if command -v docker >/dev/null 2>&1; then docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null || sudo -n docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null; fi
    echo @@END
    """

    // MARK: Метрики

    private func poll() async throws {
        let (output, _) = try await execute(Self.sh(Self.metricsScript))
        try Task.checkCancellation()
        let sections = Self.sections(output)
        guard sections["END"] != nil else {
            throw MonitorError.badOutput
        }
        var snap = MonitorSnapshot()
        snap.updatedAt = Date()

        if let uid = sections["UID"]?.first?.trimmingCharacters(in: .whitespaces) {
            isRoot = uid == "0"
            snap.isRoot = isRoot
        }

        if let line = sections["LOADAVG"]?.first {
            let parts = line.split(separator: " ")
            snap.load = parts.prefix(3).compactMap { Double($0) }
            while snap.load.count < 3 { snap.load.append(0) }
        }
        if let line = sections["NPROC"]?.first, let n = Int(line.trimmingCharacters(in: .whitespaces)), n > 0 {
            snap.cores = n
        }

        // CPU — по разнице двух замеров /proc/stat.
        if let line = sections["STAT"]?.first {
            let values = line.split(separator: " ").dropFirst().compactMap { UInt64($0) }
            if values.count >= 4 {
                let total = values.prefix(8).reduce(0, +)
                let idle = values[3] + (values.count > 4 ? values[4] : 0)
                if let prev = prevCPU, total > prev.total {
                    let dTotal = Double(total - prev.total)
                    let dIdle = Double(idle >= prev.idle ? idle - prev.idle : 0)
                    snap.cpuPercent = max(0, min(100, (1 - dIdle / dTotal) * 100))
                }
                prevCPU = (total, idle)
            }
        }

        // Память.
        var mem: [String: UInt64] = [:]
        for line in sections["MEM"] ?? [] {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let number = parts[1].split(separator: " ").first.flatMap { UInt64($0) } ?? 0
            mem[String(parts[0])] = number * 1024
        }
        snap.memTotal = mem["MemTotal"] ?? 0
        snap.memAvailable = mem["MemAvailable"]
            ?? ((mem["MemFree"] ?? 0) + (mem["Buffers"] ?? 0) + (mem["Cached"] ?? 0))
        snap.swapTotal = mem["SwapTotal"] ?? 0
        snap.swapFree = mem["SwapFree"] ?? 0

        // Диски: только настоящие устройства, без loop/tmpfs/overlay.
        var seen = Set<String>()
        var disks: [DiskInfo] = []
        for line in sections["DISK"] ?? [] {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard parts.count >= 6, let total = UInt64(parts[1]), let used = UInt64(parts[2]) else { continue }
            let fs = parts[0]
            let mount = parts[5...].joined(separator: " ")
            let isDevice = fs.hasPrefix("/dev/") && !fs.hasPrefix("/dev/loop")
            guard (isDevice || mount == "/"), total > 0, !seen.contains(fs) else { continue }
            if mount.hasPrefix("/snap") || mount.hasPrefix("/boot/efi") { continue }
            seen.insert(fs)
            disks.append(DiskInfo(filesystem: fs, mount: mount, total: total * 1024, used: used * 1024))
        }
        snap.disks = disks.sorted { a, b in
            if a.mount == "/" { return true }
            if b.mount == "/" { return false }
            return a.total > b.total
        }

        if let line = sections["UPTIME"]?.first, let first = line.split(separator: " ").first, let up = Double(first) {
            snap.uptime = up
        }
        snap.hostname = sections["HOST"]?.first?.trimmingCharacters(in: .whitespaces) ?? ""
        snap.os = sections["OS"]?.first?.trimmingCharacters(in: .whitespaces) ?? ""
        snap.kernel = sections["KERNEL"]?.first?.trimmingCharacters(in: .whitespaces) ?? ""

        // Сеть — сумма «настоящих» интерфейсов.
        var interfaces: [(name: String, rx: UInt64, tx: UInt64)] = []
        for line in sections["NET"] ?? [] {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let name = parts[0].trimmingCharacters(in: .whitespaces)
            let fields = parts[1].split(separator: " ", omittingEmptySubsequences: true).compactMap { UInt64($0) }
            guard fields.count >= 9 else { continue }
            interfaces.append((name, fields[0], fields[8]))
        }
        let virtualPrefixes = ["lo", "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "vnet", "kube", "tun", "wg", "tailscale", "zt", "ifb"]
        var physical = interfaces.filter { iface in !virtualPrefixes.contains { iface.name.hasPrefix($0) } }
        if physical.isEmpty { physical = interfaces.filter { $0.name != "lo" } }
        let rx = physical.reduce(UInt64(0)) { $0 + $1.rx }
        let tx = physical.reduce(UInt64(0)) { $0 + $1.tx }
        snap.rxTotal = rx
        snap.txTotal = tx
        let now = Date()
        if let prev = prevNet {
            let dt = now.timeIntervalSince(prev.time)
            if dt > 0.2 {
                snap.rxRate = rx >= prev.rx ? Double(rx - prev.rx) / dt : nil
                snap.txRate = tx >= prev.tx ? Double(tx - prev.tx) / dt : nil
            }
        }
        prevNet = (rx, tx, now)

        // Процессы.
        var processes: [RemoteProcess] = []
        for line in sections["PROC"] ?? [] {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard parts.count >= 4, let pid = Int(parts[0]),
                  let cpu = Double(parts[parts.count - 2]), let mem = Double(parts[parts.count - 1]) else { continue }
            let name = parts[1..<(parts.count - 2)].joined(separator: " ")
            processes.append(RemoteProcess(id: pid, name: name, cpu: cpu, mem: mem))
        }
        snap.processes = processes

        // История для графиков.
        sampleCounter += 1
        if let cpu = snap.cpuPercent {
            cpuHistory.append(CPUSample(id: sampleCounter, date: now, value: cpu))
            if cpuHistory.count > historyLimit { cpuHistory.removeFirst(cpuHistory.count - historyLimit) }
        }
        if let rxRate = snap.rxRate, let txRate = snap.txRate {
            netHistory.append(NetSample(id: sampleCounter, date: now, rx: rxRate, tx: txRate))
            if netHistory.count > historyLimit { netHistory.removeFirst(netHistory.count - historyLimit) }
        }

        snapshot = snap
        status = .live
    }

    // MARK: Сервисы и Docker

    func refreshServices() async {
        guard connection != nil else { return }
        isRefreshingServices = true
        defer { isRefreshingServices = false }
        do {
            let (output, _) = try await execute(Self.sh(Self.servicesScript))
            let sections = Self.sections(output)
            let svcLines = sections["SVC"] ?? []
            hasSystemd = !svcLines.contains("@@NOSYSTEMD")
            var list: [ServiceInfo] = []
            for raw in svcLines where raw != "@@NOSYSTEMD" {
                var line = raw.trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("●") || line.hasPrefix("*") {
                    line = String(line.dropFirst()).trimmingCharacters(in: .whitespaces)
                }
                let parts = line.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true).map(String.init)
                guard parts.count >= 4, parts[0].hasSuffix(".service") else { continue }
                let info = ServiceInfo(
                    unit: parts[0],
                    load: parts[1],
                    active: parts[2],
                    sub: parts[3],
                    description: parts.count > 4 ? parts[4].trimmingCharacters(in: .whitespaces) : ""
                )
                if info.load == "not-found" && !info.isFailed { continue }
                list.append(info)
            }
            services = list.sorted { a, b in
                if a.isFailed != b.isFailed { return a.isFailed }
                if a.isRunning != b.isRunning { return a.isRunning }
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            }

            var dockers: [ContainerInfo] = []
            for line in sections["DOCKER"] ?? [] {
                let parts = line.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
                guard parts.count == 3, !parts[0].isEmpty else { continue }
                dockers.append(ContainerInfo(name: parts[0], status: parts[1], image: parts[2]))
            }
            containers = dockers.sorted { a, b in
                if a.isRunning != b.isRunning { return a.isRunning }
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            }
            lastServicesRefresh = Date()
        } catch {
            if !(error is CancellationError) { handle(error) }
        }
    }

    private var sudo: String { isRoot ? "" : "sudo -n " }

    func perform(_ action: ServiceAction, service: ServiceInfo) async {
        await runAction(
            Self.sh("\(sudo)systemctl \(action.rawValue) \(Self.quote(service.unit)) 2>&1"),
            success: "\(service.name): \(action.title.lowercased()) — готово"
        )
    }

    func perform(_ action: ServiceAction, container: ContainerInfo) async {
        let docker = "docker \(action.rawValue) \(Self.quote(container.name))"
        let script = "\(docker) >/dev/null 2>&1 || \(isRoot ? docker : "sudo -n " + docker) 2>&1"
        await runAction(Self.sh(script), success: "\(container.name): \(action.title.lowercased()) — готово")
    }

    private func runAction(_ command: String, success: String) async {
        do {
            try await ensureConnected()
            let (output, code) = try await execute(command)
            if code == 0 {
                showToast(success)
            } else {
                let text = output.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.contains("a password is required") || text.contains("Interactive authentication required") {
                    showToast("Нужны права root (sudo с паролем не поддерживается)")
                } else {
                    showToast(text.isEmpty ? "Ошибка (код \(code))" : String(text.prefix(160)))
                }
            }
            await refreshServices()
        } catch {
            handle(error)
        }
    }

    func logs(service: ServiceInfo) async -> String {
        let unit = Self.quote(service.unit)
        let base = "journalctl -u \(unit) -n 200 --no-pager"
        let script = isRoot ? "\(base) 2>&1" : "\(sudo)\(base) 2>/dev/null || \(base) 2>&1"
        return await fetchText(Self.sh(script))
    }

    func logs(container: ContainerInfo) async -> String {
        let name = Self.quote(container.name)
        let base = "docker logs --tail 200 \(name)"
        let script = "\(base) 2>&1 || sudo -n \(base) 2>&1"
        return await fetchText(Self.sh(script))
    }

    private func fetchText(_ command: String) async -> String {
        do {
            try await ensureConnected()
            let (output, _) = try await execute(command, maxBytes: 1_000_000)
            let text = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? "(пусто)" : text
        } catch {
            return "Ошибка: " + TerminalSession.describe(error)
        }
    }

    // MARK: Утилиты

    func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_800_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    /// Делит вывод скрипта на секции по маркерам `@@NAME`.
    static func sections(_ output: String) -> [String: [String]] {
        var result: [String: [String]] = [:]
        var current: String?
        for rawLine in output.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : String(rawLine)
            if line.hasPrefix("@@"), line.count > 2, line != "@@NOSYSTEMD" {
                let name = String(line.dropFirst(2))
                current = name
                if result[name] == nil { result[name] = [] }
                continue
            }
            guard let current, !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            result[current, default: []].append(line)
        }
        return result
    }
}

enum MonitorError: LocalizedError {
    case badOutput
    case notConnected

    var errorDescription: String? {
        switch self {
        case .badOutput: return "Сервер вернул неожиданный ответ. Мониторинг работает только с Linux."
        case .notConnected: return "Нет соединения с сервером."
        }
    }
}
