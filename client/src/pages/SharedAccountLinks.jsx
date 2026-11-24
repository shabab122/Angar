import { useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { Button, ErrorMessage } from "../components/UI";
export default function SharedAccountLinks() {
  const branches = useResource("/branches"),
    { reloadCustomer, notify, t } = useApp(),
    [branchId, setBranchId] = useState(""),
    [currentPassword, setCurrentPassword] = useState(""),
    [branchPassword, setBranchPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/account/link-branch", {
        method: "POST",
        data: { branchId, currentPassword, branchPassword },
      });
      setCurrentPassword("");
      setBranchPassword("");
      await reloadCustomer();
      window.dispatchEvent(new Event("angar:refresh"));
      notify(
        t(
          "Branch account linked. Points and history are now shared.",
          "ব্রাঞ্চ অ্যাকাউন্ট যুক্ত হয়েছে। পয়েন্ট ও ইতিহাস এখন একসঙ্গে পাবেন।",
        ),
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="commerce-card">
      <h2>{t("One account across branches", "সব ব্রাঞ্চে একই অ্যাকাউন্ট")}</h2>
      <p>
        {t(
          "Your sign-in and points work in every branch. If you previously had a separate branch account with this email, link it using both passwords. Existing balances transfer once; old order records stay intact.",
          "আপনার লগইন ও পয়েন্ট সব ব্রাঞ্চে ব্যবহার করতে পারবেন। একই ইমেইলে আগে আলাদা ব্রাঞ্চ অ্যাকাউন্ট থাকলে দুই অ্যাকাউন্টের পাসওয়ার্ড দিয়ে যুক্ত করুন। আগের পয়েন্ট একবারই যুক্ত হবে এবং অর্ডারের রেকর্ড থাকবে।",
        )}
      </p>
      <form className="commerce-form" onSubmit={submit}>
        <label>
          {t("Previous account branch", "আগের অ্যাকাউন্টের ব্রাঞ্চ")}
          <select
            aria-label="Legacy account branch"
            required
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">Choose branch</option>
            {branches.data?.branches.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Current shared-account password", "বর্তমান অ্যাকাউন্টের পাসওয়ার্ড")}
          <input
            aria-label="Shared account password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label>
          {t(
            "Previous branch-account password",
            "আগের ব্রাঞ্চ অ্যাকাউন্টের পাসওয়ার্ড",
          )}
          <input
            aria-label="Legacy branch account password"
            type="password"
            autoComplete="off"
            required
            maxLength={128}
            value={branchPassword}
            onChange={(e) => setBranchPassword(e.target.value)}
          />
        </label>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <Button type="submit" disabled={busy}>
          {busy
            ? "Linking…"
            : t(
                "Link branch history & points",
                "ব্রাঞ্চের ইতিহাস ও পয়েন্ট যুক্ত করুন",
              )}
        </Button>
      </form>
    </section>
  );
}
