import SwiftUI
import LocalAuthentication

struct SettingsView: View {
    @EnvironmentObject var sessions: SessionManager
    @AppStorage("fontSize") private var fontSize = 13.0
    @AppStorage("themeID") private var themeID = "termuxx"
    @AppStorage("biometricLock") private var biometricLock = false
    @AppStorage("keepAwake") private var keepAwake = true

    private var theme: TerminalTheme { TerminalTheme.by(id: themeID) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TerminalPreview(theme: theme, fontSize: fontSize)
                        .listRowInsets(EdgeInsets())
                }

                Section("Тема терминала") {
                    ForEach(TerminalTheme.all) { t in
                        Button {
                            themeID = t.id
                            sessions.refreshAppearance()
                        } label: {
                            HStack(spacing: 12) {
                                HStack(spacing: 0) {
                                    ForEach(Array(t.ansi.prefix(8).enumerated()), id: \.offset) { _, hex in
                                        Rectangle().fill(Color(hex: hex))
                                    }
                                }
                                .frame(width: 72, height: 18)
                                .clipShape(RoundedRectangle(cornerRadius: 5))
                                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color(hex: t.background), lineWidth: 3))
                                Text(t.name).foregroundStyle(.primary)
                                Spacer()
                                if t.id == themeID {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                    }
                }

                Section("Шрифт") {
                    Stepper(value: $fontSize, in: 8...28, step: 1) {
                        LabeledContent("Размер", value: "\(Int(fontSize)) pt")
                    }
                    .onChange(of: fontSize) { _, _ in sessions.refreshAppearance() }
                }

                Section {
                    Toggle(isOn: $biometricLock) {
                        Label("Блокировка Face ID", systemImage: "faceid")
                    }
                    .onChange(of: biometricLock) { _, newValue in
                        if newValue { verifyBiometrics() }
                    }
                    Toggle(isOn: $keepAwake) {
                        Label("Не гасить экран в терминале", systemImage: "sun.max")
                    }
                } header: {
                    Text("Безопасность и поведение")
                } footer: {
                    Text("iOS приостанавливает приложения в фоне, поэтому SSH-сессия может оборваться через ~30 секунд после сворачивания. Вернуться — кнопка «Снова».")
                }

                Section("О приложении") {
                    LabeledContent("Версия", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                    Link(destination: URL(string: "https://github.com/stillemptyNOW/termuxx")!) {
                        Label("Исходный код на GitHub", systemImage: "chevron.left.forwardslash.chevron.right")
                    }
                    Text("Сделано на SwiftTerm и Citadel (MIT). Без рекламы, подписок и телеметрии.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Настройки")
        }
    }

    private func verifyBiometrics() {
        let context = LAContext()
        var error: NSError?
        if !context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            biometricLock = false
        }
    }
}

struct TerminalPreview: View {
    let theme: TerminalTheme
    let fontSize: Double

    var body: some View {
        let font = Font.system(size: fontSize, design: .monospaced)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 0) {
                Text("root@finland").foregroundStyle(Color(hex: theme.ansi[2]))
                Text(":").foregroundStyle(Color(hex: theme.foreground))
                Text("~").foregroundStyle(Color(hex: theme.ansi[4]))
                Text("# systemctl status mtproxy").foregroundStyle(Color(hex: theme.foreground))
            }
            HStack(spacing: 0) {
                Text("● ").foregroundStyle(Color(hex: theme.ansi[10]))
                Text("mtproxy.service - MTProto proxy").foregroundStyle(Color(hex: theme.foreground))
            }
            HStack(spacing: 0) {
                Text("   Active: ").foregroundStyle(Color(hex: theme.foreground))
                Text("active (running)").foregroundStyle(Color(hex: theme.ansi[10]))
            }
            HStack(spacing: 0) {
                Text("   Warn: ").foregroundStyle(Color(hex: theme.foreground))
                Text("1 failed").foregroundStyle(Color(hex: theme.ansi[1]))
                Text(" · ").foregroundStyle(Color(hex: theme.foreground))
                Text("load 0.12").foregroundStyle(Color(hex: theme.ansi[3]))
            }
            HStack(spacing: 0) {
                Text("root@finland:~# ").foregroundStyle(Color(hex: theme.foreground))
                Rectangle().fill(Color(hex: theme.cursor)).frame(width: fontSize * 0.6, height: fontSize * 1.2)
            }
        }
        .font(font)
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(hex: theme.background))
    }
}
