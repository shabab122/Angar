import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, CheckCheck, Smartphone } from "lucide-react";
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
} from "../components/UI";

function applicationKey(value) {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
export function Notifications() {
  const { t, language, notify } = useApp(),
    preferences = useResource("/notifications/preferences"),
    inbox = useResource("/notifications", { interval: 5000 });
  const [values, setValues] = useState(null),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [phone, setPhone] = useState(""),
    [code, setCode] = useState("");
  useEffect(() => {
    if (preferences.data && !dirty)
      setValues({ ...preferences.data.preferences, language });
  }, [preferences.data, dirty, language]);
  async function run(task, message) {
    setBusy(true);
    setError("");
    try {
      await task();
      setDirty(false);
      await preferences.reload();
      await inbox.reload();
      notify(message);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function enablePush() {
    if (
      !("Notification" in window) ||
      !("serviceWorker" in navigator) ||
      !window.isSecureContext
    )
      throw new Error(
        t(
          "Push notifications need a supported browser on HTTPS or localhost.",
          "পুশ নোটিফিকেশনের জন্য সমর্থিত ব্রাউজার ও HTTPS বা localhost প্রয়োজন।",
        ),
      );
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error(
        t(
          "Notifications were not permitted. You can change this in browser settings.",
          "নোটিফিকেশনের অনুমতি পাওয়া যায়নি। ব্রাউজার সেটিংসে এটি বদলাতে পারবেন।",
        ),
      );
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription)
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationKey(
          preferences.data.providers.publicKey,
        ),
      });
    await api("/notifications/push", {
      method: "POST",
      data: subscription.toJSON(),
    });
  }
  if (!values)
    return (
      <section className="container commerce-page">
        {preferences.error ? (
          <ErrorMessage onRetry={preferences.reload}>
            {preferences.error.message}
          </ErrorMessage>
        ) : (
          <Loading />
        )}
      </section>
    );
  return (
    <section className="container commerce-page notification-page">
      <div className="page-heading">
        <Eyebrow>{t("KEEP IN TOUCH", "আপডেট সঙ্গে রাখুন")}</Eyebrow>
        <h1>
          {t("A little", "একটু")} <em>{t("heads-up.", "খবর।")}</em>
        </h1>
        <p>
          {t(
            "Choose updates for your orders, reservations and waiting-list calls.",
            "আপনার অর্ডার, বুকিং ও অপেক্ষার তালিকার জন্য আপডেট বেছে নিন।",
          )}
        </p>
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="commerce-settings-grid">
        <form
          className="commerce-card commerce-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                api("/notifications/preferences", {
                  method: "PATCH",
                  data: Object.fromEntries(
                    ["inApp", "email", "sms", "push", "language"].map((key) => [
                      key,
                      values[key],
                    ]),
                  ),
                }),
              t("Alert preferences saved.", "আপডেটের পছন্দ সংরক্ষিত হয়েছে।"),
            );
          }}
        >
          <h2>
            <Bell size={22} />
            {t("Your preferences", "আপনার পছন্দ")}
          </h2>
          {[
            ["inApp", t("Updates inside this website", "এই ওয়েবসাইটে আপডেট")],
            ["email", t("Email updates", "ইমেইলে আপডেট")],
            ["sms", t("SMS updates", "SMS আপডেট")],
            ["push", t("Browser push updates", "ব্রাউজারে পুশ আপডেট")],
          ].map(([field, label]) => (
            <label className="commerce-checkbox" key={field}>
              <input
                type="checkbox"
                checked={values[field]}
                disabled={
                  busy ||
                  (field === "email" &&
                    (!preferences.data.emailVerified ||
                      !preferences.data.providers.email)) ||
                  (field === "sms" &&
                    (!values.verifiedPhone ||
                      !preferences.data.providers.sms)) ||
                  (field === "push" && !preferences.data.providers.push)
                }
                onChange={(event) => {
                  setDirty(true);
                  setValues({ ...values, [field]: event.target.checked });
                }}
              />
              {label}
            </label>
          ))}
          <p className="commerce-note">
            {preferences.data.emailVerified ? (
              preferences.data.email
            ) : (
              <Link to="/account">
                {t(
                  "Sign in and verify your email for email alerts.",
                  "ইমেইল আপডেটের জন্য প্রবেশ করে ইমেইল যাচাই করুন।",
                )}
              </Link>
            )}
          </p>
          <p className="commerce-note">
            {t(
              "Only new updates after enabling a channel are sent. Reservation reminders arrive about an hour before the booking. Provider submission does not guarantee delivery.",
              "চ্যানেল চালু করার পরের নতুন আপডেট পাঠানো হয়। বুকিংয়ের প্রায় এক ঘণ্টা আগে মনে করানো হয়। প্রেরণ করা মানেই পৌঁছানো নিশ্চিত নয়।",
            )}
          </p>
          <Button type="submit" disabled={busy}>
            {t("Save alert preferences", "আপডেটের পছন্দ সংরক্ষণ")}
          </Button>
        </form>
        <article className="commerce-card commerce-form">
          <h2>
            <Smartphone size={22} />
            {t("Phone & device", "ফোন ও ডিভাইস")}
          </h2>
          {values.verifiedPhone && (
            <p className="commerce-note">
              {t("Verified phone: ", "যাচাইকৃত নম্বর: ")}
              {values.verifiedPhone}
            </p>
          )}
          <label>
            {t("Phone number", "ফোন নম্বর")}
            <input
              type="tel"
              maxLength={25}
              placeholder="+88017XXXXXXXX"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <Button
            secondary
            disabled={busy || !phone || !preferences.data.providers.sms}
            onClick={() =>
              run(
                () =>
                  api("/notifications/phone-code", {
                    method: "POST",
                    data: { phone, consent: true },
                  }),
                t(
                  "A verification code has been queued for your phone.",
                  "আপনার ফোনের যাচাই কোড পাঠানোর জন্য রাখা হয়েছে।",
                ),
              )
            }
          >
            {t("Send phone verification code", "ফোনের যাচাই কোড পাঠান")}
          </Button>
          <label>
            {t("Six-digit code", "ছয় সংখ্যার কোড")}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, ""))
              }
            />
          </label>
          <Button
            secondary
            disabled={busy || code.length !== 6}
            onClick={() =>
              run(
                () =>
                  api("/notifications/phone-verify", {
                    method: "POST",
                    data: { code },
                  }),
                t(
                  "Phone verified. You can now enable SMS updates.",
                  "ফোন যাচাই হয়েছে। এবার SMS আপডেট চালু করতে পারেন।",
                ),
              )
            }
          >
            {t("Verify my phone", "ফোন যাচাই করুন")}
          </Button>
          {!preferences.data.providers.sms && (
            <p className="commerce-note">
              {t(
                "SMS delivery is not available yet.",
                "SMS পাঠানোর ব্যবস্থা এখনও চালু হয়নি।",
              )}
            </p>
          )}
          {preferences.data.providers.smsMode === "outbox" && (
            <p className="commerce-note">
              {t(
                "Local testing: messages go to a private SMS outbox, not a real phone.",
                "স্থানীয় পরীক্ষা: বাস্তব ফোনের বদলে ব্যক্তিগত SMS আউটবক্সে বার্তা রাখা হয়।",
              )}
            </p>
          )}
          <Button
            secondary
            disabled={busy || !preferences.data.providers.push}
            onClick={() =>
              run(
                enablePush,
                t(
                  "Push enabled for this device.",
                  "এই ডিভাইসে পুশ চালু হয়েছে।",
                ),
              )
            }
          >
            {t("Enable push on this device", "এই ডিভাইসে পুশ চালু করুন")}
          </Button>
          <Button
            secondary
            disabled={busy || !("serviceWorker" in navigator)}
            onClick={() =>
              run(
                async () => {
                  const registration =
                    await navigator.serviceWorker.getRegistration("/");
                  const subscription =
                    await registration?.pushManager.getSubscription();
                  if (subscription) {
                    await api("/notifications/push/remove", {
                      method: "POST",
                      data: { endpoint: subscription.endpoint },
                    });
                    await subscription.unsubscribe();
                  }
                },
                t(
                  "Push disabled on this device.",
                  "এই ডিভাইসে পুশ বন্ধ হয়েছে।",
                ),
              )
            }
          >
            {t("Disable push on this device", "এই ডিভাইসে পুশ বন্ধ করুন")}
          </Button>
          <p className="commerce-note">
            {t(
              "Browser permission is required. Alerts may appear on your device lock screen.",
              "ব্রাউজারের অনুমতি প্রয়োজন। ডিভাইসের লক স্ক্রিনেও বার্তা দেখা যেতে পারে।",
            )}
          </p>
        </article>
      </div>
      <section className="commerce-card">
        <div className="commerce-section-heading">
          <h2>{t("Your updates", "আপনার আপডেট")}</h2>
          <Button
            secondary
            className="button-small"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api("/notifications/read", {
                    method: "POST",
                    data: {
                      ids: (inbox.data?.notifications || [])
                        .filter((row) => !row.read)
                        .map((row) => row.id),
                    },
                  }),
                t("Updates marked read.", "আপডেট পড়া হয়েছে বলে চিহ্নিত হয়েছে।"),
              )
            }
          >
            <CheckCheck size={15} />
            {t("Mark read", "পড়া হয়েছে")}
          </Button>
        </div>
        {inbox.error && (
          <ErrorMessage onRetry={inbox.reload}>
            {inbox.error.message}
          </ErrorMessage>
        )}
        <div className="notification-list">
          {inbox.data?.notifications.map((row) => (
            <Link
              key={row.id}
              to={row.href}
              className={row.read ? "is-read" : ""}
            >
              <strong>{row.title}</strong>
              <p>{row.text}</p>
              <small>{dhakaTime(row.createdAt, false, language)}</small>
            </Link>
          ))}
        </div>
        {!inbox.data?.notifications.length && (
          <EmptyState
            icon={Bell}
            title={t("No new updates yet", "এখনও নতুন আপডেট নেই")}
            text={t(
              "New order and reservation updates will appear here.",
              "অর্ডার ও বুকিংয়ের নতুন আপডেট এখানে দেখা যাবে।",
            )}
          />
        )}
      </section>
    </section>
  );
}

export function NotificationLogs() {
  const resource = useResource("/staff/notifications", { interval: 5000 });
  const [job, setJob] = useState(null),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!resource.data && !resource.error) return <Loading />;
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Customer notification delivery</h2>
          <p>
            Only opted-in order/reservation updates. Submitted means provider
            acceptance, not a delivery receipt.
          </p>
        </div>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      <p className="commerce-note">
        Email: {resource.data?.providers.email ? "configured" : "unavailable"} ·
        SMS: {resource.data?.providers.sms ? "configured" : "unavailable"} · Web
        Push: {resource.data?.providers.push ? "configured" : "unavailable"}
      </p>
      <div className="commerce-staff-grid">
        {resource.data?.jobs.map((row) => (
          <article className="commerce-card" key={row.id}>
            <div className="commerce-section-heading">
              <h3>{row.title}</h3>
              <span className="management-status">{row.status}</span>
            </div>
            <p className="commerce-note">
              {row.channel} · {row.recipient} · Attempt {row.attempts}
              <br />
              {dhakaTime(row.createdAt)}
            </p>
            <p>{row.message || "Waiting for the background worker."}</p>
            {row.retryable &&
              ["unknown", "failed"].includes(row.status) &&
              row.attempts < 3 && (
                <Button
                  secondary
                  className="button-small"
                  onClick={() => {
                    setJob(row);
                    setReason("");
                    setConfirmed(false);
                    setError("");
                  }}
                >
                  Review retry
                </Button>
              )}
          </article>
        ))}
      </div>
      {job && (
        <Modal
          open
          title="Review notification retry"
          onClose={() => {
            if (!busy) setJob(null);
          }}
        >
          <form
            className="commerce-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await api("/staff/notifications/" + job.id + "/retry", {
                  method: "POST",
                  data: { confirmed, reason },
                });
                setJob(null);
                await resource.reload();
              } catch (failure) {
                setError(failure.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              A previous send may already have reached the recipient. Check the
              provider before explicitly queuing another copy.
            </p>
            <label>
              Reason
              <textarea
                minLength={3}
                maxLength={160}
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="commerce-checkbox">
              <input
                type="checkbox"
                required
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I reviewed the previous attempt and approve a possible duplicate
              alert.
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              Queue reviewed retry
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
