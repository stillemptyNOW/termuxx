import SwiftUI

// Liquid Glass (iOS 26+) с аккуратным откатом на материалы для iOS 17–18.
// Всё, что относится к стеклу, собрано здесь, чтобы остальной код не думал о версиях.

extension View {
    /// Стеклянная карточка со скруглёнными углами.
    @ViewBuilder
    func glassCard(cornerRadius: CGFloat = 22, tint: Color? = nil, interactive: Bool = false) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            let base: Glass = tint.map { Glass.regular.tint($0) } ?? .regular
            self.glassEffect(interactive ? base.interactive() : base,
                             in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            self.legacyGlass(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous), tint: tint)
        }
        #else
        self.legacyGlass(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous), tint: tint)
        #endif
    }

    /// Стеклянная «пилюля» (для чипов, баннеров, плавающих кнопок).
    @ViewBuilder
    func glassCapsule(tint: Color? = nil, interactive: Bool = true) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            let base: Glass = tint.map { Glass.regular.tint($0) } ?? .regular
            self.glassEffect(interactive ? base.interactive() : base, in: Capsule())
        } else {
            self.legacyGlass(Capsule(), tint: tint)
        }
        #else
        self.legacyGlass(Capsule(), tint: tint)
        #endif
    }

    /// Стеклянный круг (иконки-кнопки).
    @ViewBuilder
    func glassCircle(tint: Color? = nil, interactive: Bool = true) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            let base: Glass = tint.map { Glass.regular.tint($0) } ?? .regular
            self.glassEffect(interactive ? base.interactive() : base, in: Circle())
        } else {
            self.legacyGlass(Circle(), tint: tint)
        }
        #else
        self.legacyGlass(Circle(), tint: tint)
        #endif
    }

    /// Кнопка в стиле Liquid Glass: `.glass` / `.glassProminent` на iOS 26, `.bordered` / `.borderedProminent` раньше.
    @ViewBuilder
    func glassButtonStyle(prominent: Bool = false) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            if prominent {
                self.buttonStyle(.glassProminent)
            } else {
                self.buttonStyle(.glass)
            }
        } else {
            if prominent { self.buttonStyle(.borderedProminent) } else { self.buttonStyle(.bordered) }
        }
        #else
        if prominent { self.buttonStyle(.borderedProminent) } else { self.buttonStyle(.bordered) }
        #endif
    }

    /// На iOS 26 таб-бар прячется при прокрутке вниз.
    @ViewBuilder
    func minimizingTabBar() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// Совпадающая геометрия стекла для анимаций «перетекания» (iOS 26+). На старых iOS — ничего.
    @ViewBuilder
    func glassID<ID: Hashable & Sendable>(_ id: ID, in namespace: Namespace.ID) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.glassEffectID(id, in: namespace)
        } else {
            self
        }
        #else
        self
        #endif
    }

    private func legacyGlass<S: Shape>(_ shape: S, tint: Color?) -> some View {
        self
            .background(.ultraThinMaterial, in: shape)
            .background((tint ?? .clear).opacity(0.18), in: shape)
            .overlay(shape.stroke(Color.white.opacity(0.10), lineWidth: 0.5))
    }
}

/// Группа стеклянных элементов: на iOS 26 они сливаются и перетекают друг в друга.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 10
    @ViewBuilder var content: () -> Content

    var body: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content() }
        } else {
            content()
        }
        #else
        content()
        #endif
    }
}

/// Тёмный фон с мягкими цветными пятнами — на нём Liquid Glass выглядит живым.
struct AuroraBackground: View {
    var accent: Color = Color(hex: "#3DDC97")

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: "#0B1018"), Color(hex: "#05070B")],
                           startPoint: .top, endPoint: .bottom)
            GeometryReader { geo in
                let w = geo.size.width, h = geo.size.height
                Circle().fill(accent.opacity(0.35))
                    .frame(width: w * 0.9).blur(radius: 90)
                    .position(x: w * 0.15, y: h * 0.08)
                Circle().fill(Color(hex: "#4EA8FF").opacity(0.28))
                    .frame(width: w * 0.8).blur(radius: 100)
                    .position(x: w * 0.95, y: h * 0.35)
                Circle().fill(Color(hex: "#B48CFF").opacity(0.22))
                    .frame(width: w * 0.9).blur(radius: 110)
                    .position(x: w * 0.3, y: h * 0.9)
            }
        }
        .ignoresSafeArea()
    }
}
