import EventKit
import EventKitUI
import UIKit

/// Puts a plan into the phone's calendar through Apple's own new-event sheet.
/// The sheet runs outside the app, so Muster never reads the calendar and
/// never asks for access to it.
final class CalendarSheet: NSObject, EKEventEditViewDelegate {
    @MainActor static let shared = CalendarSheet()
    private let store = EKEventStore()

    @MainActor
    func add(title: String, start: Date, end: Date, notes: String, from host: UIViewController) {
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = end
        event.notes = notes
        let sheet = EKEventEditViewController()
        sheet.eventStore = store
        sheet.event = event
        sheet.editViewDelegate = self
        host.present(sheet, animated: true)
    }

    func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
        DispatchQueue.main.async { controller.dismiss(animated: true) }
    }
}
