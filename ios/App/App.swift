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

    private static var unsent = false
    private static var holding = UIBackgroundTaskIdentifier.invalid

    static func launched() {
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            // Straight away: the time iOS allows has to be asked for before this returns.
            MainActor.assumeIsolated { hold() }
        }
    }

    static func setUp(_ shell: Shell) {
        // Notifications may have been switched in Settings while the app was away.
        shell.onActive = { [weak shell] in shell?.run("window.musterAsk && musterAsk()") }
        shell.onMessage = { type, msg in
            switch type {
            case "unsent":
                unsent = msg["on"] as? Bool ?? false
                if !unsent { letGo() }
                return true
            default:
                return false
            }
        }
    }

    /// Changes still waiting to be sent: ask iOS for a little longer when the app goes out of sight.
    private static func hold() {
        guard unsent, holding == .invalid else { return }
        holding = UIApplication.shared.beginBackgroundTask { Task { @MainActor in letGo() } }
    }

    private static func letGo() {
        guard holding != .invalid else { return }
        UIApplication.shared.endBackgroundTask(holding)
        holding = .invalid
    }

    /// A group's link: https://muster.teloone.au/g/<id>, or muster://g/<id>.
    static func opened(link: URL) {
        let path = link.scheme == "muster" ? "/" + (link.host ?? "") + link.path : link.path
        guard path.hasPrefix("/g/") else { return }
        // A link that's the wrong length opens the page that says so.
        let whole = path.range(of: "^/g/[A-Za-z0-9_-]{22}/?$", options: .regularExpression) != nil
        Shell.current?.show(whole ? path : "/g/-")
    }

    /// A tapped reminder opens the group it was about.
    static func opened(notification: [AnyHashable: Any]) {
        guard let path = notification["open"] as? String,
              path.range(of: "^/g/[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil else { return }
        Shell.current?.show(path)
    }
}
