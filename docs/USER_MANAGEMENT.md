# Local trusted user management

Master Data > Users accepts full name, email, role and active status. No Auth UID is entered.
The existing saveUserProfileCall now invokes manageUser, using the Admin SDK in Functions.
Only active staff may call it; only Admin may grant/change staff roles. Account Admin may
create/edit ordinary Users. Self changes remain prohibited. User edits retain the existing
UID and require both Auth and Firestore records; missing profiles are not recreated by edits.
The older reporting helper remains internal for compatibility and is not the callable route.

## Availability

Live Add User stays disabled: there is no deployed trusted backend. This implementation does
not enable live provisioning. Use the full existing Emulator Suite and localhost without
`?firebase=live` to exercise the form. Firebase Cloud Functions deployment requires Blaze;
no deployment or billing changes are performed. Firestore Rules remain unchanged: client
user/profile writes and client provisioning metadata writes are denied.

## Provisioning and recovery

The form maintains one operationId per submission, including retries. Server-only
userOperations/{operationId} records bind actor, desired values and a server-assigned random
Auth UID. userOperationLocks/{UID} serialize updates. Completed retries return that UID;
reusing an operation ID with different data is rejected. Duplicate emails never automatically
attach existing accounts. Provisioning creates Auth disabled and stages Firestore inactive.
Updates immediately stage the profile inactive, disable Auth, revoke refresh tokens and
synchronize email/name. Final activation and completion audit commit after synchronization.
Email changes clear the former email verification state. Audit events record operation start
and completion, before/after values and actor; business history is retained during deactivation.

Auth and Firestore cannot share a transaction. On a caught failure, the operation is marked
failed, Auth disabling is attempted, and its profile stays inactive. Retry resumes the same UID.
Failed rollback/metadata writes or a crashed running operation require trusted administrative
reconciliation. There is intentionally no public unlock or account-attachment endpoint.
Do not manually unlock while an invocation is running; inspect both services and audit records
before resuming an abandoned operation. No Auth accounts are deleted as compensation.
Auth-disabled status is checked operationally; authoritative inactive Firestore profiles
deny OMS access even if Auth disabling temporarily fails. Existing sessions may remain signed
in, but profile access revocation is enforced by Rules and the existing profile listener.

No password is collected or stored. Active local accounts expose Send password setup, using
Firebase password-reset delivery without signing the Admin out. The Auth emulator exposes
test email actions locally; never paste reset links/codes into logs or Firestore. Email action
failure leaves the saved account intact and can be retried. Live setup delivery remains disabled.

## Tests

Install the existing test dependencies and Functions dependencies if missing:

```powershell
npm.cmd ci
npm.cmd ci --prefix functions
```

Use Java 21 (`JAVA_HOME` and PATH pointing at its installation), then run:

```powershell
npm.cmd run test:users
```

The runner uses an isolated demo-user-provisioning-tests project and ports Auth 9199,
Firestore 8180, Functions 5101, hub 4501 and logging 4601. Those ports must be free.
Existing emulators on 9099/8080/5001 are preserved. It creates and removes a temporary
emulator configuration; firebase.json and production configuration are unchanged.
Tests exercise actual Admin Auth, Firestore, browser Auth and the callable, duplicate
emails/submissions, partial failures, identity-preserving edits, deactivation/history,
role escalation/self changes, live Add User disabling and current Rules regression.

Legacy profiles without email must supply the matching account email when edited; the
deactivation path looks it up by existing UID. Accounts with no Auth counterpart need review.
No production migration is performed.
