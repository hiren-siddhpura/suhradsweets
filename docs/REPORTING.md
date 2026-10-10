# Dashboard and reporting

## Eligible sales and target achievement

The dashboard has four cards: **Total Orders** (non-cancelled order count and confirmed KG), **Target Achievement**, **Available Stock**, and **Total Selling**. It shows all-time authorized totals without date filters. The KG target is entered in Master Data's **Sales target (KG)** field and stored as a nonnegative decimal string in `settings/dashboard_sales_target` (`key: dashboardSalesTargetKg`). Dashboard achievement is all-time confirmed KG divided by this configured KG target; zero or an unset target displays `N/A`. This dashboard target is separate from the per-User monetary targets below.

Selling includes confirmed, in-preparation, ready, and delivered orders, using immutable `stockDeductions` snapshots. Draft and cancelled orders do not contribute KG. Special products contribute their underlying component weights exactly once. Kilogram milli-units divide by 1,000; gram milli-units divide by 1,000,000. Other units and invalid legacy quantities are excluded with a notice rather than treated as KG. Available stock shows current sellable weight per item; blocked and inactive items contribute zero. Staff can see all stock, while Users' order and selling quantities remain scoped to their own orders and the stock card shows N/A.

Targets are assigned to an existing User for one daily, Monday–Sunday weekly, or calendar-month period. They are stored in integer paise. Achievement is the sum of `grandTotal` on that User's orders whose `confirmedAt` falls within the target period in Asia/Kolkata and whose current status is `confirmed`, `in_preparation`, `ready`, or `delivered`. Draft and cancelled orders are excluded. This is **confirmed order value**, not cash collected or invoiced value. A zero target displays `N/A` for its percentage. The target form stores one record per User, period type, and period start; editing it writes an audit record.

The dashboard uses `orderDate`; the Users & Targets monetary achievement uses `confirmedAt`. Invoice balance accounting remains unchanged in the financial modules.

## Access and audit

Admin and Account Admin manage User profiles, targets, and announcements through authenticated callable functions. The backend verifies the caller's current Firestore profile, validates inputs, and writes audit records atomically with each change. A User sees only their own target and its achievement. Staff see login and audit logs; Users cannot write either history collection except their own schema-restricted login/logout event. Login logging is best effort so an event-write failure cannot masquerade as an invalid profile. Passwords and tokens are never written to Firestore.

Announcement scheduling uses `startsOn` and `expiresOn` (inclusive, Asia/Kolkata dates), `active`, and audience `all`, `staff`, or `users`. The dashboard filters expired announcements. Global order pause and item selling block are separate settings and are unaffected by announcement edits.

## Queries and exports

The four report tables use Firestore `limit` and `startAfter` cursors. Date, status, period, audience, item/entity, and User filters are applied on the server where offered. Title search uses the normalized `titleKey` prefix, so it does not match arbitrary words within a title. Dashboard orders are fetched in pages of 100 with server date/ownership filters, because item and recipe weights live in nested snapshots and cannot be summed by Firestore aggregation queries. Inventory is also paged, with item and unit lookups for conversion. Recent activity is bounded. Target-management User selectors read at most 200 profiles; very large teams will need paged selectors.

An XLSX export walks **all pages of the authorized filtered query**, not just the visible table page. It converts timestamps to human-readable dates and prefixes spreadsheet formula characters in text values. SheetJS Community Edition loads on demand from its CDN, so exporting requires network access to that CDN. A large export can take time or reach Firestore read quotas; narrow the filters when practical. Existing operational exports use the same formula-safe writer.

`firestore.indexes.json` contains the composite indexes used by these queries. Regenerate it after changing query shapes with `node scripts/generate-report-indexes.mjs`. The index families cover target owner/type/status and period; announcement status/audience/date or title prefix; login UID/type/time; audit actor/type/entity/time; owned order dates and achievement; owned pending payments; and owned invoice aggregates. Single-field queries use Firestore's automatic indexes. Indexes must be published separately for a live Firebase project; local files alone do not update production. The emulator supports testing without publishing.

## Local verification

Dashboard query failures are recorded as safe diagnostic categories in the browser Console. Successful sections remain visible; failed values show Unavailable without a page-level technical warning or index link. The index manifest in this workspace is not automatically applied to your live project. Emulator tests do not enforce production composite index availability. No indexes are published automatically.

```powershell
npm.cmd run test:unit
npm.cmd run test:rules
npm.cmd run test:reporting
npm.cmd run test:callables
```

Use the local Emulator UI at `http://127.0.0.1:4000` to create test Auth users and matching profiles before exercising the browser screens. Never use production credentials with the emulators. Do not deploy as part of these checks.
