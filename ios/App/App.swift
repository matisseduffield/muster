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
        isAppPath: { $0.hasPrefix("/g/") || $0.hasPrefix("/j/") }
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
        shell.onMessage = { [weak shell] type, msg in
            switch type {
            case "calendar":
                // Apple's own new-event sheet, filled in. It needs no permission:
                // the person sees the entry and saves or cancels it themselves.
                guard let shell, shell.presentedViewController == nil,
                      let start = (msg["start"] as? NSNumber)?.doubleValue, let end = (msg["end"] as? NSNumber)?.doubleValue else { return true }
                CalendarSheet.shared.add(
                    title: msg["title"] as? String ?? "",
                    start: Date(timeIntervalSince1970: start / 1000),
                    end: Date(timeIntervalSince1970: end / 1000),
                    notes: msg["notes"] as? String ?? "",
                    from: shell
                )
                return true
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
    /// A join code's link: https://muster.teloone.au/j/<code>.
    static func opened(link: URL) {
        let path = link.scheme == "muster" ? "/" + (link.host ?? "") + link.path : link.path
        if path.hasPrefix("/j/") {
            let code = path.range(of: "^/j/[A-Za-z]{4}/?$", options: .regularExpression) != nil
            Shell.current?.show(code ? path : "/g/-")
            return
        }
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
