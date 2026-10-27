import Foundation
import UIKit
import SwiftTerm

// MARK: - Клавиши панели над клавиатурой

/// Клавиша панели над клавиатурой. Порядок и набор настраиваются пользователем.
enum KeyBarItem: String, CaseIterable, Identifiable {
    case esc, tab, ctrl, alt
    case left, down, up, right
    case home, end, pageUp, pageDown
    case pipe, tilde, slash, backslash, dash, underscore, colon
    case ctrlC, ctrlD, ctrlZ, ctrlL, ctrlR
    case paste, hideKeyboard

    var id: String { rawValue }

    /// Короткая подпись на самой клавише.
    var title: String {
        switch self {
        case .esc: return "Esc"
        case .tab: return "Tab"
        case .ctrl: return "Ctrl"
        case .alt: return "Alt"
        case .left: return "←"
        case .down: return "↓"
        case .up: return "↑"
        case .right: return "→"
        case .home: return "Home"
        case .end: return "End"
        case .pageUp: return "PgUp"
        case .pageDown: return "PgDn"
        case .pipe: return "|"
        case .tilde: return "~"
        case .slash: return "/"
        case .backslash: return "\\"
        case .dash: return "-"
        case .underscore: return "_"
        case .colon: return ":"
        case .ctrlC: return "^C"
        case .ctrlD: return "^D"
        case .ctrlZ: return "^Z"
        case .ctrlL: return "^L"
        case .ctrlR: return "^R"
        case .paste: return "Вставить"
        case .hideKeyboard: return "Скрыть"
        }
    }

    /// Подробное название для экрана настроек.
    var settingsTitle: String {
        switch self {
        case .esc: return "Esc"
        case .tab: return "Tab — автодополнение"
        case .ctrl: return "Ctrl (залипающий)"
        case .alt: return "Alt (залипающий)"
        case .left: return "Стрелка влево"
        case .down: return "Стрелка вниз"
        case .up: return "Стрелка вверх"
        case .right: return "Стрелка вправо"
        case .home: return "Home — в начало строки"
        case .end: return "End — в конец строки"
        case .pageUp: return "Page Up"
        case .pageDown: return "Page Down"
        case .pipe: return "Вертикальная черта |"
        case .tilde: return "Тильда ~"
        case .slash: return "Слэш /"
        case .backslash: return "Обратный слэш \\"
        case .dash: return "Дефис -"
        case .underscore: return "Подчёркивание _"
        case .colon: return "Двоеточие :"
        case .ctrlC: return "Ctrl+C — прервать"
        case .ctrlD: return "Ctrl+D — выход"
        case .ctrlZ: return "Ctrl+Z — в фон"
        case .ctrlL: return "Ctrl+L — очистить экран"
        case .ctrlR: return "Ctrl+R — поиск по истории"
        case .paste: return "Вставить из буфера"
        case .hideKeyboard: return "Скрыть клавиатуру"
        }
    }

    /// SF Symbol вместо текста (для стрелок и служебных клавиш).
    var symbol: String? {
        switch self {
        case .left: return "arrow.left"
        case .down: return "arrow.down"
        case .up: return "arrow.up"
        case .right: return "arrow.right"
        case .paste: return "doc.on.clipboard"
        case .hideKeyboard: return "keyboard.chevron.compact.down"
        default: return nil
        }
    }

    var accessibilityLabel: String { settingsTitle }

    /// Залипающие модификаторы.
    var isModifier: Bool { self == .ctrl || self == .alt }

    /// Клавиши с автоповтором при удержании.
    var repeats: Bool {
        switch self {
        case .left, .down, .up, .right, .pageUp, .pageDown: return true
        default: return false
        }
    }

    /// Символ, который печатает символьная клавиша.
    var character: String? {
        switch self {
        case .pipe: return "|"
        case .tilde: return "~"
        case .slash: return "/"
        case .backslash: return "\\"
        case .dash: return "-"
        case .underscore: return "_"
        case .colon: return ":"
        default: return nil
        }
    }

    /// Байты, которые клавиша отправляет без модификаторов. `nil` — для Ctrl/Alt/Вставить/Скрыть.
    func bytes(applicationCursor: Bool) -> [UInt8]? {
        switch self {
        case .esc: return EscapeSequences.cmdEsc
        case .tab: return EscapeSequences.cmdTab
        case .left: return applicationCursor ? EscapeSequences.moveLeftApp : EscapeSequences.moveLeftNormal
        case .right: return applicationCursor ? EscapeSequences.moveRightApp : EscapeSequences.moveRightNormal
        case .up: return applicationCursor ? EscapeSequences.moveUpApp : EscapeSequences.moveUpNormal
        case .down: return applicationCursor ? EscapeSequences.moveDownApp : EscapeSequences.moveDownNormal
        case .home: return applicationCursor ? EscapeSequences.moveHomeApp : EscapeSequences.moveHomeNormal
        case .end: return applicationCursor ? EscapeSequences.moveEndApp : EscapeSequences.moveEndNormal
        case .pageUp: return EscapeSequences.cmdPageUp
        case .pageDown: return EscapeSequences.cmdPageDown
        case .ctrlC: return [0x03]
        case .ctrlD: return [0x04]
        case .ctrlZ: return [0x1a]
        case .ctrlL: return [0x0c]
        case .ctrlR: return [0x12]
        case .pipe, .tilde, .slash, .backslash, .dash, .underscore, .colon:
            return character.map { Array($0.utf8) }
        case .ctrl, .alt, .paste, .hideKeyboard:
            return nil
        }
    }

    /// Байты с учётом залипших Ctrl/Alt (кодировка xterm: ESC [ 1 ; m X).
    func bytes(control: Bool, meta: Bool, applicationCursor: Bool) -> [UInt8]? {
        let modifier = 1 + (meta ? 2 : 0) + (control ? 4 : 0)
        guard modifier > 1 else { return bytes(applicationCursor: applicationCursor) }
        func csi(_ final: String) -> [UInt8] { Array("\u{1b}[1;\(modifier)\(final)".utf8) }
        switch self {
        case .up: return csi("A")
        case .down: return csi("B")
        case .right: return csi("C")
        case .left: return csi("D")
        case .home: return csi("H")
        case .end: return csi("F")
        case .pageUp: return Array("\u{1b}[5;\(modifier)~".utf8)
        case .pageDown: return Array("\u{1b}[6;\(modifier)~".utf8)
        case .esc, .tab:
            guard let base = bytes(applicationCursor: applicationCursor) else { return nil }
            return meta ? [0x1b] + base : base
        case .pipe, .tilde, .slash, .backslash, .dash, .underscore, .colon:
            guard let char = character else { return nil }
            var out: [UInt8] = meta ? [0x1b] : []
            if control, let code = Self.controlByte(for: char) {
                out.append(code)
            } else {
                out.append(contentsOf: Array(char.utf8))
            }
            return out
        default:
            return bytes(applicationCursor: applicationCursor)
        }
    }

    /// Управляющий код для Ctrl+символ (как в xterm).
    static func controlByte(for char: String) -> UInt8? {
        switch char {
        case "\\", "|": return 0x1c
        case "~": return 0x1e
        case "/", "-", "_": return 0x1f
        default: return nil
        }
    }

    static let storageKey = "keyBarItems"

    static var defaultItems: [KeyBarItem] {
        [.esc, .ctrl, .alt, .tab, .left, .down, .up, .right,
         .pipe, .slash, .tilde, .dash, .ctrlC, .ctrlD, .ctrlL,
         .home, .end, .pageUp, .pageDown, .paste, .hideKeyboard]
    }

    static func load() -> [KeyBarItem] {
        guard let raw = UserDefaults.standard.string(forKey: storageKey) else { return defaultItems }
        var seen = Set<KeyBarItem>()
        let items = raw.split(separator: ",").compactMap { KeyBarItem(rawValue: String($0)) }.filter { seen.insert($0).inserted }
        return items.isEmpty ? defaultItems : items
    }

    static func save(_ items: [KeyBarItem]) {
        UserDefaults.standard.set(items.map(\.rawValue).joined(separator: ","), forKey: storageKey)
    }
}

// MARK: - Шрифты терминала

struct TerminalFont: Identifiable, Hashable {
    let id: String
    let title: String
    /// PostScript-имя жирного начертания, если оно есть в приложении.
    var boldName: String? = nil

    static let defaultName = "JetBrainsMono-Regular"

    static let all: [TerminalFont] = [
        TerminalFont(id: "JetBrainsMono-Regular", title: "JetBrains Mono", boldName: "JetBrainsMono-Bold"),
        TerminalFont(id: "IBMPlexMono-Regular", title: "IBM Plex Mono", boldName: "IBMPlexMono-Bold"),
        TerminalFont(id: "system", title: "SF Mono (системный)"),
        TerminalFont(id: "Menlo-Regular", title: "Menlo", boldName: "Menlo-Bold"),
        TerminalFont(id: "Courier", title: "Courier", boldName: "Courier-Bold"),
    ]

    static func font(_ name: String) -> TerminalFont? {
        all.first { $0.id == name }
    }

    static func title(for name: String) -> String {
        font(name)?.title ?? "SF Mono (системный)"
    }

    /// Шрифт по PostScript-имени; неизвестный или отсутствующий — системный моноширинный.
    static func uiFont(name: String, size: CGFloat) -> UIFont {
        if name != "system", let font = UIFont(name: name, size: size) {
            return font
        }
        return UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// Устанавливает шрифт в терминал, по возможности с настоящим жирным начертанием.
    static func apply(name: String, size: CGFloat, to view: TerminalView) {
        let normal = uiFont(name: name, size: size)
        let bold: UIFont
        if let boldName = font(name)?.boldName, let f = UIFont(name: boldName, size: size) {
            bold = f
        } else if name == "system" || UIFont(name: name, size: size) == nil {
            bold = UIFont.monospacedSystemFont(ofSize: size, weight: .bold)
        } else {
            view.font = normal
            return
        }
        let italic = derived(normal, trait: .traitItalic) ?? normal
        let boldItalic = derived(bold, trait: .traitItalic) ?? bold
        view.setFonts(normal: normal, bold: bold, italic: italic, boldItalic: boldItalic)
    }

    private static func derived(_ font: UIFont, trait: UIFontDescriptor.SymbolicTraits) -> UIFont? {
        guard let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(trait)) else { return nil }
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }
}

// MARK: - Панель клавиш (inputAccessoryView терминала)

/// Скролл, который позволяет листать, даже если палец лёг на кнопку.
private final class KeyScrollView: UIScrollView {
    override func touchesShouldCancel(in view: UIView) -> Bool { true }
}

final class KeyBar: UIInputView, UIInputViewAudioFeedback {
    private weak var terminalView: TerminalView?
    private let scrollView = KeyScrollView()
    private let stack = UIStackView()
    private var modifierButtons: [KeyBarItem: UIButton] = [:]
    private var repeatTask: Task<Void, Never>?
    private let haptics = UIImpactFeedbackGenerator(style: .light)
    private var observers: [NSObjectProtocol] = []

    private static let accent = UIColor(hex: "#3DDC97")
    private static let barHeight: CGFloat = 46

    var enableInputClicksWhenVisible: Bool { true }

    init(terminalView: TerminalView) {
        self.terminalView = terminalView
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: Self.barHeight), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        autoresizingMask = [.flexibleWidth]
        setupLayout()
        rebuild()

        let center = NotificationCenter.default
        for name in [Notification.Name.terminalViewControlModifierReset, .terminalViewMetaModifierReset] {
            let token = center.addObserver(forName: name, object: terminalView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.updateModifierStates()
                }
            }
            observers.append(token)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        for token in observers {
            NotificationCenter.default.removeObserver(token)
        }
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: Self.barHeight)
    }

    private func setupLayout() {
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.alwaysBounceHorizontal = true
        scrollView.delaysContentTouches = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrollView)

        stack.axis = .horizontal
        stack.spacing = 6
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),

            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])
    }

    /// Пересобирает кнопки по сохранённым настройкам.
    func rebuild() {
        stopRepeat()
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        modifierButtons.removeAll()
        for item in KeyBarItem.load() {
            stack.addArrangedSubview(makeButton(item))
        }
        updateModifierStates()
    }

    private func makeButton(_ item: KeyBarItem) -> UIButton {
        let button = UIButton(configuration: Self.configuration(for: item, active: false))
        button.tag = KeyBarItem.allCases.firstIndex(of: item) ?? 0
        button.accessibilityLabel = item.accessibilityLabel
        button.translatesAutoresizingMaskIntoConstraints = false
        button.heightAnchor.constraint(equalToConstant: 34).isActive = true
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        button.tintColor = Self.accent

        if item.repeats {
            button.addTarget(self, action: #selector(repeatBegan(_:)), for: .touchDown)
            button.addTarget(self, action: #selector(repeatEnded(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        } else {
            button.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
        }
        if item.isModifier {
            modifierButtons[item] = button
        }
        return button
    }

    private static func configuration(for item: KeyBarItem, active: Bool) -> UIButton.Configuration {
        var config: UIButton.Configuration
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            config = active ? .prominentGlass() : .glass()
        } else {
            config = active ? .filled() : .gray()
        }
        #else
        config = active ? .filled() : .gray()
        #endif

        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 11, bottom: 4, trailing: 11)
        if active {
            config.baseBackgroundColor = accent
            config.baseForegroundColor = .black
        } else {
            config.baseForegroundColor = .label
        }

        if let symbol = item.symbol {
            config.image = UIImage(systemName: symbol,
                                   withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold))
        } else {
            config.title = item.title
            let isWord = item.title.count > 1 && item.character == nil
            let titleFont: UIFont = isWord
                ? UIFont.systemFont(ofSize: 14, weight: .semibold)
                : UIFont.monospacedSystemFont(ofSize: 16, weight: .semibold)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = titleFont
                return outgoing
            }
        }
        return config
    }

    private func item(for button: UIButton) -> KeyBarItem? {
        let all = KeyBarItem.allCases
        guard button.tag >= 0, button.tag < all.count else { return nil }
        return all[button.tag]
    }

    private func feedback() {
        UIDevice.current.playInputClick()
        haptics.impactOccurred(intensity: 0.6)
    }

    private func updateModifierStates() {
        guard let terminalView else { return }
        for (item, button) in modifierButtons {
            let active = item == .ctrl ? terminalView.controlModifier : terminalView.metaModifier
            button.configuration = Self.configuration(for: item, active: active)
        }
    }

    // MARK: Действия

    @objc private func tapped(_ sender: UIButton) {
        guard let item = item(for: sender), let terminalView else { return }
        feedback()
        switch item {
        case .ctrl:
            terminalView.controlModifier.toggle()
            updateModifierStates()
        case .alt:
            terminalView.metaModifier.toggle()
            updateModifierStates()
        case .paste:
            terminalView.paste(nil)
        case .hideKeyboard:
            _ = terminalView.resignFirstResponder()
        default:
            send(item)
        }
    }

    /// Отправляет клавишу с учётом залипших модификаторов и сбрасывает их.
    private func send(_ item: KeyBarItem) {
        guard let terminalView else { return }
        let control = terminalView.controlModifier
        let meta = terminalView.metaModifier
        let applicationCursor = terminalView.getTerminal().applicationCursor
        guard let bytes = item.bytes(control: control, meta: meta, applicationCursor: applicationCursor) else { return }
        terminalView.send(bytes)
        if control { terminalView.controlModifier = false }
        if meta { terminalView.metaModifier = false }
        updateModifierStates()
    }

    @objc private func repeatBegan(_ sender: UIButton) {
        guard let item = item(for: sender) else { return }
        stopRepeat()
        feedback()
        send(item)
        repeatTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 450_000_000)
            while !Task.isCancelled {
                guard let self else { return }
                self.send(item)
                try? await Task.sleep(nanoseconds: 75_000_000)
            }
        }
    }

    @objc private func repeatEnded(_ sender: UIButton) {
        stopRepeat()
    }

    private func stopRepeat() {
        repeatTask?.cancel()
        repeatTask = nil
    }
}
