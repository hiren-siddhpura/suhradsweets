# Customer workflow without Cloud Functions

Standalone customer creation and editing now use `saveCustomerDirect` in `js/customer-data.js`. This client transaction is appropriate for customer metadata because Firestore Rules can validate every field and cross-document relationship. Order confirmation, inventory and financial operations retain their trusted backend requirements.

## Permissions

- Active Admin and Account Admin profiles can create and edit customers. `createdBy` comes from Firebase Auth and is immutable. Updates identify the authenticated actor in `updatedBy`.
- New standalone customers start with empty `ownerUserIds` and `orderLinks`. Even staff cannot set or change those fields through the client SDK.
- Normal Users retain read access only to customers linked through an authoritative owned order. They cannot list all customers, create standalone customers, edit customer data, or change ownership. New customer creation inside a User's order draft still depends on the existing trusted order workflow; this change does not provide live draft-order creation without a backend.
- Client deletion of customers and audit history is denied for every role.

## Atomic integrity and duplicates

A single transaction writes the customer, `customerContacts/{SHA-256(normalizedContact)}` reservation, and a `customer.created` or `customer.updated` audit event. Rules independently compute the contact hash and use `getAfter` to validate the matching writes. Audits must match the actor, entity, server timestamp and before/after values. All other client-written audit types remain denied. The customer stores `lastAuditId`; edits preserve its original author, creation time and order ownership links.

Normalization trims and lowercases the contact and removes whitespace, parentheses and hyphens. It is compatible with the existing backend reservations. A changed contact releases its old reservation and reserves the new contact atomically. Direct requests cannot steal an existing reservation or substitute a fake hash. Contacts which differ by country prefix or represent the same person with different numbers are not automatically detected; staff must review those cases. Legacy customers entered without contact reservations need reviewed migration before global duplicate guarantees can cover them. No migration or production seeding runs automatically.

The form generates one customer ID when opened, disables concurrent Save submissions, and reuses that ID after a failed or uncertain request. Repeating an identical successful creation returns the existing customer without creating another record or audit. Different concurrent submissions for the same normalized contact produce one customer. Transactions require network connectivity and may retry; failures are not reported as successful saves.

## Validation and privacy

Required fields are trimmed nonempty strings: `fullName` (120), `contact` (80), `address` (300), and `area` (100 characters). Optional `dateOfBirth` is null or a real YYYY-MM-DD calendar date, and `sabha` must be boolean. Rules repeat these checks, restrict document fields, and require server timestamps. Audit details are staff-readable and contain relevant customer before/after values; ordinary Users cannot read the audit collection. Customer edits do not rewrite historical order or invoice snapshots. Sabha remains absent from invoices.

## Manual live setup

Review `firestore.rules`, then copy the complete reviewed file into **Firebase Console → Cloud Firestore → Rules** and publish it when ready. This is required because the old published Rules deny direct customer writes. Updating the local file does not change production. No Cloud Functions deployment or Blaze plan is required for this customer-only workflow. Use `http://localhost:8000/?firebase=live` with the existing account after publishing. This task does not publish Rules or modify live records.

## Testing

### Permanent deletion

The staff-only Delete action confirms the customer's name and invokes `deleteCustomerCall`.
Direct Firestore customer deletion remains denied, including for staff. No Rules change is needed.
Unlike customer creation/editing, this operation requires a running trusted backend: use the
Functions emulator locally. Live deletion stays unavailable until the callable is deployed;
Firebase Cloud Functions deployment requires Blaze. No deployment or billing change is performed.

The backend checks the authoritative active staff profile, permanent customer ownership/order links,
and all statuses of orders, invoices, payments, paymentReversals, purchases and inventoryMovements.
Queries use `customerId`, `customerSnapshot.customerId`, and conservatively the current snapshot contact
for legacy records. These are equality queries with `limit(1)` and require only default single-field
indexes (no composite indexes). Any single-field index exemptions for these fields must be reviewed.
Reservation release, customer deletion and `customer.deleted` audit creation occur in one transaction.
Existing audit entries and all transactions are retained. A missing reservation is permitted;
a reservation belonging to another customer blocks deletion for administrative review.

Order draft creation reads and updates the customer in its transaction. Concurrent deletion and
order creation therefore conflict and retry; a successful order prevents deletion, while a successful
deletion prevents that order from being created. Every future customer-bearing transaction writer
must also read the customer transactionally and extend the backend dependency registry as needed.
Current invoices, payments and reversals descend from retained orders, which independently block deletion.
Legacy orphan records with no customer ID, usable snapshot or surviving parent cannot be associated
reliably; review/repair such imported records before enabling deletion. Snapshot contact matches can
conservatively block an unrelated customer; resolve through administrative review, not forced deletion.

Run `npm.cmd run test:customer-delete` with port 8080 free. With an existing Firestore emulator:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
node --test tests/customer-delete.test.mjs
```

With Java 21+, local dependencies and no existing emulator occupying port 8080:

```powershell
npm.cmd run test:unit
npm.cmd run test:customers
npm.cmd run test:rules
npm.cmd run test:orders
```

With the Emulator Suite already running on port 8080, test the new customer workflow in its separate demo namespace without restarting it:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
node --test tests/customer-client.test.mjs
```

Tests cover staff creation/editing, anonymous/inactive/User denial, ownership and author tampering, contact-hash tampering, real calendar dates, required paired audit writes, concurrent duplicate contacts, repeated submissions, cross-user reads, and immutable audit/customer history. The UI test checks that a Firestore permission denial stays visible in the open form and does not call Cloud Functions.

References: [Firebase atomic transaction validation](https://firebase.google.com/docs/firestore/manage-data/transactions), [Rules hashing](https://firebase.google.com/docs/reference/rules/rules.hashing).
