import SwiftUI

/// Настройка панели клавиш над клавиатурой: какие клавиши показывать и в каком порядке.
struct KeyBarSettingsView: View {
    @State private var order: [KeyBarItem] = []
    @State private var enabled: Set<KeyBarItem> = []
    @State private var loaded = false

    private var activeItems: [KeyBarItem] {
        order.filter { enabled.contains($0) }
    }

    var body: some View {
        List {
            Section {
                KeyBarPreview(items: activeItems)
                    .listRowInsets(EdgeInsets())
            } footer: {
                Text("Так панель выглядит над клавиатурой. Ctrl и Alt залипают до следующей клавиши, стрелки повторяются при удержании. Двумя пальцами по терминалу — тоже стрелки, щипок — размер шрифта.")
            }

            Section {
                ForEach(order) { item in
                    KeyBarSettingsRow(item: item, isOn: binding(for: item))
                }
                .onMove(perform: move)
            } header: {
                Text("Клавиши")
            } footer: {
                Text("Нажмите «Править», чтобы перетащить клавиши и поменять порядок.")
            }

            Section {
                Button("Сбросить по умолчанию", role: .destructive, action: reset)
            }
        }
        .navigationTitle("Панель клавиш")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            EditButton()
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        let current = KeyBarItem.load()
        enabled = Set(current)
        order = current + KeyBarItem.allCases.filter { !Set(current).contains($0) }
    }

    private func binding(for item: KeyBarItem) -> Binding<Bool> {
        Binding(
            get: { enabled.contains(item) },
            set: { isOn in
                if isOn {
                    enabled.insert(item)
                } else if enabled.count > 1 {
                    enabled.remove(item)
                }
                persist()
            }
        )
    }

    private func move(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        persist()
    }

    private func reset() {
        let defaults = KeyBarItem.defaultItems
        enabled = Set(defaults)
        order = defaults + KeyBarItem.allCases.filter { !Set(defaults).contains($0) }
        persist()
    }

    private func persist() {
        KeyBarItem.save(activeItems)
        SessionManager.shared.refreshAppearance()
    }
}

private struct KeyBarSettingsRow: View {
    let item: KeyBarItem
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 12) {
                KeyCap(item: item)
                    .frame(minWidth: 56)
                Text(item.settingsTitle)
                    .lineLimit(2)
            }
        }
    }
}

/// Клавиша в стиле панели (стекло на iOS 26).
private struct KeyCap: View {
    let item: KeyBarItem

    var body: some View {
        Group {
            if let symbol = item.symbol {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .semibold))
            } else if item.character != nil {
                Text(item.title)
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
            } else {
                Text(item.title)
                    .font(.system(size: 13, weight: .semibold))
            }
        }
        .padding(.horizontal, 10)
        .frame(minWidth: 38, minHeight: 30)
        .foregroundStyle(item.isModifier ? Color.accentColor : Color.primary)
        .glassCapsule(interactive: false)
    }
}

private struct KeyBarPreview: View {
    let items: [KeyBarItem]

    var body: some View {
        ZStack {
            AuroraBackground()
            ScrollView(.horizontal, showsIndicators: false) {
                GlassGroup(spacing: 6) {
                    HStack(spacing: 6) {
                        ForEach(items) { item in
                            KeyCap(item: item)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
        .frame(height: 78)
        .clipped()
    }
}
