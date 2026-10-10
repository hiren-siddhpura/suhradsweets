# Security test matrix

Run `npm.cmd run test:rules`, `npm.cmd run test:operations`, `npm.cmd run test:orders` and `npm.cmd run test:callables` on Windows PowerShell (or `npm run` elsewhere). The rules command exercises direct client SDK reads/writes. The operation commands exercise trusted Firestore transactions. The callable command exercises the actual Auth and Functions emulator boundary. All use emulator-only `demo-suh-oms` and stop the emulators afterward. Do not substitute the Firebase Console Data tab or an Admin SDK for direct Security Rules checks: privileged access bypasses Rules.

Purchase/inventory coverage includes independent amount/payment validation, zero stock effect throughout the purchase lifecycle, legacy snapshot preservation, repeated and simultaneous confirmation denial, adjustment idempotency, selling controls and bad Drive URL rejection. Order coverage includes customer duplicate prevention, ownership links, draft stock isolation, component deductions, historical recipe snapshots, global pause, blocked items, stale price rejection, concurrent oversell prevention, exactly-once cancellation, delivered/invoiced cancellation denial and Sabha exclusion from invoices. Direct operational writes are denied for all roles. The callable test includes anonymous, User, Admin and Account Admin identities.

| Actor | Direct Firestore request | Required result |
|---|---|---|
| Signed out | Read any profile or operational record | Denied |
| Missing, inactive or invalid profile | Read operational data | Denied |
| User | Read own order, invoice, payment and customer linked to own order | Allowed |
| User | Read another user's order, invoice, payment, customer or profile | Denied |
| User | Query orders with `ownerUid == own UID`; query all orders | Own query allowed; unscoped query denied |
| Admin or Account Admin | Read named operational collections and staff master data | Allowed |
| Any role | Read an unknown collection | Denied |
| User, Admin or Account Admin | Change own role/profile | Denied |
| Account Admin | Promote a User to staff or edit an Admin profile | Denied |
| Admin | Change another User's role | Allowed |
| User, Admin or Account Admin | Direct Mark as Paid or payment verification update | Denied; trusted callable enforces role and reconciliation |
| User, Admin or Account Admin | Direct order/customer/special/invoice/purchase/inventory/movement write or snapshot edit | Denied; trusted callable only |
| User | Query active items and special products; read global order-taking state | Allowed; inactive products denied |
| User | Change `ownerUserIds` or order links to gain access | Denied |
| Browser client | Create arbitrary `auditLogs`, edit or delete audit history | Denied; staff may create only a validated, paired customer audit event |
| Signed-in client | Create `loginLogs` for own UID and server time; claim another UID | Own event allowed; spoof denied |
| Staff | Atomically create item and code reservation | Allowed when both valid; item alone or duplicate code denied |
| User | Write any master data; permanently delete referenced unit/item | Denied |

The automated suite covers these boundaries and the implemented order stock operations. Run `npm run test:finance` for partial and multiple payments, normalized duplicate online references, insufficient or stale balances, competing verification, Account Admin-only Mark as Paid, explicit reversal, duplicate invoice creation and PDF field privacy. `npm run test:rules` also checks direct invoice/payment/reference/reversal writes and cross-user reversal reads. A separate return/credit workflow remains unavailable.
