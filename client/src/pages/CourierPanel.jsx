import { useState } from "react";
import { api, requestKey, dhakaTime, money } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
import { useApp } from "../lib/AppContext";
export function Position({ location, at }) {
  if (!location)
    return <p className="commerce-note">No current GPS signal shared.</p>;
  const age = at
    ? Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000))
    : null;
  return (
    <div className="gps-position">
      <strong>
        GPS · {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
      </strong>
      <span>
        Accuracy ±{Math.round(location.accuracy)} m ·{" "}
        {age === null
          ? "Time unavailable"
          : age < 120
            ? "Received " + age + " seconds ago"
            : "Signal is stale · " + Math.floor(age / 60) + " minutes ago"}
      </span>
      <a
        href={
          "https://www.openstreetmap.org/?mlat=" +
          location.lat +
          "&mlon=" +
          location.lng +
          "#map=17/" +
          location.lat +
          "/" +
          location.lng
        }
        target="_blank"
        rel="noreferrer"
      >
        Open this position on map
      </a>
    </div>
  );
}
export function DeliveryTracking({ order }) {
  const resource = useResource(
      "/fulfillment/orders/" + order.id + "/tracking",
      { enabled: order.kind === "delivery", interval: 5000 },
    ),
    tracking = resource.data?.tracking;
  if (!tracking) return null;
  return (
    <section className="delivery-tracking">
      <h4>Delivery tracking</h4>
      <p>
        {tracking.driverName || "Courier"} · {tracking.status}
      </p>
      {order.status === "dispatched" && (
        <>
          <Position location={tracking.location} at={tracking.locationAt} />
          {tracking.deliveryCode && (
            <p className="delivery-code">
              Your handover code: <strong>{tracking.deliveryCode}</strong>
              <small>
                Share with the delivery staff when you receive the food. Payment
                must be verified separately.
              </small>
            </p>
          )}
        </>
      )}
      {tracking.trackingUrl && (
        <a href={tracking.trackingUrl} target="_blank" rel="noreferrer">
          Courier tracking page
        </a>
      )}
      {tracking.deliveryPendingReview && (
        <p>
          Courier reported delivery. The restaurant is reviewing the handover.
        </p>
      )}
      {tracking.confirmedAt && (
        <p>Delivery confirmed · {dhakaTime(tracking.confirmedAt)}</p>
      )}
      {resource.error && <ErrorMessage>{resource.error.message}</ErrorMessage>}
    </section>
  );
}
export default function CourierPanel({ user }) {
  const resource = useResource("/staff/courier", { interval: 5000 }),
    orders = useResource("/staff/fulfillment/orders", { interval: 5000 }),
    [action, setAction] = useState(null),
    [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [link, setLink] = useState(""),
    [native, setNative] = useState({
      city: "",
      thana: "",
      area: "",
      zip: "",
      address: "",
      packageCode: "",
      foodServiceConfirmed: false,
    }),
    { notify } = useApp();
  const [password, setPassword] = useState(""),
    [providerConfirmed, setProviderConfirmed] = useState(false);
  const nativeMode = resource.data?.providerType === "ecourier",
    catalog = useResource("/staff/courier/options", {
      enabled: nativeMode && action?.type === "book",
    });
  const rows =
      orders.data?.orders.filter((row) => row.kind === "delivery") || [],
    jobs = resource.data?.jobs || [];
  function open(type, order) {
    setAction({
      type,
      order,
      job: jobs.find((row) => row.orderId === order.id),
    });
    setName(order.courier?.name || "");
    setPhone(order.courier?.phone || "");
    setReason("");
    setError("");
    setLink("");
    setPassword("");
    setProviderConfirmed(false);
    setNative({
      city: "",
      thana: "",
      area: order.address?.area || "",
      zip: "",
      address: order.address?.line || "",
      packageCode: "",
      foodServiceConfirmed: false,
    });
  }
  async function run(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { type, order } = action;
      const data =
        type === "driver"
          ? { expectedRevision: order.revision, name, phone, reason }
          : type === "book"
            ? {
                expectedRevision: order.revision,
                requestKey: requestKey(),
                ...(nativeMode ? { native } : {}),
              }
            : type === "review-cancellation"
              ? {
                  currentPassword: password,
                  reason,
                  confirmedWithProvider: providerConfirmed,
                  expectedUpdatedAt: action.job?.updatedAt,
                }
              : type === "reconcile"
                ? {}
                : { reason };
      const result = await api("/staff/courier/" + order.id + "/" + type, {
        method: "POST",
        data,
      });
      if (result.driverLink) {
        setLink(result.driverLink);
        setAction(null);
      } else {
        setAction(null);
        notify(result.message || "Courier record updated.");
      }
      await Promise.all([orders.reload(), resource.reload()]);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading || orders.loading) return <Loading />;
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Couriers & delivery GPS</h2>
          <p>
            Book an external courier or assign your own delivery staff. The
            existing pickup and manual dispatch actions remain in Pickup &
            delivery.
          </p>
        </div>
        <Button
          secondary
          onClick={() => {
            void resource.reload();
            void orders.reload();
          }}
        >
          Refresh deliveries
        </Button>
      </div>
      {!resource.data?.configured && (
        <p className="commerce-note">
          External courier booking needs{" "}
          {nativeMode
            ? "your eCourier merchant credentials"
            : "your configured HTTPS adapter and credentials"}
          . Staff driver links and manual dispatch are available.
        </p>
      )}
      {nativeMode && (
        <p className="commerce-note">
          eCourier native API · {resource.data.mode} mode · Provider status is
          polled every minute. Confirm a prepared-food service and its delivery
          timing with your merchant account before booking. Rider GPS is
          available through your own staff links.
        </p>
      )}
      {(resource.error || orders.error) && (
        <ErrorMessage>
          {resource.error?.message || orders.error?.message}
        </ErrorMessage>
      )}
      {link && (
        <article className="commerce-card private-driver-link">
          <h3>Private delivery link</h3>
          <p>
            Share this link privately with the assigned staff member. It expires
            in six hours. Reassignment revokes the previous link.
          </p>
          <label>
            Driver link
            <input aria-label="Private driver link" readOnly value={link} />
          </label>
          <Button
            secondary
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                notify("Private driver link copied.");
              } catch {
                notify("Select and copy the private link.");
              }
            }}
          >
            Copy private link
          </Button>
          <Button secondary onClick={() => setLink("")}>
            Hide link
          </Button>
        </article>
      )}
      {!rows.length && <p>No delivery orders for this branch yet.</p>}
      <div className="commerce-staff-grid">
        {rows.map((order) => {
          const job = jobs.find((row) => row.orderId === order.id),
            complete = ["cancelled", "delivered"].includes(order.status);
          return (
            <article className="commerce-card" key={order.id}>
              <div className="v27-inline">
                <h3>{order.code}</h3>
                <span className="soft-badge">{order.status}</span>
              </div>
              <p>
                {order.name} · {order.phone}
              </p>
              <p>
                {order.address?.line}, {order.address?.area}
              </p>
              {job && (
                <>
                  <p>
                    Courier:{" "}
                    {job.driverName ||
                      (job.providerType === "ecourier"
                        ? "eCourier"
                        : resource.data.providerName)}{" "}
                    · <strong>{job.status}</strong>
                  </p>
                  {job.feeMinor !== null && (
                    <p>
                      Provider fee: {money(job.feeMinor / 100)} · Record any
                      actual expense in Expenses.
                    </p>
                  )}
                  {job.source === "external" && (
                    <p className="commerce-note">Reference: {job.reference}</p>
                  )}
                  {job.providerType === "ecourier" &&
                    ["unknown", "cancel_unknown"].includes(job.status) &&
                    user.role === "admin" && (
                      <Button
                        secondary
                        onClick={() => open("review-cancellation", order)}
                      >
                        Record provider cancellation confirmation
                      </Button>
                    )}
                  <Position location={job.location} at={job.locationAt} />
                  {job.deliveryPendingReview && (
                    <p className="courier-review">
                      Courier reports delivery. Confirm the handover after
                      payment verification.
                    </p>
                  )}
                  {job.pollNeedsReview && (
                    <p className="courier-review">
                      Provider tracking needs review. Reconcile the original
                      booking; its previous status was preserved.
                    </p>
                  )}
                  {job.confirmedAt && (
                    <p>Confirmed: {dhakaTime(job.confirmedAt)}</p>
                  )}
                </>
              )}
              <div className="commerce-inline-actions">
                {!complete &&
                  ["ready", "dispatched"].includes(order.status) && (
                    <Button
                      secondary
                      className="button-small"
                      onClick={() => open("driver", order)}
                    >
                      Assign & dispatch staff driver
                    </Button>
                  )}
                {!complete &&
                  ["accepted", "preparing", "ready"].includes(order.status) && (
                    <Button
                      secondary
                      className="button-small"
                      disabled={!resource.data?.configured}
                      onClick={() => open("book", order)}
                    >
                      Book external courier
                    </Button>
                  )}
                {job?.source === "external" && !complete && (
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => open("reconcile", order)}
                  >
                    Reconcile courier status
                  </Button>
                )}
                {job && !["cancelled", "confirmed"].includes(job.status) && (
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => open("cancel", order)}
                  >
                    Cancel courier assignment
                  </Button>
                )}
                {order.status === "dispatched" &&
                  user.capabilities?.["courier.confirm"] !== false && (
                    <Button
                      className="button-small"
                      onClick={() => open("confirm-delivery", order)}
                    >
                      Confirm verified delivery
                    </Button>
                  )}
              </div>
            </article>
          );
        })}
      </div>
      {action && (
        <Modal
          open
          title={
            {
              driver: "Assign & dispatch delivery staff",
              book: "Book external courier",
              reconcile: "Reconcile courier booking",
              cancel: "Cancel courier assignment",
              "confirm-delivery": "Confirm delivery handover",
              "review-cancellation":
                "Record provider cancellation confirmation",
            }[action.type]
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={run}>
            <p>{action.order.code}</p>
            {action.type === "driver" && (
              <>
                <label>
                  Delivery staff name
                  <input
                    aria-label="Delivery staff name"
                    required
                    minLength={2}
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  Delivery staff phone
                  <input
                    aria-label="Delivery staff phone"
                    maxLength={25}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                <p>
                  This dispatches a ready delivery and creates a private GPS
                  link. The customer sees a handover code; delivery confirmation
                  also requires a paid bill.
                </p>
              </>
            )}
            {action.type === "book" && (
              <p>
                Send this recipient’s name, phone and address to{" "}
                {resource.data?.providerName}. The provider may charge its
                delivery fee. Its original reference is reused when a booking
                result needs reconciliation.
              </p>
            )}
            {action.type === "book" && nativeMode && (
              <fieldset>
                <legend>eCourier shipment details</legend>
                {catalog.error && (
                  <p className="commerce-note">
                    Provider catalogue unavailable. Use the exact package code
                    and location names verified with eCourier.
                  </p>
                )}
                <datalist id="ecourier-cities">
                  {catalog.data?.cities.map((city) => (
                    <option key={city.value} value={city.value}>
                      {city.name}
                    </option>
                  ))}
                </datalist>
                <datalist id="ecourier-packages">
                  {catalog.data?.packages.map((item) => (
                    <option key={item.package_code} value={item.package_code}>
                      {item.package_name} · {item.delivery_time} ·{" "}
                      {item.coverage}
                    </option>
                  ))}
                </datalist>
                {[
                  ["city", "Recipient city"],
                  ["thana", "Recipient thana"],
                  ["area", "Recipient area"],
                  ["zip", "Recipient postcode"],
                  ["address", "Provider delivery address"],
                  ["packageCode", "eCourier package code"],
                ].map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      aria-label={label}
                      required
                      maxLength={
                        key === "packageCode" ? 60 : key === "zip" ? 4 : 40
                      }
                      pattern={key === "zip" ? "[0-9]{4}" : undefined}
                      list={
                        key === "city"
                          ? "ecourier-cities"
                          : key === "packageCode"
                            ? "ecourier-packages"
                            : undefined
                      }
                      value={native[key]}
                      onChange={(event) =>
                        setNative({ ...native, [key]: event.target.value })
                      }
                    />
                  </label>
                ))}
                <p className="commerce-note">
                  The provider address must fit its 40-character field. The
                  original customer address stays on the order. Confirm the full
                  delivery location with the recipient.
                </p>
                <label className="check-line">
                  <input
                    required
                    type="checkbox"
                    checked={native.foodServiceConfirmed}
                    onChange={(event) =>
                      setNative({
                        ...native,
                        foodServiceConfirmed: event.target.checked,
                      })
                    }
                  />
                  The provider confirmed this package accepts prepared food and
                  meets the required delivery time.
                </label>
              </fieldset>
            )}
            {action.type === "reconcile" && (
              <p>
                Check the original courier reference. This does not create
                another booking or record a payment.
              </p>
            )}
            {action.type === "review-cancellation" && (
              <>
                <p>
                  Use this only after eCourier merchant support confirms the
                  original reference has no active shipment and no rider
                  assigned. Save their confirmation or support-ticket reference
                  below. This releases the assignment for your own staff driver;
                  it does not send another booking or refund a payment.
                </p>
                <label className="check-line">
                  <input
                    required
                    type="checkbox"
                    checked={providerConfirmed}
                    onChange={(event) =>
                      setProviderConfirmed(event.target.checked)
                    }
                  />
                  I confirmed with the provider that no active shipment or rider
                  remains.
                </label>
                <label>
                  Administrator password
                  <input
                    aria-label="Courier review administrator password"
                    required
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              </>
            )}
            {!["book", "reconcile"].includes(action.type) && (
              <label>
                {action.type === "confirm-delivery"
                  ? "Handover evidence / reason"
                  : "Reason"}
                <input
                  aria-label="Courier action reason"
                  required
                  minLength={3}
                  maxLength={160}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            {action.type === "confirm-delivery" && (
              <p>
                Verify the recipient’s handover and record the full bill payment
                before confirming. The action is saved in staff activity.
              </p>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy ? "Processing…" : "Confirm courier action"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
