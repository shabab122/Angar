import { useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api } from "../lib/api";
import { Button, ErrorMessage, Eyebrow } from "../components/UI";

export function AccountAction() {
  const { t, reloadCustomer } = useApp();
  const [link] = useState(() => {
    const values = new URLSearchParams(window.location.hash.slice(1));
    const result = {
      purpose: values.get("purpose"),
      token: values.get("token"),
    };
    // Tokens stay out of request URLs, referrers and browser history.
    window.history.replaceState(null, "", window.location.pathname);
    return result;
  });
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const valid =
    ["verify", "reset"].includes(link.purpose) &&
    /^[A-Za-z0-9_-]{43}$/.test(link.token || "");
  async function submit(event) {
    event.preventDefault();
    setError("");
    if (link.purpose === "reset" && password !== confirmation) {
      setError(t("Passwords do not match.", "দুটি পাসওয়ার্ড মিলছে না।"));
      return;
    }
    setBusy(true);
    try {
      await api(
        link.purpose === "verify"
          ? "/account/verify-email"
          : "/account/reset-password",
        {
          method: "POST",
          data: {
            token: link.token,
            ...(link.purpose === "reset" ? { newPassword: password } : {}),
          },
        },
      );
      setPassword("");
      setConfirmation("");
      setDone(true);
      await reloadCustomer();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="container commerce-page payment-page">
      <Eyebrow>{t("YOUR ANGAR ACCOUNT", "আপনার আঙার অ্যাকাউন্ট")}</Eyebrow>
      <article className="commerce-card">
        <h2>
          <ShieldCheck size={24} />
          {link.purpose === "reset"
            ? t("Choose a new password", "নতুন পাসওয়ার্ড দিন")
            : t("Verify your email", "ইমেইল যাচাই করুন")}
        </h2>
        {done ? (
          <>
            <p>
              {link.purpose === "reset"
                ? t(
                    "Password updated. Sign in again using your new password.",
                    "পাসওয়ার্ড আপডেট হয়েছে। নতুন পাসওয়ার্ড দিয়ে আবার প্রবেশ করুন।",
                  )
                : t(
                    "Your email address is verified.",
                    "আপনার ইমেইল যাচাই হয়েছে।",
                  )}
            </p>
            <Link className="button" to="/account">
              {t("Return to my account", "অ্যাকাউন্টে ফিরুন")}
            </Link>
          </>
        ) : !valid ? (
          <ErrorMessage>
            {t(
              "This link is incomplete. Open the full link from your email or request a new one.",
              "লিংকটি অসম্পূর্ণ। ইমেইলের সম্পূর্ণ লিংক খুলুন বা নতুন লিংক নিন।",
            )}
          </ErrorMessage>
        ) : (
          <form className="commerce-form" onSubmit={submit}>
            <p>
              {t(
                "This link can be used once. Confirm below to continue.",
                "লিংকটি একবার ব্যবহার করা যাবে। নিচে নিশ্চিত করুন।",
              )}
            </p>
            {link.purpose === "reset" && (
              <>
                <label>
                  {t("New password", "নতুন পাসওয়ার্ড")}
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <label>
                  {t("Confirm new password", "নতুন পাসওয়ার্ড আবার দিন")}
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
                <small>
                  {t("Use at least 12 characters.", "অন্তত ১২ অক্ষর দিন।")}
                </small>
              </>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy
                ? t("Please wait…", "অপেক্ষা করুন…")
                : link.purpose === "reset"
                  ? t("Save new password", "নতুন পাসওয়ার্ড সংরক্ষণ")
                  : t("Confirm email verification", "ইমেইল যাচাই নিশ্চিত করুন")}
            </Button>
          </form>
        )}
      </article>
    </section>
  );
}
