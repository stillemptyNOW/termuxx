import SwiftUI
import Charts

/// Мониторинг сервера: нагрузка, память, диски, сеть, процессы, сервисы и Docker.
struct DashboardView: View {
    @StateObject private var monitor: ServerMonitor
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var serviceFilter: MonitorServiceFilter = .running
    @State private var serviceSearch = ""
    @State private var showAllServices = false
    @State private var logSheet: MonitorLogSheet?
    @State private var confirm: MonitorPendingAction?

    init(server: Server, password: String?) {
        _monitor = StateObject(wrappedValue: ServerMonitor(server: server, password: password))
    }

    var body: some View {
        ZStack {
            AuroraBackground(accent: monitor.server.color)
            ScrollView {
                VStack(spacing: 14) {
                    header
                    if let snap = monitor.snapshot {
                        metricsGrid(snap)
                        if !snap.disks.isEmpty { disksCard(snap) }
                        if !snap.processes.isEmpty { processesCard(snap) }
                        servicesCard
                        if !monitor.containers.isEmpty { dockerCard }
                        footer(snap)
                    } else {
                        placeholder
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 28)
            }
            .refreshable { await monitor.refreshAll() }
        }
        .overlay(alignment: .bottom) {
            if let toast = monitor.toast {
                Text(toast)
                    .font(.footnote.weight(.medium))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .glassCapsule(interactive: false)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.35), value: monitor.toast)
        .navigationTitle(monitor.server.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Готово") { dismiss() }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await monitor.refreshAll() }
                } label: {
                    if monitor.isRefreshingServices {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(!monitor.isLive)
            }
        }
        .hostKeyAlert($monitor.trustRequest) {
            monitor.restart()
        }
        .sheet(item: $logSheet) { sheet in
            NavigationStack {
                MonitorLogView(sheet: sheet, monitor: monitor)
            }
        }
        .confirmationDialog(
            confirm?.title ?? "",
            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
            titleVisibility: .visible,
            presenting: confirm
        ) { item in
            Button(item.action.title, role: .destructive) {
                Task { await run(item) }
            }
            Button("Отмена", role: .cancel) {}
        } message: { item in
            Text(item.message)
        }
        .onAppear { monitor.start() }
        .onDisappear { monitor.shutdown() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                monitor.start()
            } else {
                monitor.pause()
            }
        }
    }

    // MARK: Шапка

    private var header: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(monitor.server.color.gradient)
                    .frame(width: 46, height: 46)
                Image(systemName: "server.rack")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.black.opacity(0.75))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(monitor.snapshot?.hostname.isEmpty == false ? monitor.snapshot!.hostname : monitor.server.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(osLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            StatusPill(status: monitor.status)
        }
        .padding(14)
        .glassCard(cornerRadius: 24)
    }

    private var osLine: String {
        guard let snap = monitor.snapshot else { return monitor.server.subtitle }
        let parts = [snap.os, snap.kernel].filter { !$0.isEmpty }
        return parts.isEmpty ? monitor.server.subtitle : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var placeholder: some View {
        VStack(spacing: 14) {
            switch monitor.status {
            case .failed(let message):
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.orange)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                Button {
                    monitor.restart()
                } label: {
                    Label("Повторить", systemImage: "arrow.clockwise")
                        .padding(.horizontal, 8)
                }
                .glassButtonStyle(prominent: true)
            case .reconnecting(let message):
                ProgressView()
                Text("Переподключение…")
                    .font(.headline)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            default:
                ProgressView()
                    .controlSize(.large)
                Text("Подключение к \(monitor.server.subtitle)…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity)
        .glassCard(cornerRadius: 24)
        .padding(.top, 24)
    }

    // MARK: Метрики

    private func metricsGrid(_ snap: MonitorSnapshot) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 158), spacing: 12)], spacing: 12) {
            cpuCard(snap)
            memoryCard(snap)
            networkCard(snap)
            systemCard(snap)
        }
    }

    private func cpuCard(_ snap: MonitorSnapshot) -> some View {
        let value = snap.cpuPercent ?? 0
        let tint = UsageLevel.color(value / 100)
        return MetricCard(title: "Процессор", icon: "cpu", tint: tint) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(snap.cpuPercent.map { "\(Int($0.rounded()))" } ?? "—")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())
                Text("%")
                    .font(.headline)
                    .foregroundStyle(.secondary)
            }
            Chart(monitor.cpuHistory) { sample in
                AreaMark(
                    x: .value("Время", sample.date),
                    y: .value("CPU", sample.value)
                )
                .foregroundStyle(
                    LinearGradient(colors: [tint.opacity(0.45), tint.opacity(0.02)], startPoint: .top, endPoint: .bottom)
                )
                .interpolationMethod(.catmullRom)
                LineMark(
                    x: .value("Время", sample.date),
                    y: .value("CPU", sample.value)
                )
                .foregroundStyle(tint)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                .interpolationMethod(.catmullRom)
            }
            .chartYScale(domain: 0.0...100.0)
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .frame(height: 46)
            Text("\(snap.cores) \(Self.plural(snap.cores, "ядро", "ядра", "ядер")) · LA \(String(format: "%.2f", snap.load.first ?? 0))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func memoryCard(_ snap: MonitorSnapshot) -> some View {
        let tint = UsageLevel.color(snap.memFraction)
        return MetricCard(title: "Память", icon: "memorychip", tint: tint) {
            HStack(spacing: 14) {
                Gauge(value: snap.memFraction) {
                    Text("RAM")
                } currentValueLabel: {
                    Text(MonitorFormat.percent(snap.memFraction))
                        .font(.caption2.weight(.bold))
                }
                .gaugeStyle(.accessoryCircularCapacity)
                .tint(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(MonitorFormat.bytes(snap.memUsed))
                        .font(.headline)
                        .contentTransition(.numericText())
                    Text("из \(MonitorFormat.bytes(snap.memTotal))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if snap.swapTotal > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Swap")
                        Spacer()
                        Text("\(MonitorFormat.bytes(snap.swapUsed)) / \(MonitorFormat.bytes(snap.swapTotal))")
                            .monospacedDigit()
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    UsageBar(fraction: snap.swapFraction, tint: UsageLevel.color(snap.swapFraction))
                }
            } else {
                Text("Swap выключен")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func networkCard(_ snap: MonitorSnapshot) -> some View {
        MetricCard(title: "Сеть", icon: "arrow.up.arrow.down", tint: .cyan) {
            VStack(alignment: .leading, spacing: 3) {
                Label(MonitorFormat.rate(snap.rxRate), systemImage: "arrow.down")
                    .foregroundStyle(.green)
                Label(MonitorFormat.rate(snap.txRate), systemImage: "arrow.up")
                    .foregroundStyle(.cyan)
            }
            .font(.subheadline.weight(.semibold).monospacedDigit())
            Chart {
                ForEach(monitor.netHistory) { sample in
                    LineMark(
                        x: .value("Время", sample.date),
                        y: .value("Скорость", sample.rx),
                        series: .value("Направление", "Приём")
                    )
                    .foregroundStyle(Color.green)
                    .interpolationMethod(.catmullRom)
                    LineMark(
                        x: .value("Время", sample.date),
                        y: .value("Скорость", sample.tx),
                        series: .value("Направление", "Отдача")
                    )
                    .foregroundStyle(Color.cyan)
                    .interpolationMethod(.catmullRom)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(height: 40)
            Text("Всего ↓\(MonitorFormat.bytes(snap.rxTotal)) ↑\(MonitorFormat.bytes(snap.txTotal))")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }

    private func systemCard(_ snap: MonitorSnapshot) -> some View {
        MetricCard(title: "Система", icon: "info.circle", tint: .purple) {
            InfoLine(title: "Аптайм", value: MonitorFormat.uptime(snap.uptime))
            InfoLine(title: "Нагрузка", value: snap.load.map { String(format: "%.2f", $0) }.joined(separator: " "))
            InfoLine(title: "Пользователь", value: snap.isRoot ? "root" : monitor.server.username)
            if !snap.kernel.isEmpty {
                InfoLine(title: "Ядро", value: snap.kernel)
            }
        }
    }

    private func disksCard(_ snap: MonitorSnapshot) -> some View {
        SectionCard(title: "Диски", icon: "internaldrive") {
            VStack(spacing: 12) {
                ForEach(snap.disks) { disk in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(disk.mount)
                                .font(.subheadline.weight(.semibold).monospaced())
                                .lineLimit(1)
                            Spacer()
                            Text("\(MonitorFormat.bytes(disk.used)) / \(MonitorFormat.bytes(disk.total))")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(MonitorFormat.percent(disk.fraction))
                                .font(.caption.weight(.bold).monospacedDigit())
                                .foregroundStyle(UsageLevel.color(disk.fraction))
                                .frame(minWidth: 38, alignment: .trailing)
                        }
                        UsageBar(fraction: disk.fraction, tint: UsageLevel.color(disk.fraction))
                        Text(disk.filesystem)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    private func processesCard(_ snap: MonitorSnapshot) -> some View {
        SectionCard(title: "Процессы", icon: "list.bullet.rectangle") {
            VStack(spacing: 0) {
                HStack {
                    Text("Процесс")
                    Spacer()
                    Text("CPU").frame(width: 52, alignment: .trailing)
                    Text("RAM").frame(width: 52, alignment: .trailing)
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 6)
                ForEach(snap.processes) { process in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(process.name)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Text("PID \(process.id)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                        }
                        Spacer(minLength: 4)
                        Text(String(format: "%.1f%%", process.cpu))
                            .foregroundStyle(UsageLevel.color(min(process.cpu / 100, 1)))
                            .frame(width: 52, alignment: .trailing)
                        Text(String(format: "%.1f%%", process.mem))
                            .foregroundStyle(.secondary)
                            .frame(width: 52, alignment: .trailing)
                    }
                    .font(.caption.monospacedDigit())
                    .padding(.vertical, 6)
                    if process.id != snap.processes.last?.id {
                        Divider().opacity(0.4)
                    }
                }
            }
        }
    }

    // MARK: Сервисы

    private var filteredServices: [ServiceInfo] {
        let query = serviceSearch.trimmingCharacters(in: .whitespaces)
        return monitor.services.filter { service in
            let matchesFilter: Bool
            switch serviceFilter {
            case .failed: matchesFilter = service.isFailed
            case .running: matchesFilter = service.isRunning
            case .all: matchesFilter = true
            }
            guard matchesFilter else { return false }
            guard !query.isEmpty else { return true }
            return service.unit.localizedCaseInsensitiveContains(query)
                || service.description.localizedCaseInsensitiveContains(query)
        }
    }

    private func count(_ filter: MonitorServiceFilter) -> Int {
        switch filter {
        case .failed: return monitor.services.filter(\.isFailed).count
        case .running: return monitor.services.filter(\.isRunning).count
        case .all: return monitor.services.count
        }
    }

    private var servicesCard: some View {
        SectionCard(title: "Сервисы", icon: "gearshape.2") {
            if !monitor.hasSystemd {
                Text("systemd не найден — список сервисов недоступен.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if monitor.services.isEmpty {
                HStack(spacing: 10) {
                    if monitor.isRefreshingServices { ProgressView() }
                    Text(monitor.isRefreshingServices ? "Загружаю список…" : "Сервисов не найдено.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                VStack(spacing: 10) {
                    Picker("Фильтр", selection: $serviceFilter) {
                        ForEach(MonitorServiceFilter.allCases) { filter in
                            Text("\(filter.title) \(count(filter))").tag(filter)
                        }
                    }
                    .pickerStyle(.segmented)

                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                        TextField("Поиск сервиса", text: $serviceSearch)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if !serviceSearch.isEmpty {
                            Button {
                                serviceSearch = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .font(.subheadline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Color.white.opacity(0.07), in: Capsule())

                    let list = filteredServices
                    if list.isEmpty {
                        Text(serviceFilter == .failed && serviceSearch.isEmpty ? "Сервисов с ошибками нет 🎉" : "Ничего не найдено")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                    } else {
                        LazyVStack(spacing: 0) {
                            let visible = showAllServices ? list : Array(list.prefix(40))
                            ForEach(visible) { service in
                                ServiceRow(service: service) { action in
                                    handle(action, service: service)
                                } onLogs: {
                                    logSheet = MonitorLogSheet(target: .service(service))
                                }
                                if service.id != visible.last?.id {
                                    Divider().opacity(0.4)
                                }
                            }
                        }
                        if list.count > 40 && !showAllServices {
                            Button("Показать все (\(list.count))") {
                                showAllServices = true
                            }
                            .font(.footnote.weight(.semibold))
                            .padding(.top, 4)
                        }
                    }
                }
            }
        } accessory: {
            if monitor.isRefreshingServices && !monitor.services.isEmpty {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var dockerCard: some View {
        SectionCard(title: "Docker", icon: "shippingbox") {
            VStack(spacing: 0) {
                ForEach(monitor.containers) { container in
                    ContainerRow(container: container) { action in
                        handle(action, container: container)
                    } onLogs: {
                        logSheet = MonitorLogSheet(target: .container(container))
                    }
                    if container.id != monitor.containers.last?.id {
                        Divider().opacity(0.4)
                    }
                }
            }
        } accessory: {
            let running = monitor.containers.filter(\.isRunning).count
            Text("\(running)/\(monitor.containers.count)")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func footer(_ snap: MonitorSnapshot) -> some View {
        Text("Обновление каждые 3 с · \(snap.updatedAt.formatted(date: .omitted, time: .standard))")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .padding(.top, 4)
    }

    // MARK: Действия

    private func handle(_ action: ServiceAction, service: ServiceInfo) {
        if action.isDestructive {
            confirm = MonitorPendingAction(action: action, target: .service(service))
        } else {
            Task { await monitor.perform(action, service: service) }
        }
    }

    private func handle(_ action: ServiceAction, container: ContainerInfo) {
        if action.isDestructive {
            confirm = MonitorPendingAction(action: action, target: .container(container))
        } else {
            Task { await monitor.perform(action, container: container) }
        }
    }

    private func run(_ item: MonitorPendingAction) async {
        switch item.target {
        case .service(let service):
            await monitor.perform(item.action, service: service)
        case .container(let container):
            await monitor.perform(item.action, container: container)
        }
    }

    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let mod10 = n % 10, mod100 = n % 100
        if mod10 == 1 && mod100 != 11 { return one }
        if (2...4).contains(mod10) && !(12...14).contains(mod100) { return few }
        return many
    }
}

// MARK: - Вспомогательные типы

enum MonitorServiceFilter: String, CaseIterable, Identifiable {
    case failed, running, all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .failed: return "Ошибки"
        case .running: return "Работают"
        case .all: return "Все"
        }
    }
}

enum MonitorTarget {
    case service(ServiceInfo)
    case container(ContainerInfo)

    var name: String {
        switch self {
        case .service(let s): return s.name
        case .container(let c): return c.name
        }
    }
}

struct MonitorPendingAction: Identifiable {
    let id = UUID()
    let action: ServiceAction
    let target: MonitorTarget

    var title: String { "\(action.title) «\(target.name)»?" }

    var message: String {
        switch (action, target) {
        case (.stop, .service):
            return "Сервис будет остановлен. Если это SSH или сеть — можно потерять доступ к серверу."
        case (.restart, .service):
            return "Сервис будет перезапущен."
        case (.stop, .container):
            return "Контейнер будет остановлен."
        case (.restart, .container):
            return "Контейнер будет перезапущен."
        default:
            return ""
        }
    }
}

struct MonitorLogSheet: Identifiable {
    let id = UUID()
    let target: MonitorTarget

    var title: String { "Логи: \(target.name)" }
}

/// Цвет по уровню заполнения: зелёный → оранжевый → красный.
enum UsageLevel {
    static func color(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.6: return Color(hex: "#3DDC97")
        case ..<0.85: return .orange
        default: return Color(hex: "#FF5C6C")
        }
    }
}

private struct StatusPill: View {
    let status: ServerMonitor.Status

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .shadow(color: color.opacity(0.8), radius: 4)
            Text(text)
                .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .glassCapsule(tint: color.opacity(0.22), interactive: false)
    }

    private var color: Color {
        switch status {
        case .live: return .green
        case .connecting, .reconnecting, .idle: return .orange
        case .failed: return .red
        }
    }

    private var text: String {
        switch status {
        case .live: return "Онлайн"
        case .connecting, .idle: return "Подключение"
        case .reconnecting: return "Повтор"
        case .failed: return "Ошибка"
        }
    }
}

private struct MetricCard<Content: View>: View {
    let title: String
    let icon: String
    var tint: Color = .accentColor
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tint)
                .textCase(.uppercase)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 168, alignment: .topLeading)
        .glassCard(cornerRadius: 22)
    }
}

private struct SectionCard<Content: View, Accessory: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: () -> Content
    @ViewBuilder let accessory: () -> Accessory

    init(title: String, icon: String,
         @ViewBuilder content: @escaping () -> Content,
         @ViewBuilder accessory: @escaping () -> Accessory) {
        self.title = title
        self.icon = icon
        self.content = content
        self.accessory = accessory
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(title, systemImage: icon)
                    .font(.headline)
                Spacer()
                accessory()
            }
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(cornerRadius: 24)
    }
}

extension SectionCard where Accessory == EmptyView {
    init(title: String, icon: String, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, icon: icon, content: content, accessory: { EmptyView() })
    }
}

private struct InfoLine: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value.isEmpty ? "—" : value)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}

private struct UsageBar: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.10))
                Capsule()
                    .fill(tint.gradient)
                    .frame(width: max(4, geo.size.width * min(max(fraction, 0), 1)))
            }
        }
        .frame(height: 6)
        .animation(.easeOut(duration: 0.4), value: fraction)
    }
}

private struct ServiceRow: View {
    let service: ServiceInfo
    let onAction: (ServiceAction) -> Void
    let onLogs: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(service.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(service.description.isEmpty ? "\(service.active) · \(service.sub)" : service.description)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Menu {
                menuItems
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .contextMenu { menuItems }
    }

    @ViewBuilder
    private var menuItems: some View {
        Button(action: onLogs) { Label("Логи", systemImage: "doc.text.magnifyingglass") }
        Divider()
        if service.active == "active" {
            Button { onAction(.restart) } label: { Label(ServiceAction.restart.title, systemImage: ServiceAction.restart.icon) }
            Button(role: .destructive) { onAction(.stop) } label: { Label(ServiceAction.stop.title, systemImage: ServiceAction.stop.icon) }
        } else {
            Button { onAction(.start) } label: { Label(ServiceAction.start.title, systemImage: ServiceAction.start.icon) }
            Button { onAction(.restart) } label: { Label(ServiceAction.restart.title, systemImage: ServiceAction.restart.icon) }
        }
    }

    private var color: Color {
        if service.isFailed { return .red }
        if service.isRunning { return .green }
        if service.active == "activating" || service.active == "reloading" { return .orange }
        return .gray
    }
}

private struct ContainerRow: View {
    let container: ContainerInfo
    let onAction: (ServiceAction) -> Void
    let onLogs: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(container.isUnhealthy ? Color.orange : (container.isRunning ? Color.green : Color.gray))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(container.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text("\(container.status) · \(container.image)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Menu {
                menuItems
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .contextMenu { menuItems }
    }

    @ViewBuilder
    private var menuItems: some View {
        Button(action: onLogs) { Label("Логи", systemImage: "doc.text.magnifyingglass") }
        Divider()
        if container.isRunning {
            Button { onAction(.restart) } label: { Label(ServiceAction.restart.title, systemImage: ServiceAction.restart.icon) }
            Button(role: .destructive) { onAction(.stop) } label: { Label(ServiceAction.stop.title, systemImage: ServiceAction.stop.icon) }
        } else {
            Button { onAction(.start) } label: { Label(ServiceAction.start.title, systemImage: ServiceAction.start.icon) }
        }
    }
}

/// Просмотр логов сервиса или контейнера.
struct MonitorLogView: View {
    let sheet: MonitorLogSheet
    @ObservedObject var monitor: ServerMonitor
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var loading = true
    @State private var copied = false

    var body: some View {
        ScrollView {
            Text(verbatim: text)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
        }
        .defaultScrollAnchor(.bottom)
        .background(Color(hex: "#0A0E14"))
        .overlay {
            if loading {
                ProgressView("Загружаю логи…")
                    .padding(20)
                    .glassCard(cornerRadius: 18)
            }
        }
        .navigationTitle(sheet.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Готово") { dismiss() }
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .disabled(text.isEmpty)
                Button {
                    Task { await load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(loading)
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        copied = false
        switch sheet.target {
        case .service(let service):
            text = await monitor.logs(service: service)
        case .container(let container):
            text = await monitor.logs(container: container)
        }
        loading = false
    }
}
