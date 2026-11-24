import { useCustomerUpdates } from "../lib/useCustomerUpdates";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  ImagePlus,
  MessageSquareText,
  ReceiptText,
  ShoppingBag,
  Star,
  Table2,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Eyebrow,
  Loading,
  Modal,
  Progress,
  Status,
} from "../components/UI";
import { TableNotice } from "./Menu";
import { GuestTableBill } from "../components/Financial";
import { GuestOrderChanges } from "../components/Operations";

export function Orders() {
  const live = useCustomerUpdates();
  const app = useApp();
  const { t, name, money, language, contextReady, notify } = app;
  const [params] = useSearchParams();
  const [tab, setTab] = useState(
    params.get("tab") === "events" ? "events" : "orders",
  );
  const resource = useResource(
    tab === "events"
      ? "/events"
      : "/orders" +
          (params.get("order")
            ? "?id=" + encodeURIComponent(params.get("order"))
            : ""),
    {
      enabled: contextReady,
      interval: 4000,
    },
  );
  const [review, setReview] = useState(null);
  const [accepting, setAccepting] = useState(null);
  async function accept(event) {
    setAccepting(event.id);
    try {
      await api("/events/" + event.id + "/accept", {
        method: "POST",
        data: { version: event.quote.version },
      });
      notify(t("Your acceptance has been recorded.", "আপনার সম্মতি জমা হয়েছে।"));
      await resource.reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setAccepting(null);
    }
  }
  return (
    <section className="container orders-page">
      <p className="customer-live-status" role="status">
        {live === "connected"
          ? "Connected · instant updates"
          : live === "offline"
            ? "Offline · reconnecting when available"
            : "Automatic updates · reconnecting"}
      </p>
      <div className="page-heading">
        <Eyebrow>{t("YOUR ANGAR EXPERIENCE", "আঙারে আপনার অভিজ্ঞতা")}</Eyebrow>
        <h1>
          {t("Good things", "ভালো কিছু")}{" "}
          <em>{t("are on the way.", "আপনার অপেক্ষায়।")}</em>
        </h1>
        <p>
          {t(
            "Your table orders and private gatherings, all in one place.",
            "আপনার টেবিল অর্ডার ও ব্যক্তিগত আয়োজন এক জায়গায়।",
          )}
        </p>
      </div>
      <TableNotice compact />
      <div className="commerce-inline-actions">
        <Button secondary to="/takeaway">
          {t("Pickup & delivery orders", "টেকঅ্যাওয়ে ও ডেলিভারি অর্ডার")}
        </Button>
        <Button secondary to="/notifications">
          {t("Order & reservation alerts", "অর্ডার ও বুকিংয়ের খবর")}
        </Button>
      </div>
      {tab === "orders" && <GuestTableBill />}
      <div className="page-tabs">
        <button
          type="button"
          aria-pressed={tab === "orders"}
          onClick={() => setTab("orders")}
        >
          <ReceiptText size={17} />
          {t("Table orders", "টেবিলের অর্ডার")}
        </button>
        <button
          type="button"
          aria-pressed={tab === "events"}
          onClick={() => setTab("events")}
        >
          <MessageSquareText size={17} />
          {t("My gatherings", "আমার আয়োজন")}
        </button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.loading ? (
        <Loading label={t("Getting your updates…", "অবস্থা দেখা হচ্ছে…")} />
      ) : tab === "orders" ? (
        resource.data?.orders.length ? (
          <div className="guest-orders">
            <p className="orders-browser-note">
              {t(
                "Your account or browser’s recent orders. Updates arrive automatically.",
                "আপনার অ্যাকাউন্ট বা এই ব্রাউজারের সাম্প্রতিক অর্ডার। অবস্থা নিজে থেকেই বদলাবে।",
              )}
            </p>
            {resource.data.orders.map((order) => (
              <article className="guest-order-card" key={order.id}>
                <header>
                  <div className="order-card-icon">
                    <ReceiptText size={23} />
                  </div>
                  <div>
                    <span>
                      {t("TABLE ", "টেবিল ") + order.tableNumber.slice(1)} <i />{" "}
                      {dhakaTime(order.createdAt, false, language)}
                    </span>
                    <h2>{order.code}</h2>
                  </div>
                  <Status status={order.status} />
                </header>
                <Progress status={order.status} />
                {order.status === "cancelled" && (
                  <ErrorMessage>
                    {order.history.at(-1)?.reason ||
                      t("Please speak to your server.", "স্টাফের সঙ্গে কথা বলুন।")}
                  </ErrorMessage>
                )}
                <ul className="ordered-items">
                  {order.items.map((item, index) => {
                    const feedback = order.reviews.find(
                      (entry) => entry.dishId === item.dishId,
                    );
                    return (
                      <li key={item.dishId + "-" + index}>
                        <span className="order-quantity">{item.quantity}×</span>
                        <div>
                          <strong>{name(item)}</strong>
                          {(item.variant || item.addons?.length > 0) && (
                            <small>
                              {[
                                item.variant?.name,
                                ...(item.addons || []).map(
                                  (addon) => addon.name,
                                ),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </small>
                          )}
                        </div>
                        {order.status === "served" &&
                          (feedback ? (
                            <span className="review-state">
                              <CheckCircle2 size={13} />
                              {feedback.visibility === "private"
                                ? t(
                                    "Private feedback sent",
                                    "ব্যক্তিগত মতামত পাঠানো হয়েছে",
                                  )
                                : feedback.status === "approved"
                                  ? t("Review published", "রিভিউ প্রকাশিত")
                                  : feedback.status === "hidden"
                                    ? t("Review received", "রিভিউ পাওয়া গেছে")
                                    : t("Review pending", "রিভিউ যাচাই চলছে")}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rate-button"
                              onClick={() =>
                                setReview({ orderId: order.id, item })
                              }
                            >
                              <Star size={13} />
                              {t("Rate dish", "রেটিং দিন")}
                            </button>
                          ))}
                        <b>{money(item.subtotal)}</b>
                      </li>
                    );
                  })}
                </ul>
                {order.note && (
                  <p className="guest-kitchen-note">
                    <ChefNote />
                    {order.note}
                  </p>
                )}
                <GuestOrderChanges order={order} onRefresh={resource.reload} />
                <footer>
                  <span>
                    {t("Food total", "খাবারের মোট")}
                    <small>
                      {order.bill?.status === "paid"
                        ? t(
                            "Included in a paid table bill",
                            "পরিশোধিত টেবিল বিলে অন্তর্ভুক্ত",
                          )
                        : t("Pay at the restaurant", "রেস্টুরেন্টে পরিশোধ করুন")}
                    </small>
                  </span>
                  <strong>{money(order.total)}</strong>
                  {order.bill?.status === "paid" && (
                    <Link
                      className="receipt-link"
                      to={"/receipt/" + order.bill.id}
                    >
                      <ReceiptText size={15} />
                      {t("View receipt", "রসিদ দেখুন")}
                    </Link>
                  )}
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={ShoppingBag}
            title={t(
              "Your table’s next chapter.",
              "আপনার পরের অর্ডারের অপেক্ষায়।",
            )}
            text={t(
              "Scan the code on your table, choose your favourites, and we’ll take it from there.",
              "টেবিলের কোড স্ক্যান করে মেনু থেকে খাবার বেছে নিন।",
            )}
          >
            <Button to="/menu" arrow>
              {t("Explore the menu", "মেনু দেখুন")}
            </Button>
          </EmptyState>
        )
      ) : resource.data?.events.length ? (
        <div className="event-tracking-list">
          {resource.data.events.map((event) => (
            <article className="event-tracking-card" key={event.id}>
              <header>
                <div>
                  <small>{event.code}</small>
                  <h2>
                    {event.name}
                    {t("’s gathering", "-এর আয়োজন")}
                  </h2>
                </div>
                <Status status={event.status} />
              </header>
              <div className="event-tracking-meta">
                <span>
                  <Clock3 size={16} />
                  {dhakaTime(event.startsAt, false, language)}
                </span>
                <span>
                  <Table2 size={16} />
                  {event.guests} {t("guests", "জন অতিথি")}
                </span>
              </div>
              {event.quote ? (
                <div className="quote-preview">
                  <h3>
                    {t("Your event quote", "আপনার ইভেন্টের মূল্যপ্রস্তাব")}{" "}
                    <small>v{event.quote.version}</small>
                  </h3>
                  <p>{event.quote.menu}</p>
                  <dl>
                    <div>
                      <dt>{t("Space", "স্পেস")}</dt>
                      <dd>{money(event.quote.hallFee)}</dd>
                    </div>
                    <div>
                      <dt>
                        {event.guests} × {t("menu per guest", "জনপ্রতি খাবার")}
                      </dt>
                      <dd>{money(event.quote.perGuest * event.guests)}</dd>
                    </div>
                    <div>
                      <dt>{t("Extras", "অতিরিক্ত")}</dt>
                      <dd>{money(event.quote.extras)}</dd>
                    </div>
                    <div className="quote-total">
                      <dt>{t("Total", "মোট")}</dt>
                      <dd>{money(event.quote.total)}</dd>
                    </div>
                    <div>
                      <dt>{t("Deposit", "অগ্রিম")}</dt>
                      <dd>{money(event.quote.deposit)}</dd>
                    </div>
                  </dl>
                  <p className="quote-terms">{event.quote.terms}</p>
                  <small>
                    {t("Valid until ", "মেয়াদ ") +
                      dhakaTime(event.quote.expiresAt, false, language)}
                  </small>
                  {event.status === "quote_sent" && (
                    <Button
                      disabled={
                        accepting === event.id ||
                        new Date(event.quote.expiresAt) <= new Date()
                      }
                      onClick={() => accept(event)}
                      arrow
                    >
                      {t("Accept this quote", "এই প্রস্তাবে সম্মতি দিন")}
                    </Button>
                  )}
                  {event.status === "awaiting_deposit" && (
                    <p className="quote-deposit-note">
                      {t(
                        "Our team will record your deposit after checking payment at the restaurant. Please contact the team before the quote expires.",
                        "রেস্টুরেন্টে পেমেন্ট যাচাই করে টিম অগ্রিমের রেকর্ড রাখবে। প্রস্তাবের মেয়াদ শেষ হওয়ার আগে টিমের সঙ্গে যোগাযোগ করুন।",
                      )}
                    </p>
                  )}
                </div>
              ) : (
                <p className="muted">
                  {t(
                    "Our team will review your request and prepare a quote here.",
                    "আমাদের টিম অনুরোধ দেখে এখানে মূল্যপ্রস্তাব পাঠাবে।",
                  )}
                </p>
              )}
              {event.depositRefundedMinor > 0 && (
                <p className="commerce-note">
                  {t("Deposit returned: ", "অগ্রিম ফেরত: ")}
                  {money(event.depositRefundedMinor / 100)} ·{" "}
                  {t(
                    "The original deposit remains in the payment history.",
                    "মূল অগ্রিম পেমেন্টের ইতিহাসে রাখা হয়েছে।",
                  )}
                </p>
              )}
              {event.history.at(-1)?.reason && (
                <p className="muted">{event.history.at(-1).reason}</p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={MessageSquareText}
          title={t("Something worth celebrating?", "স্মরণীয় কোনো আয়োজন?")}
          text={t(
            "Tell us about your occasion and we’ll help plan your table.",
            "আপনার অনুষ্ঠানের কথা জানান, আমরা আয়োজনের পরিকল্পনা করব।",
          )}
        >
          <Button to="/events" arrow>
            {t("Plan a gathering", "ইভেন্টের অনুরোধ করুন")}
          </Button>
        </EmptyState>
      )}
      {review && (
        <ReviewForm
          target={review}
          onClose={() => setReview(null)}
          onSaved={() => resource.reload()}
        />
      )}
    </section>
  );
}
function ChefNote() {
  return <MessageSquareText size={14} />;
}

function ReviewForm({ target, onClose, onSaved }) {
  const { t, name, notify } = useApp();
  const [rating, setRating] = useState(0);
  const [values, setValues] = useState({
    comment: "",
    liked: "",
    improve: "",
    visibility: "public",
  });
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [textSaved, setTextSaved] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (!rating) return;
    setBusy(true);
    setError("");
    try {
      if (!textSaved) {
        await api("/orders/" + target.orderId + "/reviews", {
          method: "POST",
          data: { dishId: target.item.dishId, rating, ...values },
        });
        setTextSaved(true);
      }
      if (file) {
        try {
          await api(
            "/orders/" +
              target.orderId +
              "/reviews/" +
              target.item.dishId +
              "/photo",
            { method: "POST", image: file },
          );
        } catch (failure) {
          setError(
            t(
              "Your text is saved. Photo upload failed. Choose another photo or finish without it. ",
              "লেখা জমা হয়েছে। ছবি আপলোড হয়নি। অন্য ছবি দিন বা ছবি ছাড়াই শেষ করুন। ",
            ) + failure.message,
          );
          return;
        }
      }
      notify(
        t(
          "Thank you. Your feedback is with our team.",
          "ধন্যবাদ। আপনার মতামত আমাদের টিমের কাছে পৌঁছেছে।",
        ),
      );
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (textSaved) onSaved();
        onClose();
      }}
      title={t("How was your dish?", "খাবারটি কেমন লাগল?")}
      className="review-dialog"
    >
      <form className="form-stack" onSubmit={submit}>
        <h3 className="review-dish-name">{name(target.item)}</h3>
        <fieldset className="star-picker">
          <legend>{t("Your rating", "আপনার রেটিং")}</legend>
          <div>
            {[1, 2, 3, 4, 5].map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="rating"
                  required
                  value={value}
                  checked={rating === value}
                  disabled={textSaved}
                  onChange={() => setRating(value)}
                  aria-label={value + " out of 5 stars"}
                />
                <span>
                  <Star
                    size={30}
                    fill={rating >= value ? "currentColor" : "none"}
                  />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          {t("Your experience", "আপনার অভিজ্ঞতা")}
          <textarea
            rows={3}
            maxLength={400}
            value={values.comment}
            disabled={textSaved}
            onChange={(e) => setValues({ ...values, comment: e.target.value })}
            placeholder={t(
              "A few words for the next guest…",
              "পরের অতিথির জন্য কিছু কথা…",
            )}
          />
        </label>
        <div className="form-grid">
          <label>
            {t("What did you enjoy?", "কী ভালো লেগেছে?")}
            <input
              maxLength={200}
              value={values.liked}
              disabled={textSaved}
              onChange={(e) => setValues({ ...values, liked: e.target.value })}
            />
          </label>
          <label>
            {t("What could be better?", "কী আরও ভালো হতে পারে?")}
            <input
              maxLength={200}
              value={values.improve}
              disabled={textSaved}
              onChange={(e) =>
                setValues({ ...values, improve: e.target.value })
              }
            />
          </label>
        </div>
        <label>
          {t("Who can see it?", "কে দেখতে পারবেন?")}
          <select
            disabled={textSaved}
            value={values.visibility}
            onChange={(e) =>
              setValues({ ...values, visibility: e.target.value })
            }
          >
            <option value="public">
              {t("Share publicly after review", "যাচাইয়ের পর সবার সঙ্গে প্রকাশ")}
            </option>
            <option value="private">
              {t("Only the restaurant team", "শুধু রেস্টুরেন্টের টিম")}
            </option>
          </select>
        </label>
        <label className="photo-picker">
          <ImagePlus size={20} />
          <span>
            {file
              ? file.name
              : t(
                  "Add a food photo (optional, up to 4 MB)",
                  "খাবারের ছবি যোগ করুন (ঐচ্ছিক, সর্বোচ্চ ৪ MB)",
                )}
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const photo = e.target.files[0];
              if (photo && photo.size > 4 * 1024 * 1024) {
                setError(
                  t(
                    "Choose an image smaller than 4 MB.",
                    "৪ MB-এর ছোট ছবি দিন।",
                  ),
                );
                e.target.value = "";
                return;
              }
              setError("");
              setFile(photo || null);
            }}
          />
        </label>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <div className="form-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={busy}
          >
            {busy
              ? t("Saving…", "জমা হচ্ছে…")
              : textSaved
                ? t("Finish review", "শেষ করুন")
                : t("Send my feedback", "মতামত পাঠান")}
            <ArrowRight size={16} />
          </button>
          {textSaved && file && (
            <Button
              secondary
              onClick={() => {
                onSaved();
                onClose();
              }}
            >
              {t("Finish without photo", "ছবি ছাড়াই শেষ করুন")}
            </Button>
          )}
        </div>
        <p className="form-help">
          {t(
            "Public feedback is checked before it appears on the menu.",
            "পাবলিক রিভিউ মেনুতে দেখানোর আগে যাচাই করা হয়।",
          )}
        </p>
      </form>
    </Modal>
  );
}
