import { useEffect, useRef, useState } from "react";
import { api, dhakaTime } from "../lib/api";
import { Button, ErrorMessage, Logo } from "../components/UI";
export default function Driver() {
  const [token] = useState(() => {
      return new URLSearchParams(location.hash.slice(1)).get("token") || "";
    }),
    [delivery, setDelivery] = useState(null),
    [error, setError] = useState(""),
    [tracking, setTracking] = useState(false),
    [last, setLast] = useState(""),
    [code, setCode] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    watch = useRef(null),
    sent = useRef(0);
  const headers = { Authorization: "Bearer " + token };
  const stop = () => {
    if (watch.current !== null)
      navigator.geolocation?.clearWatch(watch.current);
    watch.current = null;
    setTracking(false);
  };
  useEffect(() => {
    if (token)
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
    if (!token) {
      setError("Open the private delivery link provided by the restaurant.");
      return;
    }
    void api("/courier/driver", { headers })
      .then((result) => setDelivery(result.delivery))
      .catch((failure) => setError(failure.message));
    return () => {
      if (watch.current !== null)
        navigator.geolocation?.clearWatch(watch.current);
    };
  }, [token]);
  function start() {
    setError("");
    if (!window.isSecureContext || !navigator.geolocation) {
      setError(
        "GPS sharing needs HTTPS or localhost and a browser with location support.",
      );
      return;
    }
    setTracking(true);
    watch.current = navigator.geolocation.watchPosition(
      async (position) => {
        if (Date.now() - sent.current < 5000) return;
        sent.current = Date.now();
        try {
          await api("/courier/driver/location", {
            method: "POST",
            headers,
            data: {
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              accuracy: position.coords.accuracy,
              capturedAt: new Date(position.timestamp).toISOString(),
            },
          });
          setLast(new Date().toISOString());
          setError("");
        } catch (failure) {
          setError(failure.message);
          if (failure.status === 401 || failure.status === 403) stop();
        }
      },
      (failure) => {
        setError(
          failure.code === 1
            ? "Location permission was declined. Enable it in browser settings to share GPS."
            : "GPS could not get a fresh position. Check your connection and device location.",
        );
        stop();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
  }
  async function confirm(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/courier/driver/confirm", {
        method: "POST",
        headers,
        data: { code, note },
      });
      stop();
      setConfirmed(true);
      setCode("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="driver-page">
      <Logo />
      <article className="commerce-card">
        <h1>Delivery staff</h1>
        {confirmed ? (
          <>
            <h2>Delivery confirmed</h2>
            <p>GPS sharing stopped and this private link is now revoked.</p>
          </>
        ) : delivery ? (
          <>
            <h2>{delivery.code}</h2>
            <p>
              Assigned to {delivery.driverName} · Expires{" "}
              {dhakaTime(delivery.expiresAt)}
            </p>
            <h3>Recipient</h3>
            <p>
              {delivery.name} · {delivery.phone}
            </p>
            <p>
              {delivery.address?.line}, {delivery.address?.area}
            </p>
            {delivery.address?.note && <p>{delivery.address.note}</p>}
            <h3>Share live position</h3>
            <p>
              Share your location only for this delivery. The restaurant and
              ordering customer can see your latest signal. Keep this page open;
              background location is not guaranteed by the browser.
            </p>
            <Button onClick={tracking ? stop : start}>
              {tracking ? "Stop GPS sharing" : "Start GPS sharing"}
            </Button>
            {last && <p role="status">Last shared: {dhakaTime(last)}</p>}
            <form className="commerce-form" onSubmit={confirm}>
              <h3>Confirm handover</h3>
              <p>
                Ask the recipient for the six-digit code after handing over the
                food. The restaurant must verify payment separately.
              </p>
              <label>
                Customer delivery code
                <input
                  aria-label="Customer delivery code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <label>
                Handover note (optional)
                <input
                  maxLength={160}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <Button type="submit" disabled={busy}>
                {busy
                  ? "Verifying handover…"
                  : "Confirm delivery with customer code"}
              </Button>
            </form>
          </>
        ) : (
          <p>Checking your private delivery link…</p>
        )}
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </article>
    </main>
  );
}
