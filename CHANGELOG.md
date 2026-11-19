# Changelog

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
