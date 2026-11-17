import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check,
  Flower2,
  Sparkles,
  Users,
  Utensils,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, localDate, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Eyebrow, Loading } from "../components/UI";

export function Events() {
  const { t, money, contextReady } = useApp();
  const options = useResource("/events/options");
  const [values, setValues] = useState({
    name: "",
    phone: "",
    type: "family",
    date: "",
    time: "19:00",
    hours: 2,
    guests: 12,
    spaceId: "family-corner",
    packageId: "dhaka-table",
    note: "",
  });
  const [key, setKey] = useState(requestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  function change(event) {
    const { name, value, type } = event.target;
    setValues((previous) => ({
      ...previous,
      [name]: type === "number" ? Number(value) : value,
    }));
  }
  async function submit(event) {
    event.preventDefault();
    if (!contextReady) return;
    setBusy(true);
    setError("");
    try {
      await api("/events", {
        method: "POST",
        data: { ...values, requestKey: key },
      });
      setKey(requestKey());
      navigate("/orders?tab=events");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="events-page">
      <section className="events-hero">
        <img
          src="/assets/dining-room.webp"
          alt={t(
            "A warm setting for a private event",
            "ব্যক্তিগত আয়োজনের সুন্দর পরিবেশ",
          )}
        />
        <div className="container">
          <Eyebrow light>
            {t(
              "THE OCCASIONS THAT BRING US TOGETHER",
              "যে আয়োজন আমাদের একসঙ্গে আনে",
            )}
          </Eyebrow>
          <h1>
            {t("Your people.", "আপনার আপনজন।")}
            <br />
            <em>{t("Our place.", "আমাদের আয়োজন।")}</em>
          </h1>
          <p>
            {t(
              "A birthday, a team dinner, a reason to gather. We’ll help make it feel like yours.",
              "জন্মদিন, টিমের ডিনার বা একসঙ্গে হওয়ার উপলক্ষ। আপনার মতো করে সাজাতে আমরা পাশে থাকব।",
            )}
          </p>
          <a className="button button-gold" href="#event-request">
            {t("Let’s plan your gathering", "আপনার আয়োজনের কথা বলুন")}
            <ArrowRight size={17} />
          </a>
        </div>
      </section>
      <section className="container event-intro">
        <div>
          <Eyebrow>{t("A LITTLE MORE PERSONAL", "আরও একটু আপনার মতো")}</Eyebrow>
          <h2>
            {t("An occasion deserves", "আপনার আয়োজনে থাকুক")}
            <br />
            <em>{t("its own kind of table.", "নিজস্ব এক টেবিল।")}</em>
          </h2>
        </div>
        <p>
          {t(
            "Choose a corner for your closest people or take the full dining room. Share your date, guest count and a few wishes. Our team will review availability and send a clear, personal quote.",
            "প্রিয়জনদের জন্য একটি অংশ বা পুরো ডাইনিং রুম বেছে নিন। তারিখ, অতিথির সংখ্যা ও পছন্দ জানান। প্রাপ্যতা দেখে টিম একটি বিস্তারিত মূল্যপ্রস্তাব পাঠাবে।",
          )}
        </p>
      </section>
      <div className="container event-benefits">
        {[
          [Users, "Space to gather", "একসঙ্গে হওয়ার জায়গা"],
          [Utensils, "A menu made for you", "আপনার পছন্দের মেনু"],
          [Flower2, "Thoughtful little details", "আয়োজনে ছোট ছোট যত্ন"],
        ].map(([Icon, en, bn]) => (
          <div key={en}>
            <span>
              <Icon size={25} strokeWidth={1.4} />
            </span>
            <h3>{t(en, bn)}</h3>
          </div>
        ))}
      </div>
      <section className="container event-packages">
        <div className="section-heading">
          <div>
            <Eyebrow>
              {t("START WITH SOMETHING GOOD", "পছন্দের খাবার দিয়ে শুরু")}
            </Eyebrow>
            <h2>
              {t("A taste of", "আয়োজনের")}{" "}
              <em>{t("the possibilities.", "কিছু ধারণা।")}</em>
            </h2>
          </div>
          <span className="muted">
            {t(
              "Illustrative packages. Your quote confirms the details.",
              "নমুনা প্যাকেজ। চূড়ান্ত তথ্য মূল্যপ্রস্তাবে থাকবে।",
            )}
          </span>
        </div>
        {options.loading ? (
          <Loading />
        ) : options.error ? (
          <ErrorMessage onRetry={options.reload}>
            {options.error.message}
          </ErrorMessage>
        ) : (
          <div className="package-grid">
            {options.data.packages.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={
                  "package-card" +
                  (values.packageId === item.id ? " selected" : "")
                }
                onClick={() => setValues({ ...values, packageId: item.id })}
              >
                <span className="package-number">0{index + 1}</span>
                <Sparkles size={24} />
                <h3>{item.name}</h3>
                <p>{item.description}</p>
                <div>
                  <strong>
                    {item.perGuest
                      ? money(item.perGuest)
                      : t("Let’s talk", "আলোচনা করুন")}
                  </strong>
                  <small>
                    {item.perGuest
                      ? t("starting / guest", "থেকে / জন")
                      : t("A tailored menu", "আপনার পছন্দের মেনু")}
                  </small>
                  <span className="package-check">
                    {values.packageId === item.id ? (
                      <Check size={16} />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="container event-request-section" id="event-request">
        <aside>
          <Eyebrow>{t("TELL US YOUR PLAN", "আপনার পরিকল্পনা জানান")}</Eyebrow>
          <h2>
            {t("Let’s make it", "আয়োজন হোক")}
            <br />
            <em>{t("an occasion.", "মনে রাখার মতো।")}</em>
          </h2>
          <p>
            {t(
              "We’ll review the date, menu and space before confirming anything. You can follow your request and review the quote in My gatherings.",
              "নিশ্চিত করার আগে তারিখ, মেনু ও স্পেস যাচাই করা হবে। আমার আয়োজনে অনুরোধের অবস্থা ও মূল্যপ্রস্তাব দেখতে পারবেন।",
            )}
          </p>
          <div className="event-process">
            {[
              "Tell us the occasion",
              "Review your quote",
              "Bring your people",
            ].map((text, index) => (
              <div key={text}>
                <span>0{index + 1}</span>
                <strong>
                  {t(
                    text,
                    [
                      "আয়োজনের কথা জানান",
                      "মূল্যপ্রস্তাব দেখুন",
                      "আপনজনদের নিয়ে আসুন",
                    ][index],
                  )}
                </strong>
              </div>
            ))}
          </div>
          <Link className="text-link" to="/orders?tab=events">
            {t("Already sent a request?", "আগে অনুরোধ দিয়েছেন?")}
            <ArrowRight size={17} />
          </Link>
        </aside>
        <form className="event-request-form form-stack" onSubmit={submit}>
          <div className="form-grid">
            <label>
              {t("Your name", "আপনার নাম")}
              <input
                name="name"
                autoComplete="name"
                required
                minLength={2}
                maxLength={70}
                value={values.name}
                onChange={change}
              />
            </label>
            <label>
              {t("Contact number", "যোগাযোগের নম্বর")}
              <input
                name="phone"
                type="tel"
                autoComplete="tel"
                required
                minLength={10}
                maxLength={22}
                value={values.phone}
                onChange={change}
              />
            </label>
          </div>
          <div className="form-grid">
            <label>
              {t("Occasion", "অনুষ্ঠান")}
              <select name="type" value={values.type} onChange={change}>
                <option value="family">
                  {t("Family gathering", "পারিবারিক আয়োজন")}
                </option>
                <option value="birthday">{t("Birthday", "জন্মদিন")}</option>
                <option value="corporate">
                  {t("Team / corporate", "টিম / কর্পোরেট")}
                </option>
                <option value="celebration">
                  {t("Other celebration", "অন্য অনুষ্ঠান")}
                </option>
              </select>
            </label>
            <label>
              {t("Number of guests", "অতিথির সংখ্যা")}
              <input
                type="number"
                name="guests"
                required
                min="8"
                max={values.spaceId === "family-corner" ? 20 : 60}
                value={values.guests}
                onChange={change}
              />
            </label>
          </div>
          <div className="form-grid three">
            <label>
              {t("Preferred date", "পছন্দের তারিখ")}
              <input
                name="date"
                type="date"
                required
                min={localDate()}
                value={values.date}
                onChange={change}
              />
            </label>
            <label>
              {t("Start time", "শুরুর সময়")}
              <input
                name="time"
                type="time"
                required
                min="12:00"
                max="21:59"
                value={values.time}
                onChange={change}
              />
            </label>
            <label>
              {t("Duration (hours)", "সময় (ঘণ্টা)")}
              <input
                name="hours"
                type="number"
                required
                min="1"
                max="5"
                value={values.hours}
                onChange={change}
              />
            </label>
          </div>
          <label>
            {t("Your space", "পছন্দের স্পেস")}
            <select name="spaceId" value={values.spaceId} onChange={change}>
              <option value="family-corner">
                {t(
                  "The family corner · up to 20 guests",
                  "ফ্যামিলি কর্নার · সর্বোচ্চ ২০ জন",
                )}
              </option>
              <option value="dining-room">
                {t(
                  "The dining room · up to 60 guests",
                  "পুরো ডাইনিং রুম · সর্বোচ্চ ৬০ জন",
                )}
              </option>
            </select>
          </label>
          <label>
            {t("Menu inspiration", "মেনুর পছন্দ")}
            <select name="packageId" value={values.packageId} onChange={change}>
              {(options.data?.packages || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Anything we should know?", "আর কিছু জানাতে চান?")}
            <textarea
              name="note"
              rows="3"
              maxLength={600}
              value={values.note}
              onChange={change}
              placeholder={t(
                "Menu preferences, setup ideas, or special requests…",
                "মেনুর পছন্দ, সাজানোর ধারণা বা বিশেষ অনুরোধ…",
              )}
            />
          </label>
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <button
            type="submit"
            className="button button-primary button-wide"
            disabled={busy || !contextReady}
          >
            {busy
              ? t("Sending your request…", "অনুরোধ পাঠানো হচ্ছে…")
              : t("Send gathering request", "ইভেন্টের অনুরোধ পাঠান")}
            <ArrowRight size={17} />
          </button>
          <p className="form-help">
            {t(
              "A request is reviewed by our team. Your event is confirmed after you accept the quote and complete any required deposit.",
              "টিম অনুরোধ যাচাই করবে। মূল্যপ্রস্তাবে সম্মতি ও প্রযোজ্য অগ্রিমের পর ইভেন্ট নিশ্চিত হবে।",
            )}
          </p>
        </form>
      </section>
    </div>
  );
}
