import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Gift,
  History,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Wallet,
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
  Status,
} from "../components/UI";

export function Account() {
  const app = useApp(),
    {
      t,
      customer,
      customerReady,
      customerError,
      reloadCustomer,
      money,
      language,
      notify,
    } = app;
  const [mode, setMode] = useState("login"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [values, setValues] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
  });
  const [profile, setProfile] = useState({ name: "", phone: "" });
  const [passwords, setPasswords] = useState({
    currentPassword: "",
    newPassword: "",
  });
  const loyalty = useResource("/account/loyalty", {
    enabled: Boolean(customer),
    interval: 30000,
  });
  const offers = useResource("/coupons", { enabled: Boolean(customer) });
  const delivery = useResource("/account");
  useEffect(() => {
    if (customer) setProfile({ name: customer.name, phone: customer.phone });
  }, [customer?.id, customer?.name, customer?.phone]);
  async function auth(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot") {
        await api("/account/forgot-password", {
          method: "POST",
          data: { email: values.email },
        });
        notify(
          t(
            "If this account exists and email is available, a reset link will arrive shortly.",
            "অ্যাকাউন্টটি থাকলে এবং ইমেইল চালু থাকলে রিসেট লিংক পাঠানো হবে।",
          ),
        );
        return;
      }
      await api("/account/" + mode, {
        method: "POST",
        data:
          mode === "login"
            ? { email: values.email, password: values.password }
            : {
                name: values.name,
                email: values.email,
                password: values.password,
                ...(values.phone ? { phone: values.phone } : {}),
              },
      });
      setValues({ name: "", email: "", phone: "", password: "" });
      await reloadCustomer();
      notify(
        t("Welcome to your Angar account.", "আপনার আঙার অ্যাকাউন্টে স্বাগতম।"),
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function change(task, message) {
    setBusy(true);
    setError("");
    try {
      await task();
      await reloadCustomer();
      notify(message);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="container commerce-page account-page">
      <div className="page-heading">
        <Eyebrow>{t("YOUR PLACE AT ANGAR", "আঙারে আপনার জায়গা")}</Eyebrow>
        <h1>
          {t("A little more", "আরও একটু")}{" "}
          <em>{t("personal.", "আপনার মতো।")}</em>
        </h1>
        <p>
          {t(
            "Keep your dining history, collect points and find your favourites again.",
            "খাওয়ার ইতিহাস রাখুন, পয়েন্ট জমা করুন ও পছন্দের খাবার আবার অর্ডার করুন।",
          )}
        </p>
      </div>
      {customerError && (
        <ErrorMessage onRetry={reloadCustomer}>{customerError}</ErrorMessage>
      )}
      {!customerReady ? (
        <Loading />
      ) : !customer ? (
        <div className="account-auth-grid">
          <aside className="commerce-wine-card">
            <UserRound size={32} />
            <h2>{t("Your table, remembered.", "আপনার পছন্দ মনে থাকবে।")}</h2>
            <p>
              {t(
                "An account is optional. You can always scan a table QR and order as a guest.",
                "অ্যাকাউন্ট বাধ্যতামূলক নয়। টেবিলের QR স্ক্যান করে অতিথি হিসেবেও অর্ডার করতে পারবেন।",
              )}
            </p>
            <Link to="/menu">{t("Continue to menu", "মেনুতে যান")}</Link>
          </aside>
          <form className="commerce-card commerce-form" onSubmit={auth}>
            <div className="commerce-tabs">
              <button
                type="button"
                aria-pressed={mode === "login"}
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
              >
                {t("Sign in", "সাইন ইন")}
              </button>
              <button
                type="button"
                aria-pressed={mode === "register"}
                onClick={() => {
                  setMode("register");
                  setError("");
                }}
              >
                {t("Create account", "অ্যাকাউন্ট খুলুন")}
              </button>
            </div>
            {mode === "forgot" && (
              <p>
                {t(
                  "Enter your account email to request a password reset link.",
                  "পাসওয়ার্ড রিসেট লিংক পেতে অ্যাকাউন্টের ইমেইল দিন।",
                )}
              </p>
            )}
            {delivery.data?.mail?.enabled === false && (
              <p className="commerce-note">
                {t(
                  "Email delivery is not configured yet. Ask the restaurant to enable it for verification and password recovery.",
                  "ইমেইল পাঠানো এখনও চালু হয়নি। যাচাই ও পাসওয়ার্ড রিসেটের জন্য রেস্টুরেন্টকে এটি চালু করতে বলুন।",
                )}
              </p>
            )}
            {mode === "register" && (
              <label>
                {t("Your name", "আপনার নাম")}
                <input
                  name="name"
                  autoComplete="name"
                  required
                  minLength={2}
                  maxLength={80}
                  value={values.name}
                  onChange={(event) =>
                    setValues({ ...values, name: event.target.value })
                  }
                />
              </label>
            )}
            <label>
              {t("Email", "ইমেইল")}
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                maxLength={254}
                value={values.email}
                onChange={(event) =>
                  setValues({ ...values, email: event.target.value })
                }
              />
            </label>
            {mode === "register" && (
              <label>
                {t("Phone (optional)", "ফোন (ঐচ্ছিক)")}
                <input
                  type="tel"
                  autoComplete="tel"
                  maxLength={25}
                  value={values.phone}
                  onChange={(event) =>
                    setValues({ ...values, phone: event.target.value })
                  }
                />
              </label>
            )}
            {mode !== "forgot" && (
              <label>
                {t("Password", "পাসওয়ার্ড")}
                <input
                  type="password"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  required
                  minLength={mode === "register" ? 12 : 1}
                  maxLength={128}
                  value={values.password}
                  onChange={(event) =>
                    setValues({ ...values, password: event.target.value })
                  }
                />
                {mode === "register" && (
                  <small>
                    {t(
                      "Use at least 12 characters.",
                      "অন্তত ১২ অক্ষর ব্যবহার করুন।",
                    )}
                  </small>
                )}
              </label>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy
                ? t("Please wait…", "অপেক্ষা করুন…")
                : mode === "login"
                  ? t("Sign in to my account", "আমার অ্যাকাউন্টে প্রবেশ")
                  : mode === "forgot"
                    ? t("Send reset link", "রিসেট লিংক পাঠান")
                    : t("Create my account", "আমার অ্যাকাউন্ট খুলুন")}
            </Button>
            {mode !== "forgot" && (
              <Button
                secondary
                type="button"
                onClick={() => {
                  setMode("forgot");
                  setError("");
                  setValues({ ...values, password: "" });
                }}
              >
                {t("Forgot password?", "পাসওয়ার্ড ভুলে গেছেন?")}
              </Button>
            )}
          </form>
        </div>
      ) : (
        <>
          <div className="account-overview">
            <div>
              <span className="commerce-avatar">
                <UserRound size={25} />
              </span>
              <div>
                <h2>{customer.name}</h2>
                <p>{customer.email}</p>
              </div>
            </div>
            <Button
              secondary
              className="button-small"
              disabled={busy}
              onClick={() =>
                change(
                  () => api("/account/logout", { method: "POST", data: {} }),
                  t("Signed out.", "সাইন আউট হয়েছে।"),
                )
              }
            >
              <LogOut size={15} />
              {t("Sign out", "সাইন আউট")}
            </Button>
          </div>
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <article className="commerce-card account-verification">
            <h2>
              <ShieldCheck size={21} />
              {customer.emailVerified
                ? t("Email verified", "ইমেইল যাচাই হয়েছে")
                : t("Verify your email", "ইমেইল যাচাই করুন")}
            </h2>
            <p className="commerce-note">
              {customer.emailVerified
                ? t(
                    "Your email address has been confirmed.",
                    "আপনার ইমেইল ঠিকানা নিশ্চিত করা হয়েছে।",
                  )
                : t(
                    "Confirm your email to protect access and enable password recovery. Guest ordering remains available.",
                    "অ্যাক্সেস সুরক্ষিত রাখতে ও পাসওয়ার্ড রিসেট করতে ইমেইল নিশ্চিত করুন। অতিথি অর্ডার চালু আছে।",
                  )}
            </p>
            {!customer.emailVerified && (
              <Button
                secondary
                disabled={busy || delivery.data?.mail?.enabled === false}
                onClick={() =>
                  change(
                    () =>
                      api("/account/verification", {
                        method: "POST",
                        data: {},
                      }),
                    t(
                      "Check your email for a verification link; requests are limited to one per minute.",
                      "যাচাইয়ের লিংকের জন্য ইমেইল দেখুন; প্রতি মিনিটে একবার অনুরোধ করা যায়।",
                    ),
                  )
                }
              >
                {t("Send verification email", "যাচাইয়ের ইমেইল পাঠান")}
              </Button>
            )}
            {delivery.data?.mail?.mode === "outbox" && (
              <p className="commerce-note">
                {t(
                  "Local test mode: emails are saved in the server’s private outbox.",
                  "স্থানীয় টেস্ট মোড: ইমেইল সার্ভারের ব্যক্তিগত আউটবক্সে রাখা হচ্ছে।",
                )}
              </p>
            )}
            {delivery.data?.mail?.enabled === false &&
              !customer.emailVerified && (
                <p className="commerce-note">
                  {t(
                    "Ask the restaurant to configure email delivery.",
                    "ইমেইল পাঠানোর ব্যবস্থা চালু করতে রেস্টুরেন্টকে বলুন।",
                  )}
                </p>
              )}
          </article>
          <div className="account-member-grid">
            <article className="commerce-wine-card">
              <Wallet size={28} />
              <span>{t("Your loyalty points", "আপনার লয়্যালটি পয়েন্ট")}</span>
              <strong className="points-total">
                {loyalty.data?.points ?? customer.points}
              </strong>
              {(loyalty.data?.points ?? customer.points) < 0 && (
                <p>
                  {t(
                    "Points from a refunded purchase were already spent. Future earnings will clear this balance before points can be redeemed again.",
                    "ফেরত দেওয়া অর্ডারের পয়েন্ট আগে ব্যবহার হয়েছে। ভবিষ্যতের পয়েন্টে এই বাকি সমন্বয় হওয়ার পরে আবার ব্যবহার করতে পারবেন।",
                  )}
                </p>
              )}
              <p>
                {t(
                  "Earn 1 point for every BDT 100 of your food after discounts and excluding tax, once the whole table bill is paid. Each point is worth BDT 1.",
                  "ছাড়ের পরে ও কর বাদে আপনার খাবারের প্রতি ১০০ টাকায় ১ পয়েন্ট পাবেন, পুরো টেবিলের বিল পরিশোধ হলে। ১ পয়েন্টের মূল্য ১ টাকা।",
                )}
              </p>
              <Link to="/orders">
                {t(
                  "Use benefits on my table bill",
                  "টেবিলের বিলে সুবিধা ব্যবহার করুন",
                )}
              </Link>
            </article>
            <form
              className="commerce-card commerce-form"
              onSubmit={(event) => {
                event.preventDefault();
                void change(
                  () => api("/account", { method: "PATCH", data: profile }),
                  t("Profile updated.", "প্রোফাইল আপডেট হয়েছে।"),
                );
              }}
            >
              <h2>{t("Your details", "আপনার তথ্য")}</h2>
              <label>
                {t("Name", "নাম")}
                <input
                  required
                  minLength={2}
                  maxLength={80}
                  value={profile.name}
                  onChange={(event) =>
                    setProfile({ ...profile, name: event.target.value })
                  }
                />
              </label>
              <label>
                {t("Phone", "ফোন")}
                <input
                  type="tel"
                  maxLength={25}
                  value={profile.phone}
                  onChange={(event) =>
                    setProfile({ ...profile, phone: event.target.value })
                  }
                />
              </label>
              <Button className="button-small" type="submit" disabled={busy}>
                {t("Save details", "তথ্য সংরক্ষণ")}
              </Button>
            </form>
          </div>
          <section className="commerce-card">
            <h2>
              <Gift size={21} />
              {t("Offers for your next table", "পরের বারের জন্য অফার")}
            </h2>
            {offers.error && (
              <ErrorMessage onRetry={offers.reload}>
                {offers.error.message}
              </ErrorMessage>
            )}
            <div className="coupon-grid">
              {offers.data?.coupons.map((offer) => (
                <article key={offer.code}>
                  <span>
                    {offer.kind === "percent"
                      ? offer.value / 100 + "%"
                      : money(offer.value / 100)}{" "}
                    {t("off", "ছাড়")}
                  </span>
                  <h3>{offer.code}</h3>
                  <p>
                    {t("Food minimum: ", "খাবারের ন্যূনতম দাম: ")}
                    {money(offer.minSpendMinor / 100)}
                  </p>
                  <small>
                    {t("Ends ", "মেয়াদ শেষ ")}
                    {dhakaTime(offer.endsAt, false, language)}
                  </small>
                  <p>
                    {t(
                      "Per-account and total usage limits apply. Apply before bill finalization.",
                      "অ্যাকাউন্ট ও মোট ব্যবহারের সীমা রয়েছে। বিল চূড়ান্ত হওয়ার আগে প্রয়োগ করুন।",
                    )}
                  </p>
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(offer.code)
                        .catch(() => {});
                      notify(t("Coupon: ", "কুপন: ") + offer.code);
                    }}
                  >
                    {t("Copy code", "কোড কপি করুন")}
                  </Button>
                </article>
              ))}
            </div>
            {offers.data?.coupons.length === 0 && (
              <p className="commerce-note">
                {t(
                  "Current offers will appear here when the restaurant publishes them.",
                  "রেস্টুরেন্ট অফার প্রকাশ করলে এখানে দেখা যাবে।",
                )}
              </p>
            )}
          </section>
          <AccountHistory key={customer.id} />
          <div className="account-member-grid">
            <section className="commerce-card">
              <h2>{t("Points activity", "পয়েন্টের হিসাব")}</h2>
              {loyalty.error && (
                <ErrorMessage onRetry={loyalty.reload}>
                  {loyalty.error.message}
                </ErrorMessage>
              )}
              <ul className="points-ledger">
                {loyalty.data?.ledger.map((entry) => (
                  <li key={entry.id}>
                    <div>
                      <span>{entry.reason}</span>
                      <small>{dhakaTime(entry.at, false, language)}</small>
                    </div>
                    <strong>
                      {entry.delta > 0 ? "+" : ""}
                      {entry.delta}
                    </strong>
                  </li>
                ))}
              </ul>
              {loyalty.data?.ledger.length === 0 && (
                <p className="commerce-note">
                  {t(
                    "Points activity appears after a redemption or a settled member order.",
                    "পয়েন্ট ব্যবহার বা সদস্যের অর্ডারের বিল পরিশোধ হলে এখানে হিসাব আসবে।",
                  )}
                </p>
              )}
            </section>
            <form
              className="commerce-card commerce-form"
              onSubmit={(event) => {
                event.preventDefault();
                void change(
                  async () => {
                    await api("/account/password", {
                      method: "POST",
                      data: passwords,
                    });
                    setPasswords({ currentPassword: "", newPassword: "" });
                  },
                  t(
                    "Password changed. Other devices were signed out.",
                    "পাসওয়ার্ড বদলেছে। অন্য ডিভাইস থেকে সাইন আউট হয়েছে।",
                  ),
                );
              }}
            >
              <h2>
                <ShieldCheck size={20} />
                {t("Change password", "পাসওয়ার্ড পরিবর্তন")}
              </h2>
              <label>
                {t("Current password", "বর্তমান পাসওয়ার্ড")}
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={passwords.currentPassword}
                  onChange={(event) =>
                    setPasswords({
                      ...passwords,
                      currentPassword: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                {t("New password", "নতুন পাসওয়ার্ড")}
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={passwords.newPassword}
                  onChange={(event) =>
                    setPasswords({
                      ...passwords,
                      newPassword: event.target.value,
                    })
                  }
                />
              </label>
              <Button
                secondary
                type="submit"
                className="button-small"
                disabled={busy}
              >
                {t("Update password", "পাসওয়ার্ড বদলান")}
              </Button>
            </form>
          </div>
        </>
      )}
    </section>
  );
}

function AccountHistory() {
  const { t, money, language, cart, replaceCart, setCartOpen } = useApp();
  const [cursor, setCursor] = useState(""),
    [rows, setRows] = useState([]),
    [proposal, setProposal] = useState(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const resource = useResource(
    "/account/history" +
      (cursor ? "?before=" + encodeURIComponent(cursor) : ""),
  );
  useEffect(() => {
    if (resource.data)
      setRows((previous) =>
        cursor
          ? [
              ...new Map(
                [...previous, ...resource.data.orders].map((row) => [
                  row.id,
                  row,
                ]),
              ).values(),
            ]
          : resource.data.orders,
      );
  }, [resource.data, cursor]);
  async function reorder(order) {
    setBusy(order.id);
    setError("");
    try {
      const result = await api("/account/orders/" + order.id + "/reorder", {
        method: "POST",
        data: {},
      });
      setProposal(result);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="commerce-card">
      <div className="commerce-section-heading">
        <h2>
          <History size={21} />
          {t("Dining history", "অর্ডারের ইতিহাস")}
        </h2>
        <Button
          secondary
          className="button-small"
          onClick={() => {
            if (cursor) setCursor("");
            else void resource.reload();
          }}
        >
          <RefreshCw size={14} />
          {t("Refresh", "রিফ্রেশ")}
        </Button>
      </div>
      {(error || resource.error) && (
        <ErrorMessage>{error || resource.error.message}</ErrorMessage>
      )}
      <div className="history-grid">
        {rows.map((order) => (
          <article key={order.id}>
            <div>
              <h3>{order.code}</h3>
              <Status status={order.status} />
            </div>
            <small>
              {dhakaTime(order.createdAt, false, language)} ·{" "}
              {t("Table ", "টেবিল ")}
              {order.tableNumber.slice(1)}
            </small>
            <p>
              {order.items
                .map(
                  (item) =>
                    item.quantity +
                    "× " +
                    (language === "bn" ? item.nameBn || item.name : item.name),
                )
                .join(" · ")}
            </p>
            <strong>{money(order.total)}</strong>
            <div className="commerce-inline-actions">
              <Button
                secondary
                className="button-small"
                to={"/orders?order=" + order.id}
              >
                {t("View order", "অর্ডার দেখুন")}
              </Button>
              <Button
                className="button-small"
                disabled={busy !== null}
                onClick={() => reorder(order)}
              >
                {t("Order again", "আবার অর্ডার করুন")}
              </Button>
            </div>
          </article>
        ))}
      </div>
      {resource.loading && <Loading />}
      {!resource.loading && !rows.length && (
        <EmptyState
          title={t(
            "Your next favourite is waiting.",
            "আপনার পরের পছন্দের অপেক্ষায়।",
          )}
          text={t(
            "Member orders and history claimed from this browser appear here.",
            "অ্যাকাউন্টের অর্ডার ও এই ব্রাউজারের আগের অর্ডার এখানে দেখা যাবে।",
          )}
        />
      )}
      {resource.data?.next && (
        <Button
          secondary
          className="button-small"
          onClick={() => setCursor(resource.data.next)}
        >
          {t("Older orders", "পুরোনো অর্ডার")}
        </Button>
      )}
      {proposal && (
        <Modal
          open
          onClose={() => setProposal(null)}
          title={t("Review your reorder", "আবার অর্ডার করার আগে দেখুন")}
        >
          <div className="commerce-form">
            <p>
              {t(
                "We checked current prices, sizes, add-ons and availability. Review the cart before placing a new order.",
                "বর্তমান দাম, পরিমাণ, অতিরিক্ত পদ ও স্টক যাচাই করা হয়েছে। নতুন অর্ডার দেওয়ার আগে কার্ট দেখুন।",
              )}
            </p>
            {proposal.warnings.map((warning, index) => (
              <p className="commerce-note" key={index}>
                {warning}
              </p>
            ))}
            <p>
              {proposal.items.length} {t("available selections", "উপলব্ধ খাবার")}
            </p>
            {cart.length > 0 && (
              <p>
                {t(
                  "This will replace your current cart after you confirm.",
                  "নিশ্চিত করলে বর্তমান কার্টের বদলে এই খাবারগুলো রাখা হবে।",
                )}
              </p>
            )}
            <Button
              disabled={!proposal.items.length}
              onClick={() => {
                replaceCart(proposal.items, proposal.note || "");
                setProposal(null);
                setCartOpen(true);
              }}
            >
              {t("Use these items and review cart", "এই খাবার নিয়ে কার্ট দেখুন")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
