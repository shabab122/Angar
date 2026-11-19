import { useEffect, useRef, useState } from "react";
import { CalendarDays, Clock3, MapPin, Users } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime, localDate, requestKey } from "../lib/api";
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

const nextDay = () =>
  new Date(new Date(localDate() + "T12:00:00Z").getTime() + 86400000)
    .toISOString()
    .slice(0, 10);
export function Reservations() {
  const { t, customer, language, notify } = useApp();
  const options = useResource("/reservations/options"),
    own = useResource("/reservations", { interval: 15000 }),
    waiting = useResource("/waitlist", { interval: 6000 });
  const [form, setForm] = useState({
    name: customer?.name || "",
    phone: customer?.phone || "",
    partySize: 2,
    note: "",
    date: nextDay(),
    time: "",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(null),
    [cancel, setCancel] = useState(null),
    [reason, setReason] = useState("");
  const retry = useRef(null);
  const availability = useResource(
    "/reservations/availability?" +
      new URLSearchParams({ date: form.date, partySize: form.partySize }),
    { enabled: form.date.length === 10 && form.partySize > 0 },
  );
  useEffect(() => {
    if (customer)
      setForm((value) => ({
        ...value,
        name: value.name || customer.name,
        phone: value.phone || customer.phone,
      }));
  }, [customer?.id]);
  useEffect(() => {
    if (
      availability.data &&
      !availability.data.slots.some(
        (slot) => slot.time === form.time && slot.available,
      )
    )
      setForm((value) => ({
        ...value,
        time:
          availability.data.slots.find((slot) => slot.available)?.time || "",
      }));
  }, [availability.data, form.time]);
  async function book(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const signature = JSON.stringify(form);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: requestKey() };
    try {
      const result = await api("/reservations", {
        method: "POST",
        data: {
          ...form,
          partySize: Number(form.partySize),
          requestKey: retry.current.key,
        },
      });
      setConfirmed(result.reservation);
      retry.current = null;
      await own.reload();
      await availability.reload();
    } catch (failure) {
      setError(failure.message);
      await availability.reload();
    } finally {
      setBusy(false);
    }
  }
  async function join() {
    setBusy(true);
    setError("");
    try {
      await api("/waitlist", {
        method: "POST",
        data: {
          name: form.name,
          phone: form.phone,
          partySize: Number(form.partySize),
          note: form.note,
        },
      });
      await waiting.reload();
      notify(
        t("You joined the waiting list.", "আপনি অপেক্ষার তালিকায় যুক্ত হয়েছেন।"),
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function cancelBooking(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/reservations/" + cancel.id + "/cancel", {
        method: "POST",
        data: { reason },
      });
      setCancel(null);
      await own.reload();
      await availability.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="container commerce-page reservations-page">
      <div className="page-heading">
        <Eyebrow>{t("SAVE YOUR SEAT", "আপনার আসন রাখুন")}</Eyebrow>
        <h1>
          {t("A table for", "আপনার জন্য")}{" "}
          <em>{t("your people.", "একটি টেবিল।")}</em>
        </h1>
        <p>
          {t(
            "Choose a time, bring your people, and we’ll keep a place for you.",
            "সময় বেছে নিন, প্রিয়জনদের নিয়ে আসুন—আপনার জন্য জায়গা থাকবে।",
          )}
        </p>
      </div>
      <div className="reservation-grid">
        <aside className="commerce-wine-card">
          <CalendarDays size={31} />
          <h2>
            {t("Make room for good company.", "ভালো সঙ্গের জন্য জায়গা রাখুন।")}
          </h2>
          <p>
            <Clock3 size={16} />
            {options.data
              ? options.data.open + "–" + options.data.close
              : "12:00–22:30"}{" "}
            · {t("Bangladesh time", "বাংলাদেশ সময়")}
          </p>
          <p>
            <Users size={16} />
            {options.data?.durationMinutes || 90}{" "}
            {t("minute seating slots", "মিনিটের সময়সীমা")}
          </p>
          <p>
            <MapPin size={16} />
            {t("Dhanmondi, Dhaka", "ধানমন্ডি, ঢাকা")}
          </p>
          <small>
            {t(
              "Bookings are confirmed only after availability is checked. Scan your table QR after staff seats you to order.",
              "টেবিলের প্রাপ্যতা যাচাই করেই বুকিং নিশ্চিত হয়। স্টাফ বসতে দেওয়ার পর টেবিলের QR স্ক্যান করে অর্ডার করুন।",
            )}
          </small>
        </aside>
        <form className="commerce-card commerce-form" onSubmit={book}>
          <h2>{t("Reserve a table", "টেবিল বুক করুন")}</h2>
          <div className="commerce-two">
            <label>
              {t("Name", "নাম")}
              <input
                required
                minLength={2}
                maxLength={80}
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
            </label>
            <label>
              {t("Contact phone", "যোগাযোগের নম্বর")}
              <input
                required
                type="tel"
                maxLength={25}
                value={form.phone}
                onChange={(event) =>
                  setForm({ ...form, phone: event.target.value })
                }
              />
            </label>
          </div>
          <div className="commerce-two">
            <label>
              {t("Party size", "অতিথির সংখ্যা")}
              <input
                required
                type="number"
                min="1"
                max="30"
                value={form.partySize}
                onChange={(event) =>
                  setForm({
                    ...form,
                    partySize:
                      event.target.value === ""
                        ? ""
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              {t("Date", "তারিখ")}
              <input
                required
                type="date"
                min={localDate()}
                value={form.date}
                onChange={(event) =>
                  setForm({ ...form, date: event.target.value })
                }
              />
            </label>
          </div>
          <label>
            {t("Available time", "ফাঁকা সময়")}
            <select
              required
              value={form.time}
              onChange={(event) =>
                setForm({ ...form, time: event.target.value })
              }
            >
              <option value="">
                {availability.loading
                  ? t("Checking…", "যাচাই হচ্ছে…")
                  : t("Choose a slot", "সময় বেছে নিন")}
              </option>
              {availability.data?.slots.map((slot) => (
                <option
                  key={slot.time}
                  value={slot.time}
                  disabled={!slot.available}
                >
                  {slot.time}
                  {slot.available ? "" : t(" · Unavailable", " · ফাঁকা নেই")}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Seating note (optional)", "বসার বিষয়ে নোট (ঐচ্ছিক)")}
            <textarea
              maxLength={200}
              value={form.note}
              onChange={(event) =>
                setForm({ ...form, note: event.target.value })
              }
            />
          </label>
          {(error || availability.error || options.error) && (
            <ErrorMessage>
              {error || availability.error?.message || options.error?.message}
            </ErrorMessage>
          )}
          <Button
            type="submit"
            disabled={busy || !form.time || options.data?.enabled === false}
          >
            {busy
              ? t("Checking your table…", "আপনার টেবিল যাচাই হচ্ছে…")
              : t("Confirm my reservation", "আমার বুকিং নিশ্চিত করুন")}
          </Button>
          {!waiting.data?.entry && (
            <Button
              secondary
              disabled={busy || !form.name || !form.phone}
              onClick={join}
            >
              {t(
                "At the restaurant? Join today’s waiting list",
                "রেস্টুরেন্টে এসেছেন? আজকের অপেক্ষার তালিকায় যুক্ত হন",
              )}
            </Button>
          )}
        </form>
      </div>
      {confirmed && (
        <div className="booking-confirmation" role="status">
          <CalendarDays size={24} />
          <div>
            <strong>
              {t("Reservation confirmed", "বুকিং নিশ্চিত")}: {confirmed.code}
            </strong>
            <p>
              {dhakaTime(confirmed.startsAt, false, language)} ·{" "}
              {t("Table ", "টেবিল ")}
              {confirmed.tableNumber.slice(1)} · {confirmed.partySize}{" "}
              {t("guests", "জন")}
            </p>
          </div>
        </div>
      )}
      {waiting.data?.entry && (
        <section className="commerce-card">
          <h2>{t("Your place in line", "অপেক্ষার তালিকায় আপনার অবস্থান")}</h2>
          <div className="waitlist-guest-status">
            <strong>#{waiting.data.position}</strong>
            <div>
              <Status status={waiting.data.entry.status} />
              <p>
                {waiting.data.entry.partySize}{" "}
                {t(
                  "guests · Staff will call your party when a suitable table is ready.",
                  "জন · উপযুক্ত টেবিল প্রস্তুত হলে স্টাফ আপনাদের ডাকবেন।",
                )}
              </p>
            </div>
          </div>
          <Button
            secondary
            className="button-small"
            onClick={async () => {
              try {
                await api("/waitlist/" + waiting.data.entry.id + "/cancel", {
                  method: "POST",
                  data: {},
                });
                await waiting.reload();
              } catch (failure) {
                setError(failure.message);
              }
            }}
          >
            {t("Leave waiting list", "অপেক্ষার তালিকা থেকে বের হন")}
          </Button>
        </section>
      )}
      <section className="commerce-card">
        <h2>{t("Your reservations", "আপনার বুকিং")}</h2>
        {own.error && (
          <ErrorMessage onRetry={own.reload}>{own.error.message}</ErrorMessage>
        )}
        {own.loading ? (
          <Loading />
        ) : own.data?.reservations.length ? (
          <div className="history-grid">
            {own.data.reservations.map((row) => (
              <article key={row.id}>
                <div>
                  <h3>{row.code}</h3>
                  <Status status={row.status} />
                </div>
                <p>{dhakaTime(row.startsAt, false, language)}</p>
                <p>
                  {t("Table ", "টেবিল ")}
                  {row.tableNumber.slice(1)} · {row.partySize}{" "}
                  {t("guests", "জন")}
                </p>
                {row.status === "confirmed" &&
                  new Date(row.startsAt) > new Date() && (
                    <Button
                      secondary
                      className="button-small"
                      onClick={() => {
                        setCancel(row);
                        setReason("");
                        setError("");
                      }}
                    >
                      {t("Cancel reservation", "বুকিং বাতিল করুন")}
                    </Button>
                  )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={CalendarDays}
            title={t(
              "Your table plans will appear here.",
              "আপনার বুকিং এখানে দেখা যাবে।",
            )}
            text={t(
              "Guest bookings stay in this browser; signing in keeps them with your account.",
              "অতিথির বুকিং এই ব্রাউজারে থাকবে; সাইন ইন করলে অ্যাকাউন্টে সংরক্ষিত হবে।",
            )}
          />
        )}
      </section>
      {cancel && (
        <Modal
          open
          onClose={() => setCancel(null)}
          title={t("Cancel this reservation", "এই বুকিং বাতিল করুন")}
        >
          <form className="commerce-form" onSubmit={cancelBooking}>
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
