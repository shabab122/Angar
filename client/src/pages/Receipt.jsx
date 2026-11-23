import { branchUrl } from "../lib/branch";
import { useParams } from "react-router-dom";
import { CheckCircle2, Printer } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { useResource } from "../lib/useResource";
import { dhakaTime } from "../lib/api";
import { Button, ErrorMessage, Loading, Logo } from "../components/UI";
import { PaymentLedger } from "../components/Financial";

export function Receipt({ staff = false, bill: provided, thermal = false }) {
  const { id } = useParams();
  const { t, money, name, language } = useApp();
  const resource = useResource(
    staff ? "/staff/bills/" + id : "/receipts/" + id,
    { enabled: !provided },
  );
  const bill = provided || resource.data?.bill;
  if (!bill)
    return (
      <div className="container receipt-page">
        {resource.error ? (
          <ErrorMessage>{resource.error.message}</ErrorMessage>
        ) : (
          <Loading />
        )}
      </div>
    );
  return (
    <section className="receipt-page">
      <article className="receipt-sheet">
        <Logo />
        <span className="receipt-kicker">
          {bill.fulfillmentId
            ? t("ORDER RECEIPT", "অর্ডারের রসিদ")
            : t("TABLE RECEIPT", "টেবিলের রসিদ")}
        </span>
        <h1>{bill.receiptNo}</h1>
        {bill.invoice && (
          <div className="invoice-business">
            <strong>{bill.invoice.businessName}</strong>
            <p>{bill.invoice.address}</p>
            {(bill.invoice.phone || bill.invoice.email) && (
              <p>
                {[bill.invoice.phone, bill.invoice.email]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            {bill.invoice.taxRegistration && (
              <p>
                {t("Tax registration: ", "কর নিবন্ধন: ")}
                {bill.invoice.taxRegistration}
              </p>
            )}
          </div>
        )}
        <div className="receipt-meta">
          <span>
            {bill.fulfillmentId
              ? bill.fulfillmentCode
              : t("Table ", "টেবিল ") + bill.tableNumber.slice(1)}
          </span>
          <span>{dhakaTime(bill.createdAt, false, language)}</span>
        </div>
        <table className="receipt-table">
          <thead>
            <tr>
              <th>{t("Item", "খাবার")}</th>
              <th>{t("Qty", "পরিমাণ")}</th>
              <th>{t("Amount", "দাম")}</th>
            </tr>
          </thead>
          <tbody>
            {bill.items.map((item, index) => (
              <tr key={index}>
                <td>
                  {name(item)}
                  {item.variant && <small>{item.variant.name}</small>}
                  {item.addons?.length > 0 && (
                    <small>
                      {item.addons.map((addon) => addon.name).join(", ")}
                    </small>
                  )}
                </td>
                <td>{item.quantity}</td>
                <td>{money(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="receipt-totals">
          <div>
            <dt>{t("Food subtotal", "খাবারের মোট")}</dt>
            <dd>{money(bill.subtotal)}</dd>
          </div>
          {bill.discount > 0 && (
            <div>
              <dt>{t("Coupon / loyalty discount", "কুপন / পয়েন্টের ছাড়")}</dt>
              <dd>−{money(bill.discount)}</dd>
            </div>
          )}
          <div>
            <dt>
              {t("Service charge", "সার্ভিস চার্জ")} (
              {bill.serviceChargeBps / 100}%)
            </dt>
            <dd>{money(bill.charge)}</dd>
          </div>
          {bill.tax > 0 && (
            <div>
              <dt>
                {bill.taxLabel} ({bill.taxRateBps / 100}%)
                {bill.taxIncluded ? t(" · included", " · অন্তর্ভুক্ত") : ""}
              </dt>
              <dd>{money(bill.tax)}</dd>
            </div>
          )}
          {bill.deliveryFee > 0 && (
            <div>
              <dt>{t("Delivery fee", "ডেলিভারি ফি")}</dt>
              <dd>{money(bill.deliveryFee)}</dd>
            </div>
          )}
          <div className="receipt-grand">
            <dt>{t("Total", "মোট")}</dt>
            <dd>{money(bill.total)}</dd>
          </div>
        </dl>
        <p className={"receipt-status " + bill.status}>
          <CheckCircle2 size={17} />
          {bill.status === "paid"
            ? t("Paid", "পরিশোধিত")
            : t("Balance remains", "বাকি টাকা রয়েছে")}
          {bill.payment && <span> · {bill.payment.method}</span>}
        </p>
        {bill.payment?.reference && (
          <p className="receipt-reference">
            {t("Payment reference", "পেমেন্ট রেফারেন্স")} {bill.payment.reference}
          </p>
        )}
        {bill.balanceMinor > 0 && (
          <p className="receipt-reference">
            {t("Paid / remaining: ", "পরিশোধিত / বাকি: ")}
            {money(bill.paidMinor / 100)} / {money(bill.balanceMinor / 100)}
          </p>
        )}
        <PaymentLedger bill={bill} />
        {bill.refundedMinor > 0 && (
          <p className="receipt-reference">
            {t("Refunded / retained: ", "ফেরত / রাখা হয়েছে: ")}
            {money(bill.refundedMinor / 100)} /{" "}
            {money(bill.netCollectedMinor / 100)}
          </p>
        )}
        <p className="receipt-thanks">
          {bill.invoice?.footer ||
            t(
              "Thank you for sharing your table with us.",
              "আমাদের সঙ্গে সময় কাটানোর জন্য ধন্যবাদ।",
            )}
        </p>
        <div className="receipt-print">
          <Button secondary onClick={() => window.print()}>
            <Printer size={16} />
            {t("Print receipt", "রসিদ প্রিন্ট করুন")}
          </Button>
          {staff && !thermal && (
            <a
              className="button button-secondary"
              target="_blank"
              rel="noreferrer"
              href={branchUrl("/staff/receipt/" + bill.id + "/thermal")}
            >
              80 mm thermal receipt
            </a>
          )}
        </div>
      </article>
    </section>
  );
}
