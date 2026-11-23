# Changelog

## 2.8.0

Base: `Angar_Kitchen_React_v2.7.zip`. Existing design/assets, stack, guest workflows and dependencies are retained.

- Added installation-authorized branch comparison with settled sales, operating result, cash flows, drawer/stock snapshots, missing-cost and unavailable-scope labels, in-transit value and CSV export.
- Added transactional inter-branch transfer requests, source approvals, physical dispatch and idempotent partial receipt with exact weighted cost, FEFO batch provenance/expiry, expired-goods quarantine and reviewed restore journals.
- Added an optional native eCourier merchant adapter, bounded package/city lookup, integer-taka collection validation, original-reference reconciliation/polling and confirmed cancellation. Generic adapter, manual dispatch and staff-driver GPS are retained. Provider delivery never credits a bill.
- Added sanitized technical incidents, API counters, worker/job health, acknowledgement, deduplicated opt-in email and a separate persistent watchdog for downtime/recovery. Uncertain SMTP sends are reviewed before retry.
- Added branch-specific staff role/action/approval-limit profiles, default inheritance, fresh transactional amount checks, effective-role MFA policy and global session revocation. Installation authority stays with the shared base identity.
- Added v2.8 regression coverage and Bengali upgrade, native-courier and monitoring guides; restored transfers are frozen for reconciliation and restored technical email policy is disabled.

## 2.7.0

Base: `Angar_Kitchen_React_v2.6.zip`. Existing design/assets, technology stack, table QR ordering, payment/refund rules, staff MFA, purchasing, inventory, reports, printing and backups are retained.

- Added versioned event configuration, active/archive spaces and packages, capacities, shared room resources, suggested pricing and deposit settings. Held bookings protect their resources and capacity; issued quotes retain agreed totals.
- Added authenticated per-branch SSE invalidations from MongoDB change streams, heartbeat/access rechecks, reconnect resync and polling fallback. Streams contain topic labels, not order documents or customer details.
- Added configurable courier booking/status/cancellation, stable provider references, unknown-result preservation, timestamped HMAC webhooks and duplicate-event protection. Provider delivery reports require reviewed handover and never credit a bill.
- Added private expiring staff-driver links, permission-based GPS, fresh position validation, customer-only delivery codes, bounded confirmation attempts and paid-bill delivery confirmation. Existing manual dispatch remains available.
- Added role-bounded action restrictions and transactional refund/purchase/expense amount limits, branch assignments, permission-aware navigation and session revocation. Restricted administrators cannot manage broader accounts or delegate larger limits.
- Added isolated business databases per branch, shared staff authentication, branch-aware QR/payment/account/notification links, separate invoice series, branch workers and scoped backup/restore tooling. Legacy business data stays in `main`; new ordering starts paused.
- Added a PWA manifest/icons, versioned public shell/catalogue cache, explicit branch-specific offline cart drafts, online price/context review and opt-in app updates. Private APIs, addresses, credentials and financial writes are not cached or replayed.
- Added automated branch/access, event/live and courier tests. No new runtime dependencies.

## 2.6.0

Base: `Angar_Kitchen_React_v2.5.zip`. Existing restaurant design/assets, guest QR ordering, bills/refunds, accounts, staff MFA, reservations, pickup/delivery, notifications, batch inventory and encrypted/cloud backups are retained.

- Added physical stocktake snapshots, ingredient/lot counts, submission and administrator review, atomic reconciliation, stale-stock rejection and explicit recounts.
- Added original-receipt supplier return reservations, approval, confirmed physical handover, exact partial credit notes, revised payables and verified supplier refund receipts linked to the cash drawer.
- Added supported opening inventory valuation, exact weighted-average stock values, immutable recipe consumption costs and original-value pre-cooking returns. Missing legacy costs remain explicitly incomplete.
- Added salary/rent/other operating expense requests, administrator decisions, partial verified payments, cash reconciliation and a settlement-based VAT-exclusive operating-result report/CSV with its policy and cost coverage visible.
- Added automatic revisioned KOTs for table/pickup/delivery acceptance and approved changes/cancellations, superseded pending tickets, Unicode browser thermal previews, optional ASCII ESC/POS TCP sending, physical output confirmation and audited marked reprints. Uncertain transmissions are never automatically repeated.
- Added automatic usable-stock, expiry and supplier-overdue staff alerts, role-filtered views, personal acknowledgement, configurable expiry windows and opt-in daily staff email digests with reviewed uncertain-delivery retries.
- Extended recovery to retain new business ledgers while clearing print/email jobs and disabling their automatic external effects. Added Bengali v2.6 setup/upgrade instructions and regression, workflow, TCP and recovery coverage; bounded test-file concurrency for development machines.

## 2.5.0

Base: `Angar_Kitchen_React_v2.4.zip`. Existing restaurant design/assets, QR ordering, guest accounts, split/partial bills, refunds, reservations, notifications, pickup/delivery and the React–Express–MongoDB stack are retained.

- Added administrator audit search/filter/cursor pagination and formula-safe CSV using an explicit field allowlist over existing staff records.
- Added encrypted TOTP enrollment, password-plus-factor staff login, hashed single-use recovery codes, account-wide attempt limits, session revocation, optional administrator enrollment policy and audited manager/local-operator recovery.
- Added opt-in S3-compatible encrypted-backup synchronization with conditional creation, downloaded-byte SHA-256 verification, destination-bound retries, unsynced-source retention and remote listing/authenticated fetch CLI. Existing cloud objects are never overwritten; no remote deletion occurs.
- Added a shared cash drawer with opening float, transactional cash receipts/refunds/event deposits/supplier expenses, manual movements, stale-count protection, immutable closing counts/variance, administrator review and statements/CSV. Receipts without an open shift remain separately recorded.
- Added optional ingredient batch tracking with balanced opening lots, expiry/quarantine alerts, earliest-expiry reservations, preparation rechecks, original-lot cancellation returns and quarantined legacy returns. Existing aggregate inventory remains compatible.
- Added supplier contacts/archive, purchase drafts/confirmation/cancellation, partial counted lot-aware deliveries, exact cumulative pricing, received-goods payables and idempotent verified supplier payments connected to cash reconciliation.
- Added staff screens, responsive styles, regression/integration coverage and the Bengali v2.5 upgrade/recovery guide. Cloud tests use a controlled S3 transport; deployment-specific provider acceptance needs the operator's bucket/credentials.

## 2.4.0

Base: `Angar_Kitchen_React_v2.3.zip`. Existing dining-table ordering, split/partial payments, staff roles, accounts, inventory, invoices, reviews, reservations, event quotes, original assets and technology stack are retained.

- Added scheduled/manual AES-256-GCM encrypted database and referenced-photo backups, retention, private administrator downloads, automatic isolated restore verification and a CLI that restores only to a fresh database/media directory. Restore copies clear transient sessions, tokens and messaging jobs and disable the backup schedule.
- Added approved full/partial event-deposit returns and verified excess-online-payment refunds through the original merchant, source-specific balances and credit notes. These returns do not reduce food sales or adjust food loyalty.
- Added private in-app alerts, verified-email order/reservation messages, consent plus OTP-verified SMS (Twilio or private development outbox), permission-based encrypted Web Push, reservation reminders, waiting-list calls and reviewed delivery retries. Stale/opted-out deliveries are suppressed; uncertain sends are not automatically repeated.
- Added optional pickup/delivery settings, hours, advance requests, named delivery areas, fees/minimum spend/estimates, server quotes, contact/address capture and private tracking. Staff acceptance reserves ingredients and creates the invoice; preparation consumes stock; pickup/dispatch/delivery actions have role/state checks. Full payment gates collection/final delivery; COD can dispatch before payment is verified.
- Connected new off-premise invoices to existing receipts, coupons/points, payment verification, refunds and sales reporting; fees/VAT are snapshotted and credited to the paisa. Existing table split and partial-payment policies remain available.
- Added regression/integration tests and the Bengali v2.4 upgrade/recovery guide. Live SMTP, Twilio, browser push delivery and merchant sandbox/live money movement require operator credentials and acceptance testing.

## 2.3.0

- Add SMTP-backed email verification and password recovery with hashed, expiring single-use tokens; add a private local-test outbox and explicit delivery status.
- Add approved full/partial settled-bill refunds, original-payment limits, SSLCOMMERZ refund initiation/reconciliation, immutable credit notes and refund-aware loyalty/coupon adjustments.
- Add individual staff management, administrator reauthentication, temporary-password enforcement, personal password changes, access revocation and last-admin protection.
- Add ingredient stock receipts/waste/corrections, low-stock alerts, per-dish/size/add-on recipes and transactional kitchen acceptance/edit/cancellation stock movements.
- Add inclusive/exclusive tax configuration, invoice identity and numbering, immutable invoice snapshots and balanced tax/refund reporting.
- Retain v2.2 design/assets, guest QR ordering, existing staff workflows, payments, customer accounts, reservations, reviews/events and database compatibility.
- Add integration tests, browser acceptance coverage and Bengali setup/upgrade instructions.

## 2.2.0

- Add integer-paisa bill allocations by equal share, ordering customer/device, custom amount and whole-item quantity.
- Add idempotent partial counter receipts, shared payment history, exact remaining balances and table closing only after full settlement.
- Add SSLCOMMERZ hosted checkout, authenticated server verification, IPN callbacks, amount holds, reconciliation and manager risk review.
- Add optional customer accounts, secure sessions, profile/password updates, cross-device history and current-menu reorder previews.
- Add admin coupon management with dates/spend/usage limits and a transactional loyalty earn/redemption ledger.
- Add time/capacity-aware table reservations, cancellation/no-show, seating, waiting-list management and reservation settings.
- Coordinate new reservations with existing private-event holds; retain the existing guest ordering, reviews, brand and stack.
- Extend receipts and settled-sales breakdowns for discounts and mixed payment methods; retain legacy bill compatibility.
- Add commerce/gateway/reservation integration tests and Bengali upgrade/acceptance instructions.

## 2.1.0

- Add table-wide service request tracking, staff acknowledgement, completion, sidebar counts and optional floor alert sounds.
- Add quick availability controls for admin/kitchen, automatic guest menu refresh and transactional checkout availability checks.
- Add paid-bill sales reports by Dhaka date/day/month, popular dishes, payment breakdown and protected CSV downloads.
- Add total/stage order timers and delayed markers; show visual station updates independently of optional audio.
- Add guest quantity/note and cancellation requests with administrator decisions, reasons, immutable audit snapshots and retry protection.
- Restrict cancellation/editing to pre-cooking stages; pause dispatch/cooking while a guest request awaits review.
- Preserve React v2 branding, stack, existing billing/reviews/events and database compatibility.
- Add MongoDB integration coverage and Bengali upgrade/acceptance instructions.

## 2.0.0

- Existing React release used as the base for 2.1.0.
