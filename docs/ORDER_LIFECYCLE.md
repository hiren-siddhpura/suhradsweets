# Order lifecycle and local testing

An active User may create, confirm, edit, archive and restore their own order. Staff retain their existing access; only staff may cancel a confirmed order, advance its fulfilment status or issue an invoice. Draft edits do not change stock. Editing a confirmed, in-preparation or ready order recalculates component demand and applies only the stock difference, with a matching movement for each changed item, in the same Firestore transaction. Archive is a soft flag and leaves status, stock and financial reporting intact. Restoring an archive does not alter stock.

The new-order customer selector starts with **+ Add New Customer** and lists permitted existing customers alphabetically. The shared customer dialog temporarily parks the live order form, so cancel or success restores entered lines, dates and notes. Staff can create the customer through the existing permission-checked customer transaction and select its real document ID immediately. For an ordinary User, customer details remain pending in the order form until the trusted draft-order transaction creates the customer and order together; no standalone customer document or fake ID is created. Existing contact reservations and ownership checks remain in force.

An invoice document, any payment history, or `paymentRequestedAt` blocks edits and archive/restore in the trusted backend. The legacy pre-invoice **Record payment request** operation records a lock before an invoice exists. It does not send a message, collect payment, create an invoice or count any amount as received. Invoice creation and payment request both read the order in a transaction, so concurrent edits or archive attempts retry against the updated state. Payment submission continues to require an invoice. These operations need deployed trusted Functions for live use; the browser cannot write order or inventory documents directly.

The Orders screen no longer offers the pre-invoice **Record payment request** button, because it does not create a financial record and was easily mistaken for the invoice payment action. Existing `paymentRequestedAt` orders and the trusted operation remain compatible. For new activity, staff create an invoice from a confirmed order; the owner then uses **Add payment** on that invoice. A User sees **Awaiting staff invoice** until an invoice exists, then **View invoice**.

Invoice creation records `order.invoice_created` and, if the order was not already locked by a pre-invoice request, `order.locked` in the same transaction. A pre-invoice request records `order.payment_requested` and `order.locked` together. The invoice starts `unpaid`. From the invoice, **Add payment** submits an unverified cash, UPI or bank-transfer payment and changes the invoice to `in_process`; another submission is blocked until review. Only verification increases the invoice's verified aggregate. A rejected payment restores `unpaid` or `partial`, and a verified partial payment permits a later submission for the balance. Admin and Account Admin can review submissions, but only Account Admin can mark a fully reconciled invoice paid. An unverified payment mode can be corrected with a reason and a matching immutable audit event. Verified payments require reversal.

The Orders screen shows all accessible orders by default, including archived history. The archive filter narrows the view without removing records from reports. The order editor shows stock from a restricted callable: `available = onHandQty - reservedQty`; current policy keeps reservedQty at zero. An unavailable reading is shown as unknown. The UI warns about insufficient stock, while confirmation and confirmed-order edit validate against current inventory in a backend transaction. Special-product stock comes from its component items.

New successful order activity events are written atomically to existing `auditLogs`. They include server timestamp, authenticated actor UID/name snapshot, order/customer identifiers and name snapshots, outcome, reason where supplied and field-level changes where applicable. Failed transactions do not create success events. User activity reads are limited to `ownerUid == caller UID`; staff may view all. Older audit events without `ownerUid` remain in Firestore but cannot be shown to a User by the restricted activity query. Legacy payments without name snapshots use a restricted batch name resolver; missing profiles display `Unknown user`. UIDs remain the permanent reference.

The order activity queries require the two `auditLogs` composite indexes in `firestore.indexes.json`: `referenceType ASC, at DESC` and `referenceType ASC, ownerUid ASC, at DESC`. They have only been prepared locally; no index or Rules were published. Search filters are applied to server-scoped pages and exported across the authorized filtered result set. With very sparse search matches, an export can require many page requests; retain operational filters and monitor scale before using this as a bulk archive facility.

## Local checks

From PowerShell in the project root, run:

```powershell
npm.cmd run test:unit
npm.cmd run test:orders
npm.cmd run test:finance
npm.cmd run test:rules
```

The emulator commands require Java 21 and Firebase CLI. Follow `README.md` for emulator setup and local app mode. Use only emulator accounts for these checks. In the Orders page, create a draft, confirm it, edit its quantity, inspect the stock movement and activity log, archive/restore it, then record a payment request and verify the edit/archive controls are locked. Staff can create an invoice instead and observe the same lock. No production data or deployment is needed for local tests.
