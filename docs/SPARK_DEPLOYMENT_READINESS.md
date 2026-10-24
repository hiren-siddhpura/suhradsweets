# Firebase Spark deployment readiness

## Verified target

The Firebase CLI selected `suhrad-sweets-oms` (project number `754303494893`).
`prabodham-kids` is a separate visible project and is out of scope. This document
does not authorize a deployment or a billing change.

Firebase Hosting now publishes only the generated `dist/` directory. Build it with
`npm.cmd run build:static`; validate its file allowlist and credential scan with
`npm.cmd run verify:spark-release`. The build copies only `index.html`, `css/`,
`js/`, and `logo/`. It cannot publish source tests, Git metadata, logs, rules,
documentation, Functions code, package files, or dependencies.

## Spark-compatible workflows

The following are already protected by Firebase Authentication and Firestore Rules
without a Functions deployment:

- Sign-in, sign-out, profile read, and restricted reads.
- Login/logout telemetry for the signed-in user.
- Staff master-data writes for items, units, purchase types, and settings, where
  each rule can fully validate the bounded write.
- Staff customer create/edit and admin customer assignment, using the paired
  customer-contact reservation and audit transaction validated with `getAfter()`.
- Customer import only to the extent that it uses those same restricted client
  transactions and reports per-row failures.

## Workflows deliberately unavailable on Spark alone

These operations remain denied to every browser by `firestore.rules` and currently
depend on the callable Functions implementation:

| Area | Callable operations | Why Rules alone are insufficient |
| --- | --- | --- |
| User provisioning | `saveUserProfile` | Creating/disabling Firebase Auth accounts and reconciling Auth with Firestore requires Admin SDK authority. |
| Inventory | `adjustStock`, `setInventoryControl` | Atomic stock counts, movement history, idempotency, and audit records span documents. |
| Purchases | `savePurchaseDraft`, `confirmPurchase`, `cancelPurchase` | Lifecycle validation and authoritative audits are protected backend operations. |
| Orders | `saveOrderDraft`, `confirmOrder`, `cancelOrder`, `advanceOrder`, `archiveOrder`, `restoreOrder`, `requestOrderPayment`, `setOrderTaking`, `createInvoiceFromOrder` | Server-derived price snapshots, stock arithmetic across variable lines, state locks, counters, and movements cannot be safely implemented by an untrusted client. |
| Special products | `saveSpecialProduct` | Recipe snapshots and protected component pricing require trusted validation. |
| Payments and invoices | `submitPayment`, `reviewPayment`, `changePaymentMode`, `reversePayment`, `markInvoicePaid` | Payment reference uniqueness, aggregates, reversals, invoice balance reconciliation, and role-specific finalization need trusted aggregation. |
| Scoped operational reads | `getOrderStock`, `getPaymentNames`, `listOrderActivity`, `listPaymentActivity` | These combine records and resolve private names with role/ownership checks. |
| Targets and announcements | `saveTarget`, `saveAnnouncement` | Existing design requires authoritative audit writes. |
| Customer deletion | `deleteCustomer` | Dependency checks and reservation release must be atomic. |

Do not loosen Rules or add client-side role fields to make these workflows appear to
work. A complete OMS cannot run securely with Firebase Spark alone under the current
data model. It needs a separately approved trusted backend, or a redesign that removes
these workflows and their financial/inventory guarantees.

## Required verification before any approval

```powershell
npm.cmd ci
npm.cmd run build:static
npm.cmd run test:unit
npm.cmd run test:rules
npm.cmd run verify:spark-release
```

`test:rules` requires Java 21 or newer and uses only the `demo-suh-oms` emulator
project. Do not run any Firebase deploy command during preparation.

After every command above succeeds and the unresolved Functions workflows have an
approved trusted-backend plan, the deployment commands to review are:

```powershell
npx.cmd firebase deploy --only hosting --project suhrad-sweets-oms
npx.cmd firebase deploy --only firestore:rules,firestore:indexes --project suhrad-sweets-oms
```

Run neither command without explicit approval. They intentionally omit Functions and
do not change Firebase billing.
