import SwiftUI
import SafariServices

/// Системное меню «Поделиться».
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Встроенный Safari — для веб-панелей, открытых через проброс портов.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.barCollapsingEnabled = true
        let vc = SFSafariViewController(url: url, configuration: config)
        vc.preferredControlTintColor = UIColor(hex: "#3DDC97")
        return vc
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// Обёртка для `.sheet(item:)` с URL.
struct IdentifiedURL: Identifiable {
    let id = UUID()
    let url: URL
}

extension View {
    /// Диалог «Доверять новому серверу?» с отпечатком ключа.
    func hostKeyAlert(_ request: Binding<HostKeyRequest?>, onTrust: @escaping () -> Void) -> some View {
        alert("Новый сервер", isPresented: Binding(
            get: { request.wrappedValue != nil },
            set: { if !$0 { request.wrappedValue = nil } }
        ), presenting: request.wrappedValue) { req in
            Button("Доверять и подключиться") {
                req.trust()
                request.wrappedValue = nil
                onTrust()
            }
            Button("Отмена", role: .cancel) { request.wrappedValue = nil }
        } message: { req in
            Text("\(req.hostLabel)\n\n\(req.fingerprint)\n\nСверьте отпечаток с сервером: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")
        }
    }
}
