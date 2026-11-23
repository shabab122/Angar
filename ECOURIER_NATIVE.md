# Native eCourier integration (v2.8)

This adapter follows the provider's [Merchant API v5.5 documentation](https://ecourier.com.bd/wp-content/uploads/eCourier_Merchant_API_Document_General_v5.5.pdf), consulted 23 November 2026. Confirm the current merchant contract in sandbox before enabling live service. Prepared-food acceptance and the required delivery time must be agreed with the provider; a parcel package name alone does not establish either.

## Configuration

Keep credentials on the server, in the private `.env`:

```dotenv
COURIER_PROVIDER=ecourier
ECOURIER_MODE=sandbox
ECOURIER_API_KEY=
ECOURIER_API_SECRET=
ECOURIER_USER_ID=
```

Set your merchant values, restart the application and open **Couriers & delivery GPS**. To retain the existing adapter, use `COURIER_PROVIDER=generic`; its contract remains in [COURIER_ADAPTER.md](COURIER_ADAPTER.md). Native eCourier uses its own credentials and does not require a generic adapter URL/token/webhook secret. Native and generic jobs remain bound to their original provider; changing the configured provider does not migrate bookings.

Sandbox base: `https://staging.ecourier.com.bd/api`; live base: `https://backoffice.ecourier.com.bd/api`. Requests use the documented `API-KEY`, `API-SECRET`, `USER-ID` and JSON headers. No custom URL can redirect merchant credentials elsewhere.

## Staff booking

1. Accept the delivery order and reconcile pending online payments.
2. Open **Book external courier**. Select/enter the exact merchant package code and recipient city, thana, area, postcode and provider address. Assigned packages and city names are loaded through `/packages` and `/city-list`. Location names can be entered manually from provider-confirmed records when catalogue lookup is unavailable.
3. Confirm that the provider accepts prepared food and the selected service meets the required time. Review the recipient and outstanding collection amount before confirming a booking; live bookings may incur provider charges.

The adapter posts `/order-place`. The immutable merchant `product_id` is a 20-character base-36 encoding of the order ObjectId, while the internal `AK-...` reference remains available for staff history. Recipient mobiles normalize a Bangladesh `+88`/`88` prefix to the required 11-digit local number. The provider address is at most 40 characters; original customer address is retained, with no silent truncation. Pickup address comes from branch restaurant settings, at most 255 characters.

`product_price` maps to the outstanding bill balance in whole taka. Fractional-paisa collection balances are rejected before a booking is claimed; the app never rounds money. Positive collection uses `COD`; a fully prepaid balance uses `POS` with zero collection, subject to merchant sandbox acceptance. Provider charges are displayed separately and never silently added to a guest bill or recorded as an expense/payment.

## Tracking, cancellation and uncertain results

- A successful documented response must include a confirmed eCourier ID. A timeout/error/invalid response leaves the job **unknown**. Repeating the app's book action returns its existing job and does not post another booking.
- Reconciliation uses `/track`, by the known eCourier ID or the original product ID. It requires one exact matching record. Empty or ambiguous results never release the booking for automatic rebooking. Keep the uncertain state and resolve it with provider merchant support.
- Active native bookings are polled every minute, bounded to five jobs per worker tick. Polls only read tracking state; they never book, cancel, pay or refund automatically. Unknown status labels preserve the last known state for review.
- `/cancel-order` is used once per reviewed cancellation attempt. Only an explicit true success confirms cancellation. Uncertain cancellation blocks reassignment/food-order cancellation until reconciled. The provider permits cancellation only in its supported early shipment states; use merchant support once a parcel is no longer editable.
- Native calls are bound to their original mode and merchant USER-ID. Changing API keys for the same merchant is supported; changing merchant or sandbox/live mode requires restoring the original configuration to reconcile outstanding bookings.
- If merchant support confirms an uncertain booking/cancellation has **no active shipment or rider**, an administrator can use **Record provider cancellation confirmation**, save the support reference and re-enter their password. This audited, version-checked action closes the assignment without another provider call. It permits using your own staff driver; the cancelled reference cannot be automatically rebooked. A tracking timeout or empty lookup alone is not provider confirmation.
- No native webhook signature scheme or rider GPS contract was assumed. Existing generic signed webhooks cannot alter native jobs. Polling does not present a depot/hub position as rider GPS. Your own staff-driver GPS links remain available after any active external booking is confirmed cancelled.
- A provider's delivered status creates **handover review**, with no bill credit. Staff still verify full payment and actual delivery before confirming the restaurant order.

The automated suite exercises documented request/response shapes and failure cases with controlled transports. It does not certify a real merchant account, courier food suitability, live coverage or actual delivery performance.
