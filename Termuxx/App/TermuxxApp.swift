import SwiftUI
import LocalAuthentication

// MARK: - Навигация

enum AppTab: Hashable {
    case servers
    case keys
    case snippets
    case settings
}

enum Route: Hashable {
    case terminal(UUID)
}

/// Просьбы к экрану серверов из других мест приложения (нижняя панель iOS 26, сниппеты и т.д.).
enum RouterRequest: Equatable {
    case quickConnect
    case connect(UUID)
    case newServer
}

@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()

    @Published var selectedTab: AppTab = .servers
    @Published var hostsPath: [Route] = []
    @Published var request: RouterRequest?

    /// Открывает терминал сессии на вкладке «Серверы».
    func openTerminal(_ id: UUID) {
        selectedTab = .servers
        if case .terminal(let current)? = hostsPath.last, current == id { return }
        hostsPath = [.terminal(id)]
    }

    /// Переключается на вкладку «Серверы» и передаёт ей действие.
    func send(_ request: RouterRequest) {
        selectedTab = .servers
        hostsPath = []
        self.request = request
    }
}

// MARK: - Фоновая работа

/// Просит у iOS немного времени в фоне, чтобы SSH-сессии не рвались сразу после сворачивания.
@MainActor
final class BackgroundKeeper {
    static let shared = BackgroundKeeper()
    private var task: UIBackgroundTaskIdentifier = .invalid

    func begin() {
        guard task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "ssh-sessions") {
            MainActor.assumeIsolated {
                BackgroundKeeper.shared.end()
            }
        }
    }

    func end() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}

// MARK: - Приложение

@main
struct TermuxxApp: App {
    @StateObject private var store = Store.shared
    @StateObject private var sessions = SessionManager.shared
    @StateObject private var router = AppRouter.shared
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("biometricLock") private var biometricLock = false
    @State private var locked = UserDefaults.standard.bool(forKey: "biometricLock")

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(sessions)
                .environmentObject(router)
                .preferredColorScheme(.dark)
                .tint(Color(hex: "#3DDC97"))
                .overlay {
                    if locked && biometricLock {
                        LockView { locked = false }
                            .transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.25), value: locked)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                if biometricLock { locked = true }
                BackgroundKeeper.shared.begin()
            case .active:
                BackgroundKeeper.shared.end()
                SessionManager.shared.appDidBecomeActive()
            default:
                break
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var sessions: SessionManager
    @EnvironmentObject var router: AppRouter

    var body: some View {
        TabView(selection: $router.selectedTab) {
            HostsView()
                .tabItem { Label("Серверы", systemImage: "server.rack") }
                .badge(sessions.sessions.count)
                .tag(AppTab.servers)
            KeysView()
                .tabItem { Label("Ключи", systemImage: "key.horizontal") }
                .tag(AppTab.keys)
            SnippetsView()
                .tabItem { Label("Сниппеты", systemImage: "text.badge.plus") }
                .tag(AppTab.snippets)
            SettingsView()
                .tabItem { Label("Настройки", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .minimizingTabBar()
        .termuxxBottomAccessory {
            SessionsAccessory()
        }
    }
}

extension View {
    /// Нижняя панель над таб-баром (iOS 26+, как мини-плеер в «Музыке»). На старых iOS — ничего.
    /// Модификатор применяется всегда, чтобы не менялась идентичность TabView и не сбрасывалась навигация.
    @ViewBuilder
    func termuxxBottomAccessory<A: View>(@ViewBuilder _ content: () -> A) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            let accessory = content()
            self.tabViewBottomAccessory { accessory }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// Содержимое нижней панели: вернуться к сессиям, переподключиться к последнему серверу или быстрое подключение.
struct SessionsAccessory: View {
    @EnvironmentObject var sessions: SessionManager
    @EnvironmentObject var store: Store
    @EnvironmentObject var router: AppRouter

    private var recentServer: Server? {
        store.hosts
            .filter { $0.lastConnected != nil }
            .max { ($0.lastConnected ?? .distantPast) < ($1.lastConnected ?? .distantPast) }
    }

    var body: some View {
        Button(action: tap) {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.22))
                        .frame(width: 30, height: 30)
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.accentColor)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var icon: String {
        if !sessions.sessions.isEmpty { return "terminal.fill" }
        if recentServer != nil { return "arrow.clockwise" }
        return "bolt.fill"
    }

    private var title: String {
        let count = sessions.sessions.count
        if count > 0 {
            return "\(count) " + termuxxPlural(count, "открытая сессия", "открытые сессии", "открытых сессий")
        }
        if let recent = recentServer { return "Подключиться: \(recent.title)" }
        return "Быстрое подключение"
    }

    private var subtitle: String {
        if let last = sessions.sessions.last { return last.title }
        if let recent = recentServer { return recent.subtitle }
        return "user@host:port"
    }

    private func tap() {
        if let last = sessions.sessions.last {
            router.openTerminal(last.id)
        } else if let recent = recentServer {
            router.send(.connect(recent.id))
        } else {
            router.send(.quickConnect)
        }
    }
}

/// Русское склонение: 1 сессия, 2 сессии, 5 сессий.
func termuxxPlural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
    let mod10 = n % 10, mod100 = n % 100
    if mod10 == 1 && mod100 != 11 { return one }
    if (2...4).contains(mod10) && !(12...14).contains(mod100) { return few }
    return many
}

// MARK: - Экран блокировки

struct LockView: View {
    let onUnlock: () -> Void
    @State private var failed = false

    var body: some View {
        ZStack {
            AuroraBackground()
            VStack(spacing: 16) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 56, weight: .semibold))
                    .foregroundStyle(Color(hex: "#3DDC97"))
                    .symbolEffect(.pulse)
                    .padding(.bottom, 4)
                Text("Termuxx заблокирован")
                    .font(.title2.weight(.semibold))
                Text("Подтвердите, что это вы")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button {
                    authenticate()
                } label: {
                    Label("Разблокировать", systemImage: "faceid")
                        .font(.headline)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                }
                .glassButtonStyle(prominent: true)
                .controlSize(.large)
                .padding(.top, 6)
                if failed {
                    Text("Не удалось подтвердить личность")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 34)
            .frame(maxWidth: 360)
            .glassCard(cornerRadius: 34)
            .padding(24)
        }
        .onAppear(perform: authenticate)
    }

    private func authenticate() {
        let context = LAContext()
        context.localizedCancelTitle = "Отмена"
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Разблокируйте Termuxx") { success, _ in
            DispatchQueue.main.async {
                if success {
                    failed = false
                    onUnlock()
                } else {
                    failed = true
                }
            }
        }
    }
}
