import SwiftUI
import LocalAuthentication

struct SettingsView: View {
    @EnvironmentObject var sessions: SessionManager
    @AppStorage("fontSize") private var fontSize = 13.0
    @AppStorage("fontName") private var fontName: String = TerminalFont.defaultName
    @AppStorage("themeID") private var themeID = "termuxx"
    @AppStorage("biometricLock") private var biometricLock = false
    @AppStorage("keepAwake") private var keepAwake = true

    private var theme: TerminalTheme { TerminalTheme.by(id: themeID) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SettingsTerminalPreview(theme: theme, fontSize: fontSize, fontName: fontName)
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
                    Picker("Семейство", selection: $fontName) {
                        ForEach(TerminalFont.all, id: \.id) { font in
                            Text(font.title).tag(font.id)
                        }
                    }
                    Stepper(value: $fontSize, in: 8...28, step: 1) {
                        LabeledContent("Размер", value: "\(Int(fontSize)) pt")
                    }
                }

                Section {
                    NavigationLink {
                        KeyBarSettingsView()
                    } label: {
                        Label("Клавиши над клавиатурой", systemImage: "keyboard")
                    }
                } header: {
                    Text("Ввод")
                } footer: {
                    Text("В терминале: два пальца — стрелки, щипок — размер шрифта.")
                }

                Section {
                    NavigationLink {
                        BackupView()
                    } label: {
                        Label("Резервная копия", systemImage: "externaldrive")
                    }
                } header: {
                    Text("Данные")
                } footer: {
                    Text("Экспорт и импорт серверов, ключей и сниппетов — в том числе для Termuxx на ПК.")
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
                    Text("iOS приостанавливает приложения в фоне, поэтому SSH-соединение может оборваться через ~30 секунд после сворачивания. Termuxx переподключится сам, а с tmux вы вернётесь ровно туда, где были.")
                }

                Section("О приложении") {
                    LabeledContent("Версия", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.1")
                    Link(destination: URL(string: "https://github.com/stillemptyNOW/termuxx")!) {
                        Label("Исходный код на GitHub", systemImage: "chevron.left.forwardslash.chevron.right")
                    }
                    Link(destination: URL(string: "https://github.com/stillemptyNOW/termuxx/tree/main/linux")!) {
                        Label("Termuxx для ПК (Arch Linux)", systemImage: "desktopcomputer")
                    }
                    Text("Сделано на SwiftTerm и Citadel (MIT), шрифты JetBrains Mono и IBM Plex Mono (OFL). Без рекламы, подписок и телеметрии.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Настройки")
            .onChange(of: fontName) { _, _ in sessions.refreshAppearance() }
            .onChange(of: fontSize) { _, _ in sessions.refreshAppearance() }
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

struct SettingsTerminalPreview: View {
    let theme: TerminalTheme
    let fontSize: Double
    let fontName: String

    private var font: Font {
        if fontName == "system" || UIFont(name: fontName, size: CGFloat(fontSize)) == nil {
            return .system(size: fontSize, design: .monospaced)
        }
        return .custom(fontName, size: fontSize)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 0) {
                Text(verbatim: "root@finland").foregroundStyle(Color(hex: theme.ansi[2]))
                Text(verbatim: ":").foregroundStyle(Color(hex: theme.foreground))
                Text(verbatim: "~").foregroundStyle(Color(hex: theme.ansi[4]))
                Text(verbatim: "# systemctl status mtproxy").foregroundStyle(Color(hex: theme.foreground))
            }
            HStack(spacing: 0) {
                Text(verbatim: "● ").foregroundStyle(Color(hex: theme.ansi[10]))
                Text(verbatim: "mtproxy.service - MTProto proxy").foregroundStyle(Color(hex: theme.foreground))
            }
            HStack(spacing: 0) {
                Text(verbatim: "   Active: ").foregroundStyle(Color(hex: theme.foreground))
                Text(verbatim: "active (running)").foregroundStyle(Color(hex: theme.ansi[10]))
            }
            HStack(spacing: 0) {
                Text(verbatim: "   Warn: ").foregroundStyle(Color(hex: theme.foreground))
                Text(verbatim: "1 failed").foregroundStyle(Color(hex: theme.ansi[1]))
                Text(verbatim: " · ").foregroundStyle(Color(hex: theme.foreground))
                Text(verbatim: "load 0.12").foregroundStyle(Color(hex: theme.ansi[3]))
            }
            HStack(spacing: 0) {
                Text(verbatim: "root@finland:~# ").foregroundStyle(Color(hex: theme.foreground))
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
