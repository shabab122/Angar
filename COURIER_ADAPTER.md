# Courier adapter contract — v2.7

Angar Kitchen provides a configurable HTTPS JSON adapter, not a claim of native Pathao/Steadfast/other-provider compatibility. Implement this contract in your provider adapter, or point it at an existing compatible service. Map authentication, pickup address, parcel rules, fees, cancellation policy and statuses to your contracted courier. Manual dispatch and staff GPS work without external credentials.

## Configuration

Server-only `.env` fields:

```dotenv
COURIER_NAME=Your courier
COURIER_API_URL=https://your-adapter.example/api
COURIER_API_TOKEN=your-private-adapter-token
COURIER_WEBHOOK_SECRET=your-independent-random-secret-at-least-32-characters
```

Use a public HTTPS `APP_ORIGIN` for real callbacks. Tokens and secrets never go to the browser. The configured base URL must be HTTPS, without credentials, query or fragment. Numeric/local host URLs and redirects are rejected. Restrict outbound network access to the operator-approved adapter host. Verify its TLS certificate normally.

The app uses `Authorization: Bearer <token>`, JSON, `Accept: application/json` and `Idempotency-Key: <reference>`. Responses are limited to 32 KiB; each request has a 10-second timeout. A timeout after booking/cancellation is an **uncertain outcome**, not proof of failure. Do not create a second parcel because an HTTP response was lost.

## Booking

`POST <base>/bookings`

```json
{
  "reference": "AK-unique-stable-reference",
  "branchId": "main",
  "orderCode": "DL-order-code",
  "pickup": {
    "name": "Angar Kitchen",
    "address": "Branch address",
    "phone": "..."
  },
  "recipient": {
    "name": "Customer",
    "phone": "...",
    "address": { "line": "...", "area": "...", "note": "..." }
  },
  "package": { "description": "Prepared restaurant food", "itemCount": 2 },
  "collectionMinor": 47000,
  "currency": "BDT",
  "webhookUrl": "https://restaurant.example/api/courier/webhook?branch=uttara"
}
```

Money uses integer paisa: `47000` means ৳470. `collectionMinor` is the verified outstanding bill balance at booking time. Pending online holds block booking. A later payment or refund does **not** automatically change the courier's COD instruction: reconcile collection with the courier before handover, and record only money actually received through the existing counter/payment workflow. Courier fees are displayed separately; record an actual operating expense through the existing expense workflow when appropriate.

The adapter **must persist and enforce the unique reference before creating a provider parcel**. The same reference/idempotency key must return the same booking, including across retries and concurrent requests. Translate the public callback URL to the courier's supported webhook mechanism if its native contract differs.

All successful booking/status/cancellation replies use this strict shape:

```json
{
  "id": "provider-booking-id",
  "reference": "AK-unique-stable-reference",
  "status": "booked",
  "trackingUrl": "https://courier.example/track/booking",
  "feeMinor": 6000,
  "proof": "",
  "location": {
    "lat": 23.75,
    "lng": 90.37,
    "accuracy": 12,
    "capturedAt": "2026-11-23T12:00:00.000Z"
  }
}
```

`id`, `feeMinor` and `location` are optional. `trackingUrl` and `proof` may be omitted or empty. Do not add other response fields. Supported statuses: `booked`, `in_transit`, `delivered`, `cancelled`, `not_found`. Positions use decimal degrees, accuracy in metres and a fresh ISO UTC timestamp. Store only the latest location. Reported delivery is saved for staff review; it never records payment or automatically completes the restaurant order.

## Reconciliation and cancellation

- `GET <base>/bookings/<reference>` returns the original parcel. Return `not_found` **only when the adapter/provider has conclusively established that this reference was never booked**. A provider outage is an error, not `not_found`. The app will not accept `not_found` as a reason to erase a previously confirmed provider ID.
- `DELETE <base>/bookings/<reference>` idempotently cancels the original parcel. Return `cancelled` only after provider confirmation. An unknown result remains `cancel_unknown`; staff must reconcile it before assigning another driver or cancelling the meal.
- After a confirmed cancellation, this version uses a staff driver or operator-reviewed resolution for a new courier parcel; it does not silently reuse a cancelled reference as a new parcel.

The app never automatically retries an uncertain booking/cancellation write. Staff can reconcile the original reference. A repeated booking request returns the stored result while its outcome is pending. Retrying after a conclusive `not_found` uses the same stable reference; adapter-side idempotency remains mandatory.

## Signed webhooks

`POST <webhookUrl>` with `Content-Type: application/json`:

```json
{
  "eventId": "provider-event-123",
  "booking": {
    "id": "provider-booking-id",
    "reference": "AK-unique-stable-reference",
    "status": "delivered",
    "trackingUrl": "",
    "proof": "Recipient handover reported"
  }
}
```

Headers:

- `X-Courier-Timestamp`: Unix time in **seconds**, ten decimal digits; accepted within five minutes.
- `X-Courier-Signature`: hex HMAC-SHA256 of `timestamp + "." + raw UTF-8 request bytes`, using `COURIER_WEBHOOK_SECRET`.

The exact raw body bytes must be signed. Verification uses a constant-time comparison. Retries use the same event ID and body and a newly signed current timestamp. Reusing an event ID with different body bytes is rejected. Events are deduplicated per branch for seven days; state transitions remain idempotent after that window. Unknown references are rejected. Keep the callback's `branch` query parameter unchanged. The app accepts signed callbacks without a browser Origin header.

## Staff driver GPS and handover

The **Assign & dispatch staff driver** action creates a private six-hour link. Its random token is hashed in storage, passed in a URL fragment, removed from the address bar after the driver page commits, and sent only in an Authorization header. Share it privately. Reassignment, cancellation, completion or expiry revokes it. The recipient code is not included in driver responses.

Drivers explicitly press **Start GPS sharing** and grant browser permission. Keep the page open: background tracking is not guaranteed. HTTPS/localhost is required. Coordinates are a device report, not proof of attendance. The app validates range, age and accuracy, limits update frequency, shows signal age and removes current tracking on completion/revocation. Latest locations older than 24 hours are cleared by the worker. Only authorized staff and the ordering guest/customer see tracking; the map link opens an external map only when clicked.

The ordering customer sees a six-digit handover code while the order is dispatched. Five wrong attempts lock code confirmation until staff review/reassignment. Correct code confirmation also requires the restaurant bill to be fully paid. Authorized staff can confirm independently with a recorded handover reason. GPS, provider delivery and recipient codes never credit money or bypass the existing verified-payment rules.

## Acceptance with your real provider

Test one controlled booking, duplicate request, lost response and original-reference lookup; confirm a cancellation with the provider before reassigning; verify signed webhook replay and bad-signature rejection. Check recipient address mapping, actual fee, COD changes, customer privacy and final paid handover. Automated project tests use a controlled adapter and simulated browser GPS; they do not place a paid real-world courier booking.
