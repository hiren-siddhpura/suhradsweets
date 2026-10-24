# Human-readable activity history

Order Activity, Payment Activity, Audit Logs, dashboard activity, and their exports use `js/activity-format.js` to turn the existing immutable event data into business-language records.

The formatter uses event snapshots first: actor name, customer name, order number, invoice number, amount, and payment method. It does not treat a Firestore document ID as a business reference. Older records without snapshots show `Not available` rather than guessed information.

Known event types, financial paise fields, statuses, payment modes, reasons, before/after values, and short item lists are formatted consistently. Stringified JSON is parsed only when valid. Malformed data never interrupts the log view and falls back to a neutral summary.

Audit Logs are restricted to staff by the existing access rules. Their normal rows and XLSX exports omit UIDs and internal document IDs. Staff can expand the technical-details disclosure in the Audit Log for an investigation. No history was migrated, rewritten, or deleted.
