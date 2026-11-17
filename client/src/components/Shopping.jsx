import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check,
  ChefHat,
  Flame,
  Plus,
  ShoppingBag,
  Sparkles,
  Star,
  Table2,
  Trash2,
  Users,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
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
  Loading,
  Modal,
  Quantity,
} from "./UI";

export function DishModal() {
  const app = useApp();
  const dish = app.menu.find((item) => item._id === app.dishId);
  return (
    <Modal
      open={Boolean(app.dishId)}
      onClose={() => app.setDishId(null)}
      title={dish ? app.name(dish) : app.t("Dish details", "খাবারের বিবরণ")}
      className="dish-dialog"
    >
      {dish ? <DishDetails key={dish._id} dish={dish} /> : <Loading />}
    </Modal>
  );
}
function DishDetails({ dish }) {
  const { t, name, describe, money, language, addItem, setDishId } = useApp();
  const [quantity, setQuantity] = useState(1);
  const [variantId, setVariantId] = useState(dish.variants?.[0]?.id || "");
  const [addonIds, setAddonIds] = useState([]);
  const reviews = useResource("/menu/" + dish._id + "/reviews");
  const variant = dish.variants?.find((option) => option.id === variantId);
  const total =
    (dish.price +
      (variant?.price || 0) +
      (dish.addons || [])
        .filter((option) => addonIds.includes(option.id))
        .reduce((sum, option) => sum + option.price, 0)) *
    quantity;
  const label = (option) =>
    language === "bn" ? option.nameBn || option.name : option.name;
  return (
    <>
      <div className="dish-details-top">
        <div className="dish-detail-photo">
          <img src={dish.image} alt={name(dish)} width="512" height="512" />
          {dish.signature && (
            <span className="dish-label">
              <ChefHat size={13} />
              {t("House signature", "আমাদের বিশেষ পদ")}
            </span>
          )}
        </div>
        <div className="dish-detail-copy">
          <div className="detail-rating">
            <Star size={16} fill="currentColor" />
            <strong>
              {dish.rating ? dish.rating.average.toFixed(1) : t("New", "নতুন")}
            </strong>
            <span>
              {dish.rating
                ? "(" + dish.rating.count + " " + t("ratings", "রেটিং") + ")"
                : t("Be the first to rate it", "প্রথম রেটিংটি দিন")}
            </span>
          </div>
          <p>{describe(dish)}</p>
          <div className="dish-properties">
            <span>
              <Users size={15} />
              {t("Serves ", "পরিবেশন ") + (dish.serves || 1)}
            </span>
            <span>
              <Flame size={15} />
              {t(
                dish.spice || "medium",
                { mild: "কম ঝাল", medium: "মাঝারি ঝাল", hot: "ঝাল" }[
                  dish.spice || "medium"
                ],
              )}
            </span>
          </div>
          {dish.variants?.length > 0 && (
            <fieldset className="dish-options">
              <legend>{t("Make it your size", "পরিমাণ বেছে নিন")}</legend>
              {dish.variants.map((option) => (
                <label key={option.id}>
                  <input
                    type="radio"
                    name={"variant-" + dish._id}
                    checked={variantId === option.id}
                    onChange={() => setVariantId(option.id)}
                  />
                  <span>{label(option)}</span>
                  <strong>
                    {option.price
                      ? "+" + money(option.price)
                      : t("Included", "অন্তর্ভুক্ত")}
                  </strong>
                </label>
              ))}
            </fieldset>
          )}
          {dish.addons?.length > 0 && (
            <fieldset className="dish-options">
              <legend>{t("A little extra?", "সঙ্গে আরও কিছু?")}</legend>
              {dish.addons.map((option) => (
                <label key={option.id}>
                  <input
                    type="checkbox"
                    checked={addonIds.includes(option.id)}
                    onChange={() =>
                      setAddonIds((previous) =>
                        previous.includes(option.id)
                          ? previous.filter((id) => id !== option.id)
                          : [...previous, option.id],
                      )
                    }
                  />
                  <span>{label(option)}</span>
                  <strong>+{money(option.price)}</strong>
                </label>
              ))}
            </fieldset>
          )}
          <div className="detail-add-row">
            <Quantity
              value={quantity}
              onChange={(value) => setQuantity(Math.max(1, value))}
            />
            <Button
              disabled={!dish.available}
              onClick={() => {
                if (
                  addItem(dish, {
                    quantity,
                    variantId: variantId || undefined,
                    addonIds,
                  })
                )
                  setDishId(null);
              }}
            >
              {dish.available ? (
                <>
                  {t("Add to cart", "কার্টে যোগ করুন")}
                  <span>{money(total)}</span>
                  <Plus size={17} />
                </>
              ) : (
                t("Sold out", "শেষ হয়ে গেছে")
              )}
            </Button>
          </div>
        </div>
      </div>
      <section className="dish-reviews">
        <div className="reviews-heading">
          <h3>{t("From the table", "অতিথিদের কথা")}</h3>
          <span>{t("Reviews for this dish", "এই খাবারের রিভিউ")}</span>
        </div>
        {reviews.loading ? (
          <Loading label={t("Loading reviews…", "রিভিউ আসছে…")} />
        ) : reviews.error ? (
          <ErrorMessage onRetry={reviews.reload}>
            {reviews.error.message}
          </ErrorMessage>
        ) : reviews.data?.reviews.length ? (
          <div className="reviews-grid">
            {reviews.data.reviews.map((review) => (
              <article key={review.id} className="review-card">
                <div className="review-top">
                  <span className="review-avatar">
                    {review.sample ? "S" : "G"}
                  </span>
                  <div>
                    <strong>{t("A table guest", "একজন অতিথি")}</strong>
                    <small>
                      {review.sample
                        ? t("Sample review", "নমুনা রিভিউ")
                        : t("Verified served order", "যাচাইকৃত পরিবেশিত অর্ডার")}
                    </small>
                  </div>
                  <span className="review-stars">
                    <Star size={12} fill="currentColor" />
                    {review.rating}
                  </span>
                </div>
                {review.comment && <p>{review.comment}</p>}
                {review.liked && (
                  <p>
                    <b>{t("Loved", "ভালো লেগেছে")}</b> {review.liked}
                  </p>
                )}
                {review.improve && (
                  <p>
                    <b>{t("Could improve", "আরও ভালো হতে পারে")}</b>{" "}
                    {review.improve}
                  </p>
                )}
                {review.photo && (
                  <img
                    className="review-photo"
                    src={review.photo}
                    alt={t(
                      "A guest’s photo of this dish",
                      "অতিথির তোলা খাবারের ছবি",
                    )}
                    loading="lazy"
                  />
                )}
                {review.reply && (
                  <div className="restaurant-reply">
                    <strong>Angar Kitchen</strong>
                    <p>{review.reply}</p>
                  </div>
                )}
                <time dateTime={review.createdAt}>
                  {dhakaTime(review.createdAt, true, language)}
                </time>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">
            {t(
              "A fresh start. There are no published reviews for this dish yet.",
              "এই খাবারের এখনো প্রকাশিত রিভিউ নেই।",
            )}
          </p>
        )}
      </section>
    </>
  );
}

export function CartDrawer() {
  const app = useApp();
  const {
    t,
    money,
    name,
    pricedLines,
    count,
    total,
    note,
    setNote,
    updateQuantity,
    menuLoading,
    cartOpen,
    setCartOpen,
    table,
    restaurant,
    notify,
  } = app;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    if (cartOpen) {
      setError("");
      void app.reloadContext().catch(() => {});
    }
  }, [cartOpen, app.reloadContext]);
  const available =
    pricedLines.length > 0 && pricedLines.every((line) => line.valid);
  const canOrder =
    table?.active &&
    table.billingState !== "finalized" &&
    restaurant?.orderingEnabled !== false &&
    available &&
    !menuLoading;
  async function checkout(event) {
    event.preventDefault();
    if (!canOrder || busy) return;
    const data = {
      visitKey: table.visitKey,
      items: pricedLines.map((line) => ({
        dishId: line.dishId,
        quantity: line.quantity,
        expectedPrice: line.unitPrice,
        ...(line.variantId ? { variantId: line.variantId } : {}),
        ...(line.addonIds?.length ? { addonIds: line.addonIds } : {}),
      })),
      note: note.trim(),
    };
    const signature = JSON.stringify(data);
    const old = readStorage("angar.checkout.v2", null, true);
    const key = old?.signature === signature ? old.key : requestKey();
    saveStorage("angar.checkout.v2", { signature, key }, true);
    setBusy(true);
    setError("");
    try {
      const result = await api("/orders", {
        method: "POST",
        data,
        headers: { "Idempotency-Key": key },
      });
      app.clearCart();
      setCartOpen(false);
      saveStorage("angar.checkout.v2", null, true);
      notify(
        t(
          "Order received. Your table is in good hands.",
          "অর্ডার জমা হয়েছে। স্টাফ শিগগিরই গ্রহণ করবেন।",
        ),
      );
      navigate("/orders?order=" + result.order.id);
    } catch (failure) {
      setError(
        failure.code === "NETWORK" || failure.status >= 500
          ? t(
              "We couldn’t confirm the order. Retry this checkout or check My orders.",
              "অর্ডার নিশ্চিত করা যায়নি। আবার চেষ্টা করুন বা আমার অর্ডার দেখুন।",
            )
          : failure.message,
      );
      if (
        ["PRICE_CHANGED", "OPTIONS_CHANGED", "ITEM_UNAVAILABLE"].includes(
          failure.code,
        )
      )
        await app.reloadMenu();
      if (
        ["TABLE_CHANGED", "TABLE_CLOSED", "BILL_FINALIZED"].includes(
          failure.code,
        )
      )
        await app.reloadContext();
      if (failure.code === "ORDERING_PAUSED") await app.reloadRestaurant();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={cartOpen}
      onClose={() => setCartOpen(false)}
      title={t("A little something good", "আপনার পছন্দের খাবার")}
      className="cart-drawer"
    >
      {!count ? (
        <EmptyState
          icon={ShoppingBag}
          title={t("Your next craving awaits.", "কার্টে পছন্দের খাবার যোগ করুন।")}
          text={t(
            "Start with a house favourite and make it a meal.",
            "একটি পছন্দের খাবার দিয়ে শুরু করুন।",
          )}
        >
          <Button to="/menu" onClick={() => setCartOpen(false)} arrow>
            {t("Explore the menu", "মেনু দেখুন")}
          </Button>
        </EmptyState>
      ) : (
        <form className="cart-form" onSubmit={checkout}>
          <div className="cart-scroll">
            <div className={"cart-context" + (table?.active ? " active" : "")}>
              <Table2 size={22} />
              <div>
                <strong>
                  {table
                    ? t("Table ", "টেবিল ") + table.number.slice(1)
                    : t("Browsing the menu", "মেনু দেখছেন")}
                </strong>
                <small>
                  {table?.active
                    ? table.billingState === "finalized"
                      ? t(
                          "Your bill is finalized at the counter.",
                          "আপনার বিল কাউন্টারে চূড়ান্ত হয়েছে।",
                        )
                      : t(
                          "Ordering at Angar, Dhanmondi",
                          "আঙার, ধানমন্ডিতে অর্ডার করছেন",
                        )
                    : t(
                        "Scan your table’s QR to place this order.",
                        "অর্ডার দিতে টেবিলের QR স্ক্যান করুন।",
                      )}
                </small>
              </div>
            </div>
            {menuLoading ? (
              <Loading />
            ) : (
              <ul className="cart-lines">
                {pricedLines.map((line) => (
                  <li key={line.key}>
                    <img
                      src={line.dish?.image || "/assets/mutton-kacchi.webp"}
                      alt=""
                      width="76"
                      height="76"
                    />
                    <div className="cart-line-main">
                      <strong>
                        {line.dish ? name(line.dish) : line.dishId}
                      </strong>
                      <small>
                        {[
                          line.variant?.name,
                          ...line.addons.map((option) => option.name),
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("Made to order", "অর্ডার অনুযায়ী")}
                      </small>
                      {!line.valid && (
                        <span className="unavailable-label">
                          {t(
                            "Selection unavailable",
                            "এই নির্বাচন এখন পাওয়া যাচ্ছে না",
                          )}
                        </span>
                      )}
                      <Quantity
                        value={line.quantity}
                        onChange={(value) => updateQuantity(line.key, value)}
                        disabled={busy}
                      />
                    </div>
                    <div className="cart-line-end">
                      <strong>{money(line.subtotal)}</strong>
                      <button
                        type="button"
                        aria-label={
                          t("Remove ", "বাদ দিন ") +
                          (line.dish ? name(line.dish) : "")
                        }
                        disabled={busy}
                        onClick={() => updateQuantity(line.key, 0)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <label className="field-label" htmlFor="kitchen-note">
              {t("A note for our kitchen", "কিচেনের জন্য নোট")}
              <small>{t("optional", "ঐচ্ছিক")}</small>
            </label>
            <textarea
              id="kitchen-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={200}
              rows={2}
              placeholder={t("Less chilli, please…", "ঝাল একটু কম…")}
              disabled={busy}
            />
          </div>
          <div className="cart-checkout">
            <div className="cart-subtotal">
              <span>{t("Food subtotal", "খাবারের মোট")}</span>
              <strong>{money(total)}</strong>
            </div>
            <p>
              {t(
                "Pay at the restaurant. Any configured service charge is included on your table’s final bill.",
                "রেস্টুরেন্টে বিল পরিশোধ করুন। প্রযোজ্য সার্ভিস চার্জ টেবিলের চূড়ান্ত বিলে দেখা যাবে।",
              )}
            </p>
            {restaurant?.orderingEnabled === false && (
              <ErrorMessage>
                {t(
                  "The kitchen is taking a short pause.",
                  "কিচেন কিছুক্ষণের বিরতিতে আছে।",
                )}
              </ErrorMessage>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <button
              type="submit"
              className="button button-primary button-wide"
              disabled={!canOrder || busy}
            >
              {busy
                ? t("Sending to the team…", "অর্ডার যাচ্ছে…")
                : t("Place my order", "অর্ডার দিন")}
              <ArrowRight size={18} />
            </button>
            <div className="checkout-assurance">
              <Check size={13} />
              {t(
                "Staff will confirm your order before cooking.",
                "রান্নার আগে স্টাফ অর্ডারটি গ্রহণ করবেন।",
              )}
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function MenuMatcher() {
  const { t, menu, name, money, matcherOpen, setMatcherOpen, setDishId } =
    useApp();
  const [values, setValues] = useState({
    budget: 1000,
    people: 2,
    spice: "any",
  });
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(await api("/menu-match", { method: "POST", data: values }));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={matcherOpen}
      onClose={() => setMatcherOpen(false)}
      title={t("Find your menu match", "আপনার পছন্দের খাবার খুঁজুন")}
      className="matcher-dialog"
    >
      <div className="matcher-intro">
        <span>
          <Sparkles size={28} />
        </span>
        <h3>
          {t(
            "A craving, a budget, a little help.",
            "ইচ্ছে আর বাজেট মিলিয়ে বেছে নিন।",
          )}
        </h3>
        <p>
          {t(
            "Choose your preferences. We’ll match them against the current menu and availability.",
            "আপনার পছন্দ জানান। বর্তমান মেনু ও প্রাপ্যতা থেকে মিল খুঁজে দেওয়া হবে।",
          )}
        </p>
      </div>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <label>
            {t("Total food budget (৳)", "মোট খাবারের বাজেট (৳)")}
            <input
              type="number"
              min="100"
              max="10000"
              step="50"
              required
              value={values.budget}
              onChange={(e) =>
                setValues({ ...values, budget: Number(e.target.value) })
              }
            />
          </label>
          <label>
            {t("People", "কতজন")}
            <input
              type="number"
              min="1"
              max="10"
              required
              value={values.people}
              onChange={(e) =>
                setValues({ ...values, people: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <label>
          {t("Spice preference", "ঝালের পছন্দ")}
          <select
            value={values.spice}
            onChange={(e) => setValues({ ...values, spice: e.target.value })}
          >
            <option value="any">{t("Anything goes", "যেকোনো")}</option>
            <option value="mild">{t("Mild", "কম ঝাল")}</option>
            <option value="medium">{t("Medium", "মাঝারি")}</option>
            <option value="hot">{t("Hot", "ঝাল")}</option>
          </select>
        </label>
        <button className="button button-primary" type="submit" disabled={busy}>
          {t("Find my matches", "মিলিয়ে দেখুন")}
          <Sparkles size={16} />
        </button>
      </form>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {result && (
        <div className="matcher-results">
          {result.matches.length ? (
            result.matches.map((match) => {
              const dish = menu.find((item) => item._id === match.dishId);
              return (
                dish && (
                  <button
                    key={dish._id}
                    type="button"
                    className="matcher-result"
                    onClick={() => {
                      setMatcherOpen(false);
                      setDishId(dish._id);
                    }}
                  >
                    <img src={dish.image} alt="" width="64" height="64" />
                    <span>
                      <strong>{name(dish)}</strong>
                      <small>
                        {match.quantity}×{" "}
                        {t(
                          "servings within your budget",
                          "পরিবেশন আপনার বাজেটে",
                        )}
                      </small>
                    </span>
                    <b>{money(match.total)}</b>
                    <ArrowRight size={17} />
                  </button>
                )
              );
            })
          ) : (
            <p className="muted">
              {t(
                "No main dish matches those preferences. Try a higher budget or another spice level.",
                "এই পছন্দে মিল পাওয়া যায়নি। বাজেট বা ঝালের মাত্রা বদলে দেখুন।",
              )}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
