# Independent purchases

Purchases are staff-only supplier expenses. They have no Item or inventory dependency.
The form stores supplierName, purchaseDate, purchaseTypeId and its name snapshot,
quantity, unit, totalPaise, paidAmountPaise, paymentMode, paymentReference, paymentStatus, notes,
documentUrl, creator/update identities, server timestamps and schemaVersion 3.
Amounts use integer paise; new totals/payment amounts are nonnegative and at most
100,000,000,000 paise. Paid amount cannot exceed the total. Zero paid amount is unpaid;
a positive lesser amount is partial; a positive full amount is paid. These are manually
recorded supplier expense details, not verified customer funds or customer payment records.
UPI/bank transfer with a positive paid amount requires a reference; cash uses "-".
No additional payment submission or invoice Mark as Paid feature is introduced.

savePurchaseDraftCall, confirmPurchaseCall and cancelPurchaseCall retain their names.
Each checks the authoritative active staff profile and writes an atomic audit.
Only drafts are editable. Confirmation/cancellation never reads or writes stock.
Client writes remain denied by Firestore Rules; no Firestore Rules/index changes are required.
Existing list/search/status/date filters and exports use purchase fields, not item lines.
XLSX exports purchase totals and payment metadata in one sheet; legacy line details are
retained in Firestore but excluded from current exports. No new Firestore queries/indexes.
Drive view links require explicit permissions in Drive; links alone are not private.

## Legacy compatibility

No migration runs. Existing totalPaise and line snapshots remain readable, and draft
edits merge fields so historical lines, creator and creation timestamp survive.
Old forms sending item lines are rejected with a reload instruction. Previously recorded
inventory movements remain visible as historical receipts. Cancelling an old confirmed
purchase does not reverse stock. Any historical stock reconciliation must be an explicit,
separately authorized inventory adjustment. Old payment details display "Not recorded".
Historical totals up to the former 1,000,000,000,000-paise ceiling may still be confirmed;
editing them uses the new amount ceiling and requires review if above it.

The existing backend still requires a running Functions emulator locally, or an approved
deployment for live use. This change does not deploy, publish Rules or change billing.
Older deployed backend code, if present, would retain its former behavior until replaced.

## Tests

With Java 21 and free emulator ports: `npm.cmd run test:operations`.
With Firestore already running locally:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
node --test tests/operations.test.mjs
node --test tests/purchase-ui.test.mjs
```

The operation suite uses an isolated demo-independent-purchase-tests emulator namespace.
It covers item-free create/edit/confirm/cancel, no stock mutation, authorization, payment
validation, legacy preservation, duplicate/concurrent confirmation and independent
inventory adjustments. Callable test fixtures also use the new purchase payload.

Quantity is required free text of at most 120 characters. Plain numeric quantities must be greater than zero. Unit is optional free text of at most 80 characters. Both are trimmed and saved independently from Items, Master Data units, stock and the entered total. Existing numeric quantities remain readable; new saves store quantity as text. Missing quantity or unit displays "Not recorded". Editing a legacy draft requires entering quantity, while its Unit may remain blank. Confirming or cancelling historical records does not require a migration.

## File attachments

Purchase drafts accept one optional JPG, JPEG, PNG or PDF file of at most 5 MiB
(shown as 5 MB in the form). Existing Google Drive links remain available.
Uploads reuse the private Firebase Storage workflow, under
`purchaseReceipts/{staffUid}/{purchaseId}/{uploadId}.{extension}`. Only active
Admin and Account Admin accounts may upload or download; direct Storage reads
and overwrites are denied. Storage enforces the size and MIME type; the trusted
save validates the file signature, size and purchase metadata before linking it.
Editing without selecting a file preserves the saved attachment; selecting a
new file replaces the purchase's attachment reference. An Attachment download
button is available on desktop and mobile lists. No public download URL is stored.

Live use requires deploying Hosting, Storage rules, `savePurchaseDraftCall` and
`readPurchaseReceiptCall`. Test with `npm.cmd run test:purchase-attachments`.
The production default bucket is `suhrad-sweets-oms.firebasestorage.app`, located
in `asia-south1` alongside Firestore. Its Firebase Storage service agent needs
`roles/firebaserules.firestoreServiceAgent` to evaluate the staff checks in
Storage rules. Noninteractive Firebase CLI deployments do not configure that
cross-service permission automatically.
