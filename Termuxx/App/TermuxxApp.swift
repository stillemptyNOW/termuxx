import SwiftUI
import LocalAuthentication

@main
struct TermuxxApp: App {
    @StateObject private var store = Store.shared
    @StateObject private var sessions = SessionManager.shared
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("biometricLock") private var biometricLock = false
    @State private var locked = UserDefaults.standard.bool(forKey: "biometricLock")
    @State private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(sessions)
                .preferredColorScheme(.dark)
                .tint(Color(hex: "#3DDC97"))
                .overlay {
                    if locked && biometricLock {
                        LockView { locked = false }
                            .transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: locked)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                if biometricLock { locked = true }
                // Даём SSH-сессиям немного пожить в фоне.
                if backgroundTask == .invalid {
                    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "ssh") {
                        UIApplication.shared.endBackgroundTask(backgroundTask)
                        backgroundTask = .invalid
                    }
                }
            case .active:
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                    backgroundTask = .invalid
                }
            default:
                break
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var sessions: SessionManager

    var body: some View {
        TabView {
            HostsView()
                .tabItem { Label("Серверы", systemImage: "server.rack") }
                .badge(sessions.sessions.filter(\.isAlive).count)
            KeysView()
                .tabItem { Label("Ключи", systemImage: "key.horizontal") }
            SnippetsView()
                .tabItem { Label("Сниппеты", systemImage: "text.badge.plus") }
            SettingsView()
                .tabItem { Label("Настройки", systemImage: "gearshape") }
        }
    }
}

struct LockView: View {
    let onUnlock: () -> Void
    @State private var failed = false

    var body: some View {
        ZStack {
            Color(hex: "#0A0E14").ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(Color(hex: "#3DDC97"))
                Text("Termuxx заблокирован")
                    .font(.title2.weight(.semibold))
                Button {
                    authenticate()
                } label: {
                    Label("Разблокировать", systemImage: "faceid")
                        .padding(.horizontal, 12)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                if failed {
                    Text("Не удалось подтвердить личность").font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .onAppear(perform: authenticate)
    }

    private func authenticate() {
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Разблокируйте Termuxx") { success, _ in
            DispatchQueue.main.async {
                if success { onUnlock() } else { failed = true }
            }
        }
    }
}
