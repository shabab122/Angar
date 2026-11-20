import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CreditCard,
  Gift,
  ReceiptText,
  RefreshCw,
  Split,
  Wallet,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "./UI";

export function minorAmount(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const [whole, decimal = ""] = String(value).split(".");
  const minor = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function BillSummary({ bill }) {
  const { money, t } = useApp();
  return (
    <div className="commerce-bill-summary">
      <div>
        <span>{t("Food subtotal", "খাবারের মোট")}</span>
        <strong>{money(bill.subtotal)}</strong>
      </div>
      {bill.discount > 0 && (
        <div>
          <span>
            {t("Coupon / points", "কুপন / পয়েন্ট")}
            {bill.couponCode ? " · " + bill.couponCode : ""}
          </span>
          <strong>−{money(bill.discount)}</strong>
        </div>
      )}
      <div>
        <span>{t("Service charge", "সার্ভিস চার্জ")}</span>
        <strong>{money(bill.charge)}</strong>
      </div>
      {bill.deliveryFee > 0 && (
        <div>
          <span>{t("Delivery fee", "ডেলিভারি ফি")}</span>
          <strong>{money(bill.deliveryFee)}</strong>
        </div>
      )}
      {bill.tax > 0 && (
        <div>
          <span>
            {bill.taxLabel} ({bill.taxRateBps / 100}%)
            {bill.taxIncluded ? t(" · included", " · অন্তর্ভুক্ত") : ""}
          </span>
          <strong>{money(bill.tax)}</strong>
        </div>
      )}
      <div className="commerce-grand">
        <span>{t("Final total", "চূড়ান্ত মোট")}</span>
        <strong>{money(bill.total)}</strong>
      </div>
      <div>
        <span>{t("Received", "পরিশোধিত")}</span>
        <strong>{money(bill.paidMinor / 100)}</strong>
      </div>
      <div>
        <span>{t("Remaining balance", "বাকি টাকা")}</span>
        <strong>{money(bill.balanceMinor / 100)}</strong>
      </div>
      {bill.reservedMinor > 0 && (
        <p className="commerce-note">
          {t(
            "An online payment is pending for ",
            "অনলাইন পেমেন্ট যাচাইয়ের অপেক্ষায়: ",
          )}
          {money(bill.reservedMinor / 100)}.{" "}
          {t(
            "Recheck its status before paying that amount again.",
            "একই টাকা আবার দেওয়ার আগে পেমেন্টের অবস্থা দেখুন।",
          )}
        </p>
      )}
      {bill.refundedMinor > 0 && (
        <>
          <div>
            <span>{t("Refunded", "ফেরত দেওয়া হয়েছে")}</span>
            <strong>{money(bill.refundedMinor / 100)}</strong>
          </div>
          <div>
            <span>{t("Retained after refunds", "ফেরতের পরে রাখা হয়েছে")}</span>
            <strong>{money(bill.netCollectedMinor / 100)}</strong>
          </div>
        </>
      )}
    </div>
  );
}
export function PaymentLedger({ bill }) {
  const { t, money, language } = useApp();
  return (
    <div className="payment-ledger">
      {bill.splits?.length > 0 && (
        <>
          <h3>{t("Bill splits", "বিলের ভাগ")}</h3>
          <div className="commerce-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Person / share", "ব্যক্তি / ভাগ")}</th>
                  <th>{t("Total", "মোট")}</th>
                  <th>{t("Paid", "দেওয়া হয়েছে")}</th>
                  <th>{t("Remaining", "বাকি")}</th>
                </tr>
              </thead>
              <tbody>
                {bill.splits.map((part) => (
                  <tr key={part.id}>
                    <td>{part.label}</td>
                    <td>{money(part.amountMinor / 100)}</td>
                    <td>{money(part.paidMinor / 100)}</td>
                    <td>{money((part.amountMinor - part.paidMinor) / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {bill.payments?.length > 0 && (
        <>
          <h3>{t("Payment history", "পেমেন্টের ইতিহাস")}</h3>
          <ul>
            {bill.payments.map((payment) => (
              <li key={payment.id}>
                <div>
                  <strong>{payment.method}</strong>
                  {payment.splitId && (
                    <small>
                      {
                        bill.splits.find((part) => part.id === payment.splitId)
                          ?.label
                      }
                    </small>
                  )}
                  <small>
                    {dhakaTime(payment.at, false, language)}
                    {payment.reference ? " · " + payment.reference : ""}
                  </small>
                </div>
                <strong>{money(payment.amountMinor / 100)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {bill.refunds?.length > 0 && (
        <>
          <h3>{t("Refunds & credit notes", "ফেরত ও ক্রেডিট নোট")}</h3>
          <ul>
            {bill.refunds.map((refund) => (
              <li key={refund.id}>
                <div>
                  <strong>{refund.creditNote?.number || refund.id}</strong>
                  <small>
                    {refund.method} · {dhakaTime(refund.at, false, language)}
                  </small>
                </div>
                <strong>−{money(refund.amountMinor / 100)}</strong>
              </li>
            ))}
          </ul>
          <p className="commerce-note">
            {t(
              "The original payment history remains unchanged. These confirmed refunds reduce the retained amount.",
              "মূল পেমেন্টের ইতিহাস অপরিবর্তিত আছে। নিশ্চিত ফেরত অনুযায়ী রাখা টাকা কমেছে।",
            )}
          </p>
        </>
      )}
    </div>
  );
}

function SplitEditor({ bill, onUpdated }) {
  const [mode, setMode] = useState("equal"),
    [count, setCount] = useState(2);
  const [parts, setParts] = useState([
    { label: "Person 1", amount: "" },
    { label: "Person 2", amount: "" },
  ]);
  const [assignments, setAssignments] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function resize(value) {
    const n = Math.max(2, Math.min(12, Number(value) || 2));
    setCount(n);
    setParts(
      Array.from(
        { length: n },
        (_, index) =>
          parts[index] || { label: "Person " + (index + 1), amount: "" },
      ),
    );
    setAssignments({});
  }
  useEffect(() => {
    if (mode === "items") {
      const next = {};
      for (const item of bill.items)
        for (let i = 0; i < count; i++)
          next[item.lineId + ":" + i] =
            Math.floor(item.quantity / count) +
            (i < item.quantity % count ? 1 : 0);
      setAssignments(next);
    }
  }, [mode, count]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const rows = ["customer", "none"].includes(mode)
        ? []
        : parts.map((part, index) => ({
            label: part.label,
            ...(mode === "amount"
              ? { amountMinor: minorAmount(part.amount) }
              : {}),
            ...(mode === "items"
              ? {
                  lines: bill.items.flatMap((item) =>
                    Number(assignments[item.lineId + ":" + index] || 0)
                      ? [
                          {
                            lineId: item.lineId,
                            quantity: Number(
                              assignments[item.lineId + ":" + index],
                            ),
                          },
                        ]
                      : [],
                  ),
                }
              : {}),
          }));
      const result = await api("/staff/bills/" + bill.id + "/splits", {
        method: "POST",
        data: { mode, expectedRevision: bill.revision, parts: rows },
      });
      onUpdated(result.bill);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="commerce-form split-editor" onSubmit={submit}>
      <h3>
        <Split size={18} />
        Split this bill
      </h3>
      <p className="commerce-note">
        Set the shares before the first receipt or online checkout. Every paisa
        stays in the table total.
      </p>
      <label>
        Split method
        <select
          aria-label="Split method"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="equal">Equal shares</option>
          <option value="customer">By ordering customer / device</option>
          <option value="amount">Custom amounts</option>
          <option value="items">By item quantities</option>
          <option value="none">Remove splits</option>
        </select>
      </label>
      {!["customer", "none"].includes(mode) && (
        <>
          <label>
            Number of shares
            <input
              type="number"
              min="2"
              max="12"
              value={count}
              onChange={(event) => resize(event.target.value)}
            />
          </label>
          <div className="split-labels">
            {parts.map((part, index) => (
              <div key={index}>
                <label>
                  Share {index + 1}
                  <input
                    aria-label={"Share label " + (index + 1)}
                    required
                    maxLength={40}
                    value={part.label}
                    onChange={(event) =>
                      setParts(
                        parts.map((row, i) =>
                          i === index
                            ? { ...row, label: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                {mode === "amount" && (
                  <label>
                    Amount (BDT)
                    <input
                      aria-label={"Amount for share " + (index + 1)}
                      required
                      inputMode="decimal"
                      value={part.amount}
                      onChange={(event) =>
                        setParts(
                          parts.map((row, i) =>
                            i === index
                              ? { ...row, amount: event.target.value }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {mode === "items" && (
        <div className="commerce-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Item / ordered quantity</th>
                {parts.map((part, index) => (
                  <th key={index}>{part.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bill.items.map((item) => (
                <tr key={item.lineId}>
                  <td>
                    {item.name} · {item.quantity}×
                    <small>{item.variant?.name}</small>
                  </td>
                  {parts.map((part, index) => (
                    <td key={index}>
                      <input
                        className="split-quantity"
                        aria-label={item.name + " share " + (index + 1)}
                        type="number"
                        min="0"
                        max={item.quantity}
                        value={assignments[item.lineId + ":" + index] || 0}
                        onChange={(event) =>
                          setAssignments({
                            ...assignments,
                            [item.lineId + ":" + index]: event.target.value,
                          })
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <Button type="submit" className="button-small" disabled={busy}>
        Save bill splits
      </Button>
    </form>
  );
}

export function CounterBillDialog({ bill: initial, onClose, onDone }) {
  const { money } = useApp();
  const resource = useResource("/staff/bills/" + initial.id, {
    interval: 4000,
  });
  const [bill, setBill] = useState(initial),
    [splitting, setSplitting] = useState(false);
  const [splitId, setSplitId] = useState(initial.splits?.[0]?.id || ""),
    [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash"),
    [reference, setReference] = useState(""),
    [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const retry = useRef(null);
  useEffect(() => {
    if (resource.data?.bill && resource.data.bill.revision >= bill.revision)
      setBill(resource.data.bill);
  }, [resource.data, bill.revision]);
  useEffect(() => {
    if (bill.splits?.length && !bill.splits.some((part) => part.id === splitId))
      setSplitId(bill.splits[0].id);
    if (!bill.splits?.length && splitId) setSplitId("");
  }, [bill.splits, splitId]);
  const available = bill.splits?.length
    ? bill.splits.find((part) => part.id === splitId)?.availableMinor || 0
    : bill.availableMinor;
  useEffect(() => {
    setAmount((available / 100).toFixed(2));
    setVerified(false);
  }, [available, splitId]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const payload = {
      method,
      reference,
      verified,
      amountMinor: minorAmount(amount),
      ...(splitId ? { splitId } : {}),
    };
    const signature = JSON.stringify(payload);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: requestKey() };
    try {
      const result = await api("/staff/bills/" + bill.id + "/pay", {
        method: "POST",
        data: { ...payload, requestKey: retry.current.key },
      });
      setBill(result.bill);
      setVerified(false);
      setReference("");
      retry.current = null;
      await resource.reload();
      onDone(result.bill);
    } catch (failure) {
      setError(failure.message);
      await resource.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={
        bill.fulfillmentId
          ? bill.fulfillmentCode + " · Payment"
          : "Table " + bill.tableNumber.slice(1) + " · Payments & splits"
      }
      className="commerce-bill-dialog"
    >
      <BillSummary bill={bill} />
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {bill.status === "finalized" && (
        <>
          {!bill.fulfillmentId && (
            <>
              <div className="commerce-inline-actions">
                <Button
                  secondary
                  className="button-small"
                  onClick={() => setSplitting(!splitting)}
                  disabled={bill.paidMinor > 0 || bill.reservedMinor > 0}
                >
                  <Split size={15} />
                  {splitting ? "Hide split editor" : "Set / change splits"}
                </Button>
              </div>
              {splitting && (
                <SplitEditor
                  bill={bill}
                  onUpdated={(next) => {
                    setBill(next);
                    setSplitId(next.splits[0]?.id || "");
                    setSplitting(false);
                    void resource.reload();
                  }}
                />
              )}
            </>
          )}
          <form className="commerce-form" onSubmit={submit}>
            <h3>
              <Wallet size={18} />
              Record money received
            </h3>
            {bill.splits?.length > 0 && (
              <label>
                Paying share
                <select
                  aria-label="Paying share"
                  value={splitId}
                  onChange={(event) => setSplitId(event.target.value)}
                >
                  {bill.splits.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.label} · {money(part.availableMinor / 100)}{" "}
                      available
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="commerce-two">
              <label>
                Amount received (BDT)
                <input
                  required
                  inputMode="decimal"
                  readOnly={Boolean(bill.fulfillmentId)}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <label>
                Payment method
                <select
                  aria-label="Payment method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                >
                  <option value="cash">Cash</option>
                  <option value="bkash">bKash at counter</option>
                  <option value="nagad">Nagad at counter</option>
                  <option value="card">Card terminal</option>
                </select>
              </label>
            </div>
            <label>
              Payment reference{method === "cash" ? " (optional)" : ""}
              <input
                maxLength={100}
                required={method !== "cash"}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
            <label className="commerce-checkbox">
              <input
                type="checkbox"
                required
                checked={verified}
                onChange={(event) => setVerified(event.target.checked)}
              />
              <span>
                I verified this amount was received at the restaurant.
              </span>
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button
              type="submit"
              disabled={
                busy || !verified || available <= 0 || !minorAmount(amount)
              }
            >
              {busy ? "Recording…" : "Record this payment"}
            </Button>
            <p className="commerce-note">
              {bill.fulfillmentId
                ? "Record the full payment after verifying the money was received. Handover is completed separately in the pickup/delivery desk."
                : "The table stays open until the remaining balance is zero. Online reserved amounts must be reconciled before paying them again."}
            </p>
          </form>
        </>
      )}
      <PaymentLedger bill={bill} />
    </Modal>
  );
}

export function OnlinePaymentForm({ bill }) {
  const { t, customer, money } = useApp();
  const options = useResource("/payments/options");
  const [splitId, setSplitId] = useState(bill.splits?.[0]?.id || ""),
    [amount, setAmount] = useState("");
  const [details, setDetails] = useState({
    name: customer?.name || "",
    email: customer?.email || "",
    phone: customer?.phone || "",
    consent: false,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(null);
  const retry = useRef(null);
  useEffect(() => {
    if (customer)
      setDetails((previous) => ({
        ...previous,
        name: previous.name || customer.name,
        email: previous.email || customer.email,
        phone: previous.phone || customer.phone,
      }));
  }, [customer?.id]);
  useEffect(() => {
    if (bill.splits?.length && !bill.splits.some((part) => part.id === splitId))
      setSplitId(bill.splits[0].id);
    if (!bill.splits?.length && splitId) setSplitId("");
  }, [bill.splits, splitId]);
  const available = bill.splits?.length
    ? bill.splits.find((part) => part.id === splitId)?.availableMinor || 0
    : bill.availableMinor;
  useEffect(() => {
    setAmount((available / 100).toFixed(2));
  }, [available, splitId]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const payload = {
      amountMinor: minorAmount(amount),
      ...(splitId ? { splitId } : {}),
      ...details,
    };
    const signature = JSON.stringify(payload);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: requestKey() };
    try {
      const result = await api("/bills/" + bill.id + "/online-payments", {
        method: "POST",
        data: { ...payload, requestKey: retry.current.key },
      });
      setAttempt(result.transaction);
      if (result.transaction.checkoutUrl)
        window.location.assign(result.transaction.checkoutUrl);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (bill.status !== "finalized") return null;
  if (options.loading) return <Loading />;
  if (!options.data?.enabled)
    return (
      <p className="commerce-note">
        {t(
          "Online checkout is currently unavailable. Please pay at the counter.",
          "অনলাইন পেমেন্ট এখন চালু নেই। কাউন্টারে পরিশোধ করুন।",
        )}
      </p>
    );
  return (
    <form className="commerce-form online-payment-form" onSubmit={submit}>
      <h3>
        <CreditCard size={18} />
        {t("Pay with SSLCOMMERZ", "SSLCOMMERZ দিয়ে পরিশোধ")}
      </h3>
      {options.data.mode === "sandbox" && (
        <span className="soft-badge">
          {t(
            "Sandbox · test payments only",
            "Sandbox · শুধু পরীক্ষামূলক পেমেন্ট",
          )}
        </span>
      )}
      {bill.splits?.length > 0 && (
        <label>
          {t("Your share", "আপনার ভাগ")}
          <select
            aria-label={t("Your share", "আপনার ভাগ")}
            value={splitId}
            onChange={(event) => setSplitId(event.target.value)}
          >
            {bill.splits.map((part) => (
              <option key={part.id} value={part.id}>
                {part.label} · {money(part.availableMinor / 100)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t("Amount to pay (BDT)", "পরিশোধের পরিমাণ (টাকা)")}
        <input
          inputMode="decimal"
          required
          readOnly={Boolean(bill.fulfillmentId)}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>
      {[
        ["name", t("Receipt name", "রসিদের নাম"), "text", 50],
        ["email", t("Receipt email", "রসিদের ইমেইল"), "email", 50],
        ["phone", t("Contact phone", "যোগাযোগের নম্বর"), "tel", 25],
      ].map(([field, label, type, max]) => (
        <label key={field}>
          {label}
          <input
            required
            type={type}
            maxLength={max}
            value={details[field]}
            onChange={(event) =>
              setDetails({ ...details, [field]: event.target.value })
            }
          />
        </label>
      ))}
      <label className="commerce-checkbox">
        <input
          type="checkbox"
          required
          checked={details.consent}
          onChange={(event) =>
            setDetails({ ...details, consent: event.target.checked })
          }
        />
        <span>
          {t(
            "Send these receipt details to SSLCOMMERZ to process my payment.",
            "পেমেন্ট প্রক্রিয়ার জন্য এই রসিদের তথ্য SSLCOMMERZ-এ পাঠাতে সম্মতি দিচ্ছি।",
          )}
        </span>
      </label>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {attempt && !attempt.checkoutUrl && (
        <p className="commerce-note">
          {t(
            "This attempt needs a status check. Please ask the cashier before retrying.",
            "এই পেমেন্টের অবস্থা যাচাই প্রয়োজন। আবার দেওয়ার আগে ক্যাশিয়ারকে জানান।",
          )}
        </p>
      )}
      <Button
        type="submit"
        disabled={
          busy || available <= 0 || !details.consent || !minorAmount(amount)
        }
      >
        {busy
          ? t("Opening checkout…", "পেমেন্ট খুলছে…")
          : t("Continue to secure checkout", "নিরাপদ পেমেন্টে যান")}
      </Button>
    </form>
  );
}

export function GuestTableBill() {
  const { t, table, customer, reloadCustomer, money } = useApp();
  const resource = useResource("/table/bill", {
    enabled: Boolean(table?.active),
    interval: 4000,
  });
  const [couponCode, setCouponCode] = useState(""),
    [points, setPoints] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const preview = resource.data?.preview,
    bill = resource.data?.bill;
  useEffect(() => {
    if (preview) {
      setCouponCode(preview.couponCode);
      setPoints(preview.loyaltyPoints);
    }
  }, [preview?.couponCode, preview?.loyaltyPoints]);
  async function apply(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/table/promotions", {
        method: "POST",
        data: { couponCode, loyaltyPoints: Number(points) },
      });
      await resource.reload();
      await reloadCustomer();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (!table?.active || (!preview && !bill)) return null;
  return (
    <section className="commerce-card guest-table-bill">
      <header>
        <ReceiptText size={22} />
        <div>
          <h2>{t("Your table bill", "আপনার টেবিলের বিল")}</h2>
          <p>
            {t(
              "One table balance, with flexible ways to pay.",
              "এক টেবিলের বিল, সুবিধামতো ভাগ করে পরিশোধ।",
            )}
          </p>
        </div>
      </header>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {bill ? (
        <>
          <BillSummary bill={bill} />
          <PaymentLedger bill={bill} />
          <OnlinePaymentForm bill={bill} />
        </>
      ) : (
        <>
          <div className="commerce-preview-total">
            <span>{t("Estimated table total", "টেবিলের আনুমানিক মোট")}</span>
            <strong>{money(preview.totalMinor / 100)}</strong>
          </div>
          <p className="commerce-note">
            {t(
              "The cashier finalizes the bill after all orders are served. Choose benefits before finalization.",
              "সব অর্ডার পরিবেশন হলে ক্যাশিয়ার বিল চূড়ান্ত করবেন। তার আগে কুপন ও পয়েন্ট বেছে নিন।",
            )}
          </p>
          {preview.promotionError && (
            <ErrorMessage>{preview.promotionError}</ErrorMessage>
          )}
          {customer ? (
            <form className="commerce-form" onSubmit={apply}>
              <h3>
                <Gift size={18} />
                {t("Member benefits", "সদস্যের সুবিধা")}
              </h3>
              <p className="commerce-note">
                {t("Available points: ", "ব্যবহারযোগ্য পয়েন্ট: ")}
                {customer.points}.{" "}
                {t(
                  "1 point = BDT 1; redeem up to 20% after the coupon discount.",
                  "১ পয়েন্ট = ১ টাকা; কুপন ছাড়ের পর সর্বোচ্চ ২০% ব্যবহার করা যায়।",
                )}
              </p>
              <div className="commerce-two">
                <label>
                  {t("Coupon code", "কুপন কোড")}
                  <input
                    maxLength={30}
                    value={couponCode}
                    disabled={!preview.canChangePromotion}
                    onChange={(event) =>
                      setCouponCode(event.target.value.toUpperCase())
                    }
                  />
                </label>
                <label>
                  {t("Points to redeem", "ব্যবহার করবেন যত পয়েন্ট")}
                  <input
                    type="number"
                    min="0"
                    max={Math.max(0, customer.points)}
                    value={points}
                    disabled={!preview.canChangePromotion}
                    onChange={(event) => setPoints(event.target.value)}
                  />
                </label>
              </div>
              {error && <ErrorMessage>{error}</ErrorMessage>}
              <Button
                type="submit"
                className="button-small"
                disabled={busy || !preview.canChangePromotion}
              >
                {t("Apply member benefits", "কুপন ও পয়েন্ট প্রয়োগ করুন")}
              </Button>
              {!preview.canChangePromotion && (
                <p className="commerce-note">
                  {t(
                    "Another member selected this table’s benefits. Ask the cashier to clear them if needed.",
                    "অন্য সদস্য এই টেবিলের সুবিধা বেছে নিয়েছেন। প্রয়োজন হলে ক্যাশিয়ারকে তা সরাতে বলুন।",
                  )}
                </p>
              )}
            </form>
          ) : (
            <p className="commerce-note">
              <Link to="/account">{t("Sign in", "সাইন ইন করুন")}</Link>
              {t(
                " to use coupons and loyalty points. Guest ordering stays available.",
                " কুপন ও পয়েন্ট ব্যবহার করতে। অ্যাকাউন্ট ছাড়াও অর্ডার করা যায়।",
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
