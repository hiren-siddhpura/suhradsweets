# Suhrad Sweets OMS

Plain HTML, CSS and JavaScript frontend with Firebase Authentication and Cloud Firestore. Firebase SDK browser modules come from the official CDN; there is no frontend build step. Root npm packages support local tests, while `functions/` has the trusted backend dependencies. No production data was seeded or changed.

## Local commands (Windows PowerShell)

```powershell
npm.cmd ci
npm.cmd run test:unit
npm.cmd run test:rules
npm.cmd run test:operations
npm.cmd run test:orders
npm.cmd run test:finance
npm.cmd run test:callables
npm.cmd run test:reporting
```

The rules command starts the Firebase Emulator Suite for the emulator-only `demo-suh-oms` namespace, runs the direct Firestore rules tests, and stops it. **Java 21 or newer** must be on `PATH` for the current Firebase CLI. On this machine, Java 17 was insufficient; the suite was executed with a temporary Eclipse Temurin 21 runtime. To inspect the local app with emulators, use a terminal:

```powershell
npx.cmd firebase emulators:start --project demo-suh-oms --only auth,firestore,functions,hosting
```

Run `npm.cmd ci --prefix functions` first, then open `http://127.0.0.1:5000`. On `localhost` and `127.0.0.1`, the frontend connects Authentication, Firestore and Functions to local emulators automatically. Create **local-only** test Auth users and profiles in the Emulator UI at `http://127.0.0.1:4000` to exercise the screens. Do not use production credentials for emulator tests. The existing `node dev-server.mjs` preview also connects to emulators when opened locally.

To check sign-in against your **existing Firebase project** from a local browser, start `node dev-server.mjs` and open `http://localhost:8000/?firebase=live`. This explicit URL uses the web configuration already in `js/firebase-config.js`; ordinary `http://localhost:8000/` keeps using emulators. Sign in with the existing Firebase Authentication account. Its Firestore document must be `users/{Authentication UID}` with `active: true` and `role: "admin"`, `"account_admin"`, or `"user"`. `fullName` or `displayName` is shown in the header. The profile's `email` is optional for OMS access. If Firebase reports an unauthorized domain, add `localhost` to Authentication's authorized domains in Firebase Console. This local live preview can write best-effort login/logout events to `loginLogs`; it does not seed any account or grant a role. Operational callables still require a deployed trusted backend, so use emulators for those workflows until one is deliberately deployed.

If access is denied, open the browser Developer Tools Console and read the `[OMS authentication]` entries. They show the Firebase mode and public project ID, plus a category such as `user-document-missing`, `user-account-inactive`, `user-role-or-profile-invalid`, `profile-read-permission-denied`, or `profile-read-network-error`. Compare the project ID with your Firebase Console project and the Firestore document ID with the Authentication UID. The app does not log UIDs, emails, passwords, tokens or profile contents. A permission denial in live mode requires checking the **published** Firestore Rules; changing the local file alone does not publish them.

`firebase.json` supplies local emulator settings and a Hosting allowlist via its ignore rules. There is no `.firebaserc` binding this workspace to a production Firebase project. Do not run `firebase deploy` as part of local testing.

## Phone access to local emulators

Run the existing emulators and `node dev-server.mjs`, then open `http://<computer-LAN-IP>:8000/` on a phone on the same private Wi-Fi. The development server proxies Auth, Firestore and Functions through port 8000 to the loopback emulators. A visible **Local emulator mode** banner confirms the demo project. LAN access through this server refuses `?firebase=live`.

Only port 8000 needs a Windows Firewall inbound rule, restricted to the **Private** profile and the phone's LAN address or subnet. Do not expose port 8000 on public networks. The emulators stay bound to `127.0.0.1` and need no LAN firewall rules. Keep the emulator process running to retain current in-memory data. Before a later restart, export data with `firebase emulators:export` and restart with `--import`.

On this workstation, Windows currently labels Wi-Fi **Public** and has existing broad Public inbound rules for Node.js. The development server independently rejects requests outside its own LAN subnet. To enforce the same restriction at the Windows Firewall layer, review other Node apps first, switch this trusted Wi-Fi to **Private**, and replace the broad Node.js rules with a TCP 8000 rule scoped to the phone or `10.59.12.0/24`.

## Security and schema

- [Complete 17-collection schema, business invariants and trusted-backend boundary](./docs/FIRESTORE_SCHEMA.md)
- [Direct-access Security Rules test matrix](./docs/SECURITY_TEST_MATRIX.md)
- [Master-data storage and query/index inventory](./docs/MASTER_DATA.md)
- [Dashboard, targets, announcements, logs, reporting queries and indexes](./docs/REPORTING.md)
- [Customer creation and editing with the client SDK, Rules and zero-budget setup](./docs/CUSTOMERS.md)

The rules default to deny. A User can read only their own orders, invoices, payments and order-linked inventory movements, plus customers assigned to their authenticated UID. Users may read active items, units and special products to enter orders. Staff manage standalone customers through a restricted Firestore transaction with matching contact reservations and audited changes. Admin may assign or reassign customers to active Users; unassigned legacy customers remain staff visible. Recipes, global order-taking, orders, stock changes, invoices and financial actions use trusted callables. Direct browser writes to those operational collections remain denied; client audit creation is limited to validated customer changes. Account Admin can execute Mark as Paid.

Reporting tables use server-side Firestore filters and cursor pagination; their composite indexes are declared in `firestore.indexes.json`. Regenerate that manifest with `node scripts/generate-report-indexes.mjs` after changing reporting queries. Older operational tables still load bounded or full authorized result sets for some client-side filters; see their module documentation before scaling those collections.

The former standalone customer form called an unavailable `saveCustomerCall` endpoint and could show `internal [0]` in live mode. It now uses Firestore directly with restrictive Rules. Publish the reviewed customer Rules manually before using the new form against live Firestore. Customer creation no longer requires Cloud Functions or Blaze; other trusted operational actions retain their backend requirement. See [customer setup and tests](./docs/CUSTOMERS.md).

The `js/firebase-config.js` file contains the browser web app configuration; keep private keys and service-account files out of this repository. On a non-localhost origin, the frontend uses the configured Firebase project. Review rules and tests before any production deployment.

## Cost boundary

Firebase Hosting, Authentication and Firestore can start on the Spark plan within current no-cost quotas. The trusted callable backend runs in emulators without billing, but deploying Cloud Functions requires Blaze and a billing account, and deployment can incur charges. If that requirement is unacceptable, keep these operations local or run an independently operated trusted service. Hosting the frontend alone will not make order or stock operations available. Nothing is deployed by these commands.

## Purchase and inventory behavior

Purchases are independent supplier expenses, with a manually entered total, paid amount, cash/UPI/bank-transfer details, notes and permission-controlled Drive link. Drafts can be edited; confirmation and cancellation update purchase status and audit records only. They never change Items, inventory or movements. Legacy line snapshots and existing stock movements are retained without migration; cancelling an old purchase does not reverse its historical stock effect. Payment status is staff-entered expense bookkeeping, separate from verified customer payments and Mark as Paid. See docs/PURCHASES.md. Inventory adjustments and order stock workflows remain independent.

## Customers, orders and special products

Staff can manage customers and set 2–4 item recipes with a manually chosen final price. Exact normalized customer contacts are reserved to prevent duplicate records; staff should review legitimate shared contacts manually. A User creates a new customer within the order form or selects a customer assigned to their UID. New customers created by Users are assigned to them; Admin may reassign existing customers without changing their IDs. `ownerUserIds` and order links are set by the backend, never accepted from the browser. Customer Sabha and date of birth are absent from order and invoice customer snapshots.

New orders are Confirmed when created. The trusted creation transaction checks product status, price, recipe and component stock, deducts stock once and writes audit and movement records. Existing Draft orders remain Draft until explicitly confirmed. Admin may edit a Confirmed order before invoicing; the edit reconciles stock in the same transaction. Admin, Account Admin and an assigned User may create one invoice from an eligible Confirmed order. Invoice creation uses saved snapshots, does not deduct stock again and locks later edits. The inventory model keeps `reservedQty` at zero, so confirmation uses immediate deduction instead of reservation. Staff can cancel an undelivered uninvoiced order once; cancellation restores stock with reversal movements. Delivered or invoiced orders require a separate return/credit workflow, which is not implemented. Users can submit payments for their own invoices; privileged staff can review payments. Only verified, unreversed payments reduce the balance. Account Admin can mark a fully reconciled invoice paid. Payment corrections use explicit reversal records. Invoice PDFs use a fresh authorized Firestore read and omit Sabha. Browser PDF/XLSX exports load open-source libraries from CDNs.

Google Drive links must use `https://drive.google.com/file/d/<file-id>/view`. The app validates URL shape; Drive permissions still determine who can open the file. Share only with intended recipients in Drive, preferably named accounts. XLSX export loads open-source SheetJS CE from its CDN when clicked and requires a network connection. Exports reflect currently filtered records.

## Local user account management

Master Data > Users now accepts full name, email, role and active status without UID entry.
The trusted backend creates Auth accounts and matching profiles with retry-safe provisioning.
Live Add User calls the trusted `saveUserProfileCall`; Admin may manage supported roles and Account Admin may manage User profiles. Deploy the tested Function before publishing this Hosting build. This work does not deploy it.
See [user management and local tests](docs/USER_MANAGEMENT.md). Run `npm.cmd run test:users` with Java 21.
