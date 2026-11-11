import UIKit

/// Muster on iPhone: the same pages as the website, kept in the app.
@MainActor
enum App {
    static let config = ShellConfig(
        bridge: "musterApp",
        host: "muster",
        root: "/",
        start: "/",
        background: UIColor(named: "Page") ?? .systemBackground,
        // A group's address has no file behind it: the one page draws it.
        isAppPath: { $0.hasPrefix("/g/") }
    )

    static func launched() {}
    static func setUp(_ shell: Shell) {
        // Notifications may have been switched in Settings while the app was away.
        shell.onActive = { [weak shell] in shell?.run("window.musterAsk && musterAsk()") }
    }

    /// A group's link: https://muster.teloone.au/g/<id>, or muster://g/<id>.
    static func opened(link: URL) {
        let path = link.scheme == "muster" ? "/" + (link.host ?? "") + link.path : link.path
        guard path.range(of: "^/g/[A-Za-z0-9_-]{22}/?$", options: .regularExpression) != nil else { return }
        Shell.current?.show(path)
    }

    /// A tapped reminder opens the group it was about.
    static func opened(notification: [AnyHashable: Any]) {
        guard let path = notification["open"] as? String,
              path.range(of: "^/g/[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil else { return }
        Shell.current?.show(path)
    }
}
