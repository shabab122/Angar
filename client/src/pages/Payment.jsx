import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CreditCard, RefreshCw } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Eyebrow, Loading } from "../components/UI";
import { BillSummary, PaymentLedger } from "../components/Financial";

export function Payment() {
  const { t, reloadCustomer } = useApp(),
    [params] = useSearchParams();
  const id = params.get("transaction") || "",
    billId = params.get("bill") || "";
  const valid = /^AK[a-f0-9]{24}$/.test(id) && /^[a-f0-9]{24}$/.test(billId);
  const payment = useResource("/online-payments/" + id, {
    enabled: valid,
    interval: 5000,
  });
  const bill = useResource("/bills/" + billId, {
    enabled: valid,
    interval: 5000,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function recheck() {
    setBusy(true);
    setError("");
    try {
      await api("/online-payments/" + id + "/reconcile", {
        method: "POST",
        data: {},
      });
      await payment.reload();
      await bill.reload();
      await reloadCustomer();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const status = payment.data?.transaction.status;
  const heading =
    status === "paid"
      ? t("Payment verified.", "পেমেন্ট যাচাই হয়েছে।")
      : status === "failed"
        ? t("Payment not completed.", "পেমেন্ট সম্পন্ন হয়নি।")
        : ["review", "overpayment_review"].includes(status)
          ? t("Payment needs review.", "পেমেন্ট পর্যালোচনা প্রয়োজন।")
          : t("Checking your payment.", "আপনার পেমেন্ট যাচাই হচ্ছে।");
  return (
    <section className="container commerce-page payment-page">
      <div className="page-heading">
        <Eyebrow>{t("YOUR PAYMENT", "আপনার পেমেন্ট")}</Eyebrow>
        <h1>{heading}</h1>
        <p>
          {t(
            "The bill updates after the payment provider confirms the transaction.",
            "পেমেন্ট প্রদানকারীর নিশ্চিতকরণের পর বিল আপডেট হয়।",
          )}
        </p>
      </div>
      {!valid ? (
        <ErrorMessage>
          {t("This payment link is invalid.", "এই পেমেন্ট লিংক সঠিক নয়।")}
        </ErrorMessage>
      ) : (
        <section className="commerce-card">
          <CreditCard size={28} />
          {(error || payment.error || bill.error) && (
            <ErrorMessage>
              {error || payment.error?.message || bill.error?.message}
            </ErrorMessage>
          )}
          {payment.loading && <Loading />}
          {payment.data?.transaction.message && (
            <p className="commerce-note">{payment.data.transaction.message}</p>
          )}
          {bill.data && (
            <>
              <BillSummary bill={bill.data.bill} />
              <PaymentLedger bill={bill.data.bill} />
            </>
          )}
          <div className="commerce-inline-actions">
            <Button secondary onClick={recheck} disabled={busy || !valid}>
              <RefreshCw size={15} />
              {t("Recheck provider status", "পেমেন্টের অবস্থা আবার দেখুন")}
            </Button>
            <Button to="/orders">
              {t("Back to my orders", "আমার অর্ডারে ফিরুন")}
            </Button>
          </div>
        </section>
      )}
    </section>
  );
}
