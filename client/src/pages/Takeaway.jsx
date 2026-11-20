import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BellRing, ShoppingBag, Truck } from "lucide-react";
import { useApp, categories } from "../lib/AppContext";
import {
  api,
  dhakaTime,
  readStorage,
  requestKey,
  saveStorage,
} from "../lib/api";
import { useResource } from "../lib/useResource";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Eyebrow,
  Loading,
  Modal,
  Quantity,
} from "../components/UI";
import { MenuCard } from "../components/MenuCard";
import {
  BillSummary,
  CounterBillDialog,
  OnlinePaymentForm,
  PaymentLedger,
} from "../components/Financial";
import { Receipt } from "./Receipt";

const stateNames = {
  placed: ["Awaiting acceptance", "অনুমোদনের অপেক্ষায়"],
  accepted: ["Accepted", "অনুমোদিত"],
  preparing: ["Preparing", "প্রস্তুত হচ্ছে"],
  ready: ["Ready", "প্রস্তুত"],
  dispatched: ["Out for delivery", "ডেলিভারির পথে"],
  delivered: ["Delivered", "পৌঁছেছে"],
  collected: ["Collected", "বুঝে নেওয়া হয়েছে"],
  cancelled: ["Cancelled", "বাতিল"],
};
const statusName = (status, t) =>
  t(...(stateNames[status] || [status, status]));
const fields = (lines) =>
  lines.map((line) => ({
    dishId: line.dishId,
    quantity: line.quantity,
    expectedPrice: line.unitPrice,
    ...(line.variantId ? { variantId: line.variantId } : {}),
    ...(line.addonIds?.length ? { addonIds: line.addonIds } : {}),
  }));

function FulfillmentItems({ order }) {
  const { name, money } = useApp();
  return (
    <ul className="fulfillment-items">
      {order.items.map((item, index) => (
        <li key={index}>
          <div>
            <strong>
              {item.quantity} × {name(item)}
            </strong>
            <small>
              {[
                item.variant?.name,
                ...(item.addons || []).map((addon) => addon.name),
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </div>
          <span>{money(item.subtotal)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Takeaway() {
  const app = useApp(),
    { t, money, name, language, menu, pricedLines, customer, notify } = app;
  const options = useResource("/fulfillment/options", { interval: 15000 }),
    orders = useResource("/fulfillment/orders", { interval: 4000 });
  const [category, setCategory] = useState("all"),
    [values, setValues] = useState({
      kind: "pickup",
      zoneId: "",
      name: "",
      phone: "",
      line: "",
      area: "",
      addressNote: "",
      time: "",
      couponCode: "",
      loyaltyPoints: "0",
    });
  const [quote, setQuote] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [cancel, setCancel] = useState(null),
    [reason, setReason] = useState("");
  const available =
    pricedLines.length > 0 && pricedLines.every((line) => line.valid);
  const settings = options.data,
    enabled =
      settings?.orderingEnabled &&
      (settings?.pickupEnabled || settings?.deliveryEnabled);
  useEffect(() => {
    if (customer)
      setValues((old) => ({
        ...old,
        name: old.name || customer.name,
        phone: old.phone || customer.phone,
      }));
  }, [customer?.id]);
  useEffect(() => {
    if (settings && !settings[values.kind + "Enabled"])
      setValues((old) => ({
        ...old,
        kind: settings.pickupEnabled ? "pickup" : "delivery",
      }));
  }, [settings?.pickupEnabled, settings?.deliveryEnabled]);
  const quotePayload = useMemo(
    () => ({
      kind: values.kind,
      zoneId: values.kind === "delivery" ? values.zoneId : "",
      scheduledAt: values.time ? values.time + ":00+06:00" : "asap",
      items: fields(pricedLines),
      couponCode: values.couponCode.trim().toUpperCase(),
      loyaltyPoints: Number(values.loyaltyPoints),
    }),
    [
      values.kind,
      values.zoneId,
      values.time,
      values.couponCode,
      values.loyaltyPoints,
      pricedLines,
    ],
  );
  const signature = JSON.stringify(quotePayload);
  useEffect(() => {
    setQuote(null);
  }, [signature, customer?.id]);
  const edit = (field) => (event) =>
    setValues((old) => ({ ...old, [field]: event.target.value }));
  async function review(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setQuote(
        (
          await api("/fulfillment/quote", {
            method: "POST",
            data: quotePayload,
          })
        ).quote,
      );
    } catch (failure) {
      setError(failure.message);
      await app.reloadMenu();
    } finally {
      setBusy(false);
    }
  }
  async function place() {
    setBusy(true);
    setError("");
    const payload = {
      ...quotePayload,
      name: values.name,
      phone: values.phone,
      ...(values.kind === "delivery"
        ? {
            address: {
              line: values.line,
              area: values.area,
              note: values.addressNote,
            },
          }
        : {}),
      note: app.note.trim(),
      quoteHash: quote.quoteHash,
    };
    const fingerprint = JSON.stringify(payload),
      old = readStorage("angar.fulfillment.checkout", null, true),
      key = old?.fingerprint === fingerprint ? old.key : requestKey();
    saveStorage("angar.fulfillment.checkout", { fingerprint, key }, true);
    try {
      await api("/fulfillment/orders", {
        method: "POST",
        data: { ...payload, requestKey: key },
      });
      app.clearCart();
      setQuote(null);
      saveStorage("angar.fulfillment.checkout", null, true);
      await orders.reload();
      notify(
        t(
          "Order received. Wait for staff acceptance before payment.",
          "অর্ডার জমা হয়েছে। পেমেন্টের আগে স্টাফের অনুমোদনের অপেক্ষা করুন।",
        ),
      );
      document
        .getElementById("fulfillment-tracking")
        ?.scrollIntoView({ behavior: "smooth" });
    } catch (failure) {
      setError(failure.message);
      if (
        ["QUOTE_CHANGED", "PRICE_CHANGED", "ITEM_UNAVAILABLE"].includes(
          failure.code,
        )
      ) {
        setQuote(null);
        await app.reloadMenu();
      }
    } finally {
      setBusy(false);
    }
  }
  async function cancelOrder(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/fulfillment/orders/" + cancel.id + "/cancel", {
        method: "POST",
        data: { reason },
      });
      setCancel(null);
      await orders.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="container fulfillment-page">
      <div className="page-heading">
        <Eyebrow>{t("ANGAR, WHEREVER YOU ARE", "আপনার পছন্দের আঙার")}</Eyebrow>
        <h1>
          {t("Takeaway &", "টেকঅ্যাওয়ে ও")}{" "}
          <em>{t("delivery.", "ডেলিভারি।")}</em>
        </h1>
        <p>
          {t(
            "Choose your meal, review the full price, then follow your order here.",
            "খাবার বাছুন, সম্পূর্ণ দাম দেখে অর্ডার দিন এবং এখানেই অগ্রগতি দেখুন।",
          )}
        </p>
      </div>
      <div className="commerce-inline-actions">
        <Button
          secondary
          to="#fulfillment-tracking"
          onClick={(event) => {
            event.preventDefault();
            document
              .getElementById("fulfillment-tracking")
              ?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          {t("Track my orders", "আমার অর্ডারের অবস্থা")}
        </Button>
        <Button secondary to="/notifications">
          <BellRing size={16} />
          {t("Order alerts", "অর্ডারের খবর")}
        </Button>
      </div>
      {options.loading ? (
        <Loading />
      ) : options.error ? (
        <ErrorMessage onRetry={options.reload}>
          {options.error.message}
        </ErrorMessage>
      ) : !enabled ? (
        <p className="commerce-note">
          {t(
            "Pickup and delivery ordering are currently closed. You can still check an existing order below.",
            "টেকঅ্যাওয়ে ও ডেলিভারি অর্ডার এখন বন্ধ। আগের অর্ডারের অবস্থা নিচে দেখতে পারেন।",
          )}
        </p>
      ) : (
        <>
          <p className="commerce-note">
            {t(
              "Ordering hours (Bangladesh time): ",
              "অর্ডারের সময় (বাংলাদেশ): ",
            )}
            {settings.open}–{settings.close} · {t("Allow at least ", "অন্তত ")}
            {settings.prepMinutes}
            {t(
              " minutes for preparation. Staff will confirm availability.",
              " মিনিট প্রস্তুতির সময় দিন। স্টাফ খাবারের প্রাপ্যতা নিশ্চিত করবেন।",
            )}
          </p>
          <div
            className="page-tabs"
            aria-label={t("Menu categories", "মেনুর বিভাগ")}
          >
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                aria-pressed={category === cat.id}
                onClick={() => setCategory(cat.id)}
              >
                {t(cat.en, cat.bn)}
              </button>
            ))}
          </div>
          {app.menuLoading ? (
            <Loading />
          ) : app.menuError ? (
            <ErrorMessage onRetry={app.reloadMenu}>
              {app.menuError}
            </ErrorMessage>
          ) : (
            <div className="menu-grid">
              {menu
                .filter(
                  (dish) => category === "all" || dish.category === category,
                )
                .map((dish, index) => (
                  <MenuCard key={dish._id} dish={dish} index={index} />
                ))}
            </div>
          )}
          <div className="fulfillment-checkout" id="fulfillment-checkout">
            <h2>{t("Review your order", "আপনার অর্ডার দেখুন")}</h2>
            {!pricedLines.length ? (
              <EmptyState
                icon={ShoppingBag}
                title={t(
                  "Choose a dish to begin.",
                  "শুরু করতে খাবার যোগ করুন।",
                )}
              />
            ) : (
              <>
                <ul className="fulfillment-items">
                  {pricedLines.map((line) => (
                    <li key={line.key}>
                      <div>
                        <strong>
                          {name(line.dish || { name: line.dishId })}
                          {!line.valid
                            ? " · " + t("Unavailable", "পাওয়া যাচ্ছে না")
                            : ""}
                        </strong>
                        <small>
                          {[
                            line.variant?.name,
                            ...(line.addons || []).map((addon) => addon.name),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </div>
                      <Quantity
                        value={line.quantity}
                        onChange={(quantity) =>
                          app.updateQuantity(line.key, quantity)
                        }
                      />
                      <span>{money(line.subtotal)}</span>
                    </li>
                  ))}
                </ul>
                <form className="commerce-form" onSubmit={review}>
                  <div className="commerce-two">
                    <label>
                      {t("Order type", "অর্ডারের ধরন")}
                      <select
                        aria-label={t("Order type", "অর্ডারের ধরন")}
                        value={values.kind}
                        onChange={edit("kind")}
                      >
                        {settings.pickupEnabled && (
                          <option value="pickup">
                            {t("Pickup", "টেকঅ্যাওয়ে")}
                          </option>
                        )}
                        {settings.deliveryEnabled && (
                          <option value="delivery">
                            {t("Delivery", "ডেলিভারি")}
                          </option>
                        )}
                      </select>
                    </label>
                    <label>
                      {t(
                        "Requested time (Bangladesh)",
                        "পছন্দের সময় (বাংলাদেশ)",
                      )}
                      <input
                        aria-label={t(
                          "Requested time (Bangladesh)",
                          "পছন্দের সময় (বাংলাদেশ)",
                        )}
                        type="datetime-local"
                        value={values.time}
                        onChange={edit("time")}
                      />
                      <small>
                        {t(
                          "Leave blank for the next available time.",
                          "দ্রুততম সময়ের জন্য খালি রাখুন।",
                        )}
                      </small>
                    </label>
                  </div>
                  <div className="commerce-two">
                    <label>
                      {t("Contact name", "যোগাযোগের নাম")}
                      <input
                        aria-label={t("Contact name", "যোগাযোগের নাম")}
                        required
                        minLength={2}
                        maxLength={80}
                        value={values.name}
                        onChange={edit("name")}
                      />
                    </label>
                    <label>
                      {t("Contact phone", "যোগাযোগের নম্বর")}
                      <input
                        aria-label={t("Contact phone", "যোগাযোগের নম্বর")}
                        type="tel"
                        required
                        maxLength={25}
                        value={values.phone}
                        onChange={edit("phone")}
                      />
                    </label>
                  </div>
                  {values.kind === "delivery" && (
                    <>
                      <label>
                        {t("Delivery area", "ডেলিভারি এলাকা")}
                        <select
                          aria-label={t("Delivery area", "ডেলিভারি এলাকা")}
                          required
                          value={values.zoneId}
                          onChange={edit("zoneId")}
                        >
                          <option value="">
                            {t("Choose an area", "এলাকা বাছুন")}
                          </option>
                          {settings.zones.map((zone) => (
                            <option key={zone.id} value={zone.id}>
                              {zone.name} · {money(zone.feeMinor / 100)} ·{" "}
                              {zone.estimatedMinutes}{" "}
                              {t("min estimate", "মিনিট আনুমানিক")}
                              {zone.minimumFoodMinor
                                ? " · " +
                                  t("minimum food ", "ন্যূনতম খাবার ") +
                                  money(zone.minimumFoodMinor / 100)
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="commerce-two">
                        <label>
                          {t("Delivery address", "ডেলিভারির ঠিকানা")}
                          <input
                            aria-label={t(
                              "Delivery address",
                              "ডেলিভারির ঠিকানা",
                            )}
                            required
                            minLength={5}
                            maxLength={180}
                            value={values.line}
                            onChange={edit("line")}
                          />
                        </label>
                        <label>
                          {t("Area / neighbourhood", "এলাকা / মহল্লা")}
                          <input
                            aria-label={t(
                              "Area / neighbourhood",
                              "এলাকা / মহল্লা",
                            )}
                            required
                            minLength={2}
                            maxLength={80}
                            value={values.area}
                            onChange={edit("area")}
                          />
                        </label>
                      </div>
                      <label>
                        {t(
                          "Delivery directions (optional)",
                          "পথনির্দেশ (ঐচ্ছিক)",
                        )}
                        <input
                          maxLength={160}
                          value={values.addressNote}
                          onChange={edit("addressNote")}
                        />
                      </label>
                    </>
                  )}
                  <label>
                    {t("Kitchen note (optional)", "কিচেনের নির্দেশনা (ঐচ্ছিক)")}
                    <textarea
                      maxLength={200}
                      rows={2}
                      value={app.note}
                      onChange={(event) => app.setNote(event.target.value)}
                    />
                  </label>
                  {customer ? (
                    <div className="commerce-two">
                      <label>
                        {t("Coupon code", "কুপন কোড")}
                        <input
                          maxLength={30}
                          value={values.couponCode}
                          onChange={edit("couponCode")}
                        />
                      </label>
                      <label>
                        {t("Loyalty points to redeem", "ব্যবহারের পয়েন্ট")}
                        <input
                          type="number"
                          min="0"
                          max={Math.max(0, customer.points)}
                          value={values.loyaltyPoints}
                          onChange={edit("loyaltyPoints")}
                        />
                        <small>
                          {customer.points}{" "}
                          {t(
                            "points available; up to 20% of food after coupon.",
                            "পয়েন্ট আছে; কুপনের পর খাবারের সর্বোচ্চ ২০%।",
                          )}
                        </small>
                      </label>
                    </div>
                  ) : (
                    <p className="commerce-note">
                      <Link to="/account">{t("Sign in", "লগইন করুন")}</Link>{" "}
                      {t(
                        "to use coupons or loyalty points, or continue as a guest.",
                        "কুপন বা পয়েন্ট ব্যবহার করতে; অতিথি হিসেবেও অর্ডার করা যায়।",
                      )}
                    </p>
                  )}
                  {error && <ErrorMessage>{error}</ErrorMessage>}
                  <Button type="submit" disabled={busy || !available}>
                    {busy
                      ? t("Checking…", "যাচাই হচ্ছে…")
                      : t("Review price & time", "দাম ও সময় দেখুন")}
                  </Button>
                </form>
                {quote && (
                  <div className="fulfillment-quote">
                    <h3>{t("Confirm your order", "অর্ডার নিশ্চিত করুন")}</h3>
                    <BillSummary
                      bill={{
                        subtotal: quote.subtotalMinor / 100,
                        discount: quote.discountMinor / 100,
                        charge: quote.chargeMinor / 100,
                        deliveryFee: quote.deliveryFeeMinor / 100,
                        tax: quote.taxMinor / 100,
                        taxLabel: quote.taxLabel,
                        taxRateBps: quote.taxRateBps,
                        taxIncluded: quote.taxIncluded,
                        total: quote.totalMinor / 100,
                        paidMinor: 0,
                        balanceMinor: quote.totalMinor,
                      }}
                    />
                    <p>
                      {t("Requested time: ", "পছন্দের সময়: ")}
                      {dhakaTime(quote.scheduledAt, false, language)}
                    </p>
                    <p className="commerce-note">
                      {t(
                        "Staff must accept this request before payment. Pickup and delivery bills are paid in full online or through staff. Delivery completion requires verified payment. Estimated times can change.",
                        "পেমেন্টের আগে স্টাফকে অর্ডার গ্রহণ করতে হবে। টেকঅ্যাওয়ে ও ডেলিভারির বিল সম্পূর্ণ পরিশোধ করতে হয়। ডেলিভারি সম্পন্ন করতে যাচাইকৃত পেমেন্ট প্রয়োজন। আনুমানিক সময় পরিবর্তন হতে পারে।",
                      )}
                    </p>
                    <Button onClick={place} disabled={busy}>
                      {t(
                        "Confirm order request",
                        "অর্ডারের অনুরোধ নিশ্চিত করুন",
                      )}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      <section id="fulfillment-tracking" className="fulfillment-tracking">
        <div className="commerce-panel-head">
          <div>
            <Eyebrow>{t("YOUR ORDERS", "আপনার অর্ডার")}</Eyebrow>
            <h2>
              {t("From our kitchen to you.", "আমাদের কিচেন থেকে আপনার কাছে।")}
            </h2>
          </div>
          <Button secondary onClick={orders.reload}>
            {t("Refresh", "আবার দেখুন")}
          </Button>
        </div>
        {orders.error && (
          <ErrorMessage onRetry={orders.reload}>
            {orders.error.message}
          </ErrorMessage>
        )}
        {orders.loading ? (
          <Loading />
        ) : !orders.data?.orders.length ? (
          <p className="commerce-note">
            {t(
              "Your pickup and delivery orders will appear here on this browser or your signed-in account.",
              "এই ব্রাউজার বা আপনার অ্যাকাউন্টের টেকঅ্যাওয়ে ও ডেলিভারি অর্ডার এখানে দেখা যাবে।",
            )}
          </p>
        ) : (
          <div className="fulfillment-cards">
            {orders.data.orders.map((order) => (
              <article className="fulfillment-card" key={order.id}>
                <header>
                  <div>
                    <small>
                      {order.kind === "pickup"
                        ? t("PICKUP", "টেকঅ্যাওয়ে")
                        : t("DELIVERY", "ডেলিভারি")}
                    </small>
                    <h3>{order.code}</h3>
                  </div>
                  <strong className="soft-badge">
                    {statusName(order.status, t)}
                  </strong>
                </header>
                <p>
                  {t("Requested: ", "পছন্দের সময়: ")}
                  {dhakaTime(order.scheduledAt, false, language)}
                </p>
                <FulfillmentItems order={order} />
                {order.address && (
                  <p>
                    {order.address.line}, {order.address.area} ·{" "}
                    {order.zoneName}
                  </p>
                )}
                {order.courier && (
                  <p>
                    {t("Delivery staff: ", "ডেলিভারি স্টাফ: ")}
                    {order.courier.name}
                    {order.courier.phone && " · " + order.courier.phone}
                  </p>
                )}
                <details>
                  <summary>{t("Order history", "অর্ডারের ইতিহাস")}</summary>
                  <ol className="fulfillment-history">
                    {order.history.map((step, index) => (
                      <li key={index}>
                        {statusName(step.status, t)} ·{" "}
                        {dhakaTime(step.at, false, language)}
                        {step.reason ? " · " + step.reason : ""}
                      </li>
                    ))}
                  </ol>
                </details>
                {order.bill ? (
                  <>
                    <BillSummary bill={order.bill} />
                    {order.bill.status === "paid" ? (
                      <>
                        <Button secondary to={"/receipt/" + order.bill.id}>
                          {t("View receipt", "রসিদ দেখুন")}
                        </Button>
                        <PaymentLedger bill={order.bill} />
                      </>
                    ) : order.bill.status === "void" ? (
                      <p className="commerce-note">
                        {t(
                          "Invoice voided. No payment is due.",
                          "বিল বাতিল হয়েছে। টাকা বাকি নেই।",
                        )}
                      </p>
                    ) : (
                      <OnlinePaymentForm bill={order.bill} />
                    )}
                  </>
                ) : (
                  <p>
                    {t("Quoted total: ", "অনুমিত মোট: ")}
                    {money(order.total)} ·{" "}
                    {t("Staff acceptance pending", "স্টাফের অনুমোদন বাকি")}
                  </p>
                )}
                {order.status === "placed" && (
                  <Button
                    secondary
                    onClick={() => {
                      setCancel(order);
                      setReason("");
                      setError("");
                    }}
                  >
                    {t("Cancel request", "অনুরোধ বাতিল")}
                  </Button>
                )}
                {!["placed", "cancelled", "collected", "delivered"].includes(
                  order.status,
                ) && (
                  <p className="commerce-note">
                    {t(
                      "For changes or cancellation after acceptance, contact the restaurant. A paid cancellation needs a separate confirmed refund.",
                      "গ্রহণের পরে পরিবর্তন বা বাতিল করতে রেস্টুরেন্টে যোগাযোগ করুন। পরিশোধিত অর্ডার বাতিল হলে আলাদা যাচাইকৃত ফেরত প্রয়োজন।",
                    )}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
      {cancel && (
        <Modal
          open
          title={t("Cancel order request", "অর্ডারের অনুরোধ বাতিল")}
          onClose={() => {
            if (!busy) setCancel(null);
          }}
        >
          <form className="commerce-form" onSubmit={cancelOrder}>
            <p>{cancel.code}</p>
            <label>
              {t("Reason", "কারণ")}
              <textarea
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {t("Confirm cancellation", "বাতিল নিশ্চিত করুন")}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}

function FulfillmentSettings({ onSaved }) {
  const resource = useResource("/staff/fulfillment/settings"),
    [values, setValues] = useState(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (resource.data) setValues(resource.data.settings);
  }, [resource.data]);
  const change = (name, value) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  function zoneChange(index, name, value) {
    change(
      "zones",
      values.zones.map((zone, position) =>
        position === index ? { ...zone, [name]: value } : zone,
      ),
    );
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/fulfillment/settings", {
        method: "POST",
        data: { ...values, expectedRevision: resource.data.revision, reason },
      });
      setReason("");
      await resource.reload();
      onSaved();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (!values)
    return resource.error ? (
      <ErrorMessage onRetry={resource.reload}>
        {resource.error.message}
      </ErrorMessage>
    ) : (
      <Loading />
    );
  return (
    <details className="fulfillment-settings">
      <summary>Ordering hours & delivery areas</summary>
      <form className="commerce-form" onSubmit={submit}>
        <p className="commerce-note">
          Enable each method when staff can fulfil it. Times use Bangladesh
          time. Fees are snapshots on each confirmed request; later settings
          affect new requests.
        </p>
        {[
          ["pickupEnabled", "Enable pickup orders"],
          ["deliveryEnabled", "Enable delivery orders"],
          [
            "applyServiceCharge",
            "Apply the restaurant service charge to these orders",
          ],
          ["taxableDeliveryFee", "Apply configured VAT to the delivery fee"],
        ].map(([key, label]) => (
          <label className="commerce-checkbox" key={key}>
            <input
              type="checkbox"
              checked={values[key]}
              onChange={(event) => change(key, event.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
        <div className="commerce-two">
          {[
            ["open", "Orders open", "time"],
            ["close", "Last requested time", "time"],
            ["prepMinutes", "Minimum preparation (minutes)", "number"],
            ["daysAhead", "Advance ordering (days)", "number"],
          ].map(([key, label, type]) => (
            <label key={key}>
              {label}
              <input
                aria-label={label}
                type={type}
                required
                value={values[key]}
                min={key === "prepMinutes" ? 10 : 1}
                max={key === "prepMinutes" ? 180 : 30}
                onChange={(event) =>
                  change(
                    key,
                    type === "number"
                      ? Number(event.target.value)
                      : event.target.value,
                  )
                }
              />
            </label>
          ))}
        </div>
        <h3>Delivery areas</h3>
        <p className="commerce-note">
          Accept addresses only within the listed area. Staff review each
          address before accepting. Estimates cover delivery travel time after
          preparation.
        </p>
        {values.zones.map((zone, index) => (
          <div className="fulfillment-zone" key={zone.id}>
            <label>
              Area name
              <input
                aria-label={"Area name " + (index + 1)}
                required
                minLength={2}
                maxLength={60}
                value={zone.name}
                onChange={(event) =>
                  zoneChange(index, "name", event.target.value)
                }
              />
            </label>
            <label>
              Fee (BDT)
              <input
                aria-label={"Area fee " + (index + 1)}
                type="number"
                min="0"
                max="1000"
                step="0.01"
                required
                value={zone.feeMinor / 100}
                onChange={(event) =>
                  zoneChange(
                    index,
                    "feeMinor",
                    Math.round(Number(event.target.value) * 100),
                  )
                }
              />
            </label>
            <label>
              Minimum food (BDT)
              <input
                aria-label={"Area minimum " + (index + 1)}
                type="number"
                min="0"
                max="100000"
                step="0.01"
                required
                value={zone.minimumFoodMinor / 100}
                onChange={(event) =>
                  zoneChange(
                    index,
                    "minimumFoodMinor",
                    Math.round(Number(event.target.value) * 100),
                  )
                }
              />
            </label>
            <label>
              Travel estimate (minutes)
              <input
                aria-label={"Area estimate " + (index + 1)}
                type="number"
                min="10"
                max="180"
                required
                value={zone.estimatedMinutes}
                onChange={(event) =>
                  zoneChange(
                    index,
                    "estimatedMinutes",
                    Number(event.target.value),
                  )
                }
              />
            </label>
            <Button
              secondary
              onClick={() =>
                change(
                  "zones",
                  values.zones.filter((_, position) => position !== index),
                )
              }
            >
              Remove area
            </Button>
          </div>
        ))}
        <Button
          secondary
          disabled={values.zones.length >= 20}
          onClick={() =>
            change("zones", [
              ...values.zones,
              {
                id: "area-" + requestKey().slice(0, 10),
                name: "",
                feeMinor: 0,
                minimumFoodMinor: 0,
                estimatedMinutes: 30,
              },
            ])
          }
        >
          Add delivery area
        </Button>
        <label>
          Reason for change
          <input
            aria-label="Fulfillment settings reason"
            required
            minLength={3}
            maxLength={160}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <Button type="submit" disabled={busy}>
          Save ordering settings
        </Button>
      </form>
    </details>
  );
}

export function FulfillmentDesk({ role }) {
  const { money, notify, t } = useApp(),
    resource = useResource("/staff/fulfillment/orders", { interval: 4000 });
  const [filter, setFilter] = useState("active"),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(null),
    [reason, setReason] = useState(""),
    [courier, setCourier] = useState({ name: "", phone: "" }),
    [error, setError] = useState(""),
    [bill, setBill] = useState(null),
    [receipt, setReceipt] = useState(null);
  async function perform(order, kind) {
    setBusy(true);
    setError("");
    try {
      await api("/staff/fulfillment/orders/" + order.id + "/action", {
        method: "POST",
        data: {
          action: kind,
          expectedRevision: order.revision,
          reason,
          courierName: courier.name,
          courierPhone: courier.phone,
        },
      });
      setAction(null);
      setReason("");
      setCourier({ name: "", phone: "" });
      await resource.reload();
    } catch (failure) {
      if (action) setError(failure.message);
      else notify(failure.message);
      await resource.reload();
    } finally {
      setBusy(false);
    }
  }
  const rows = (resource.data?.orders || []).filter(
    (order) =>
      filter === "all" ||
      !["collected", "delivered", "cancelled"].includes(order.status),
  );
  return (
    <section className="commerce-panel">
      <div className="commerce-panel-head">
        <div>
          <Eyebrow>OFF-PREMISE ORDERS</Eyebrow>
          <h2>Pickup & delivery</h2>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh orders
        </Button>
      </div>
      {role === "admin" && <FulfillmentSettings onSaved={resource.reload} />}
      <p className="commerce-note">
        Accept after checking availability and the address. Inventory is
        reserved on acceptance; preparation consumes it. Record actual money
        received before final handover. Paid cancellations use Refunds & credit
        notes.
      </p>
      <div className="page-tabs">
        <button
          type="button"
          aria-pressed={filter === "active"}
          onClick={() => setFilter("active")}
        >
          Active orders
        </button>
        <button
          type="button"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          Recent history
        </button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.loading ? (
        <Loading />
      ) : !rows.length ? (
        <p className="commerce-note">No orders in this view.</p>
      ) : (
        <div className="fulfillment-cards">
          {rows.map((order) => (
            <article className="fulfillment-card" key={order.id}>
              <header>
                <div>
                  <small>
                    {order.kind === "pickup" ? "PICKUP" : "DELIVERY"}
                  </small>
                  <h3>{order.code}</h3>
                </div>
                <strong className="soft-badge">
                  {statusName(order.status, (en) => en)}
                </strong>
              </header>
              <p>
                {order.name} {order.phone && " · " + order.phone}
              </p>
              <p>
                Requested: {dhakaTime(order.scheduledAt)} · {money(order.total)}
              </p>
              <FulfillmentItems order={order} />
              {order.note && <p className="guest-kitchen-note">{order.note}</p>}
              {order.address && (
                <p>
                  <Truck size={16} /> {order.address.line}, {order.address.area}{" "}
                  · {order.zoneName}
                  <br />
                  {order.address.note}
                </p>
              )}
              {order.courier && (
                <p>
                  Courier: {order.courier.name} · {order.courier.phone}
                </p>
              )}
              <p>
                Payment:{" "}
                <strong>
                  {order.bill?.status === "void"
                    ? "void invoice"
                    : order.paymentStatus?.replaceAll("_", " ")}
                </strong>
              </p>
              <div className="commerce-inline-actions">
                {order.status === "placed" && role === "admin" && (
                  <Button
                    disabled={busy}
                    onClick={() => perform(order, "accept")}
                  >
                    Accept order
                  </Button>
                )}
                {order.status === "accepted" &&
                  ["admin", "kitchen"].includes(role) && (
                    <Button
                      disabled={busy}
                      onClick={() => perform(order, "prepare")}
                    >
                      Start preparing
                    </Button>
                  )}
                {order.status === "preparing" &&
                  ["admin", "kitchen"].includes(role) && (
                    <Button
                      disabled={busy}
                      onClick={() => perform(order, "ready")}
                    >
                      Mark ready
                    </Button>
                  )}
                {order.status === "ready" &&
                  order.kind === "pickup" &&
                  ["admin", "waiter"].includes(role) && (
                    <Button
                      disabled={busy || order.paymentStatus !== "paid"}
                      onClick={() => perform(order, "collect")}
                    >
                      Confirm collection
                    </Button>
                  )}
                {order.status === "ready" &&
                  order.kind === "delivery" &&
                  ["admin", "waiter"].includes(role) && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setAction({ order, kind: "dispatch" });
                        setError("");
                      }}
                    >
                      Dispatch delivery
                    </Button>
                  )}
                {order.status === "dispatched" &&
                  ["admin", "waiter"].includes(role) && (
                    <Button
                      disabled={busy || order.paymentStatus !== "paid"}
                      onClick={() => perform(order, "deliver")}
                    >
                      Confirm delivered
                    </Button>
                  )}
                {order.bill?.status === "finalized" &&
                  ["admin", "cashier"].includes(role) && (
                    <Button secondary onClick={() => setBill(order.bill)}>
                      Record full payment
                    </Button>
                  )}
                {order.bill?.status === "paid" &&
                  ["admin", "cashier"].includes(role) && (
                    <Button secondary onClick={() => setReceipt(order.bill)}>
                      View receipt
                    </Button>
                  )}
                {role === "admin" &&
                  !["cancelled", "delivered", "collected"].includes(
                    order.status,
                  ) && (
                    <Button
                      secondary
                      disabled={busy}
                      onClick={() => {
                        setAction({ order, kind: "cancel" });
                        setError("");
                      }}
                    >
                      Cancel order
                    </Button>
                  )}
              </div>
              <details>
                <summary>History</summary>
                <ol className="fulfillment-history">
                  {order.history.map((step, index) => (
                    <li key={index}>
                      {statusName(step.status, (en) => en)} ·{" "}
                      {dhakaTime(step.at)} · {step.by || "Guest"}
                      {step.reason ? " · " + step.reason : ""}
                    </li>
                  ))}
                </ol>
              </details>
            </article>
          ))}
        </div>
      )}
      {action && (
        <Modal
          open
          title={
            action.kind === "dispatch" ? "Dispatch delivery" : "Cancel order"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form
            className="commerce-form"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(action.order, action.kind);
            }}
          >
            <p>{action.order.code}</p>
            {action.kind === "dispatch" ? (
              <>
                <label>
                  Courier / delivery staff name
                  <input
                    required
                    minLength={2}
                    maxLength={80}
                    value={courier.name}
                    onChange={(event) =>
                      setCourier({ ...courier, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Courier phone (optional)
                  <input
                    type="tel"
                    maxLength={25}
                    value={courier.phone}
                    onChange={(event) =>
                      setCourier({ ...courier, phone: event.target.value })
                    }
                  />
                </label>
                <p className="commerce-note">
                  Dispatch can proceed for cash on delivery. Record verified
                  money received before confirming delivery.
                </p>
              </>
            ) : (
              <>
                <label>
                  Cancellation reason
                  <textarea
                    required
                    minLength={3}
                    maxLength={160}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <p className="commerce-note">
                  An unpaid invoice is voided and unused reserved stock is
                  returned. Cooked ingredients stay consumed. A paid invoice
                  remains paid until its separate refund is confirmed.
                </p>
              </>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {action.kind === "dispatch"
                ? "Confirm dispatch"
                : "Confirm cancellation"}
            </Button>
          </form>
        </Modal>
      )}
      {bill && (
        <CounterBillDialog
          bill={bill}
          onClose={() => setBill(null)}
          onDone={() => {
            void resource.reload();
          }}
        />
      )}{" "}
      {receipt && (
        <Modal
          open
          title="Order receipt"
          onClose={() => setReceipt(null)}
          className="management-dialog"
        >
          <Receipt staff bill={receipt} />
        </Modal>
      )}
    </section>
  );
}
