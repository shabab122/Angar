import { useParams } from "react-router-dom";
import { CheckCircle2, Printer } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { useResource } from "../lib/useResource";
import { dhakaTime } from "../lib/api";
import { Button, ErrorMessage, Loading, Logo } from "../components/UI";

export function Receipt({ staff = false, bill: provided }) {
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
          {t("TABLE RECEIPT", "টেবিলের রসিদ")}
        </span>
        <h1>{bill.receiptNo}</h1>
        <div className="receipt-meta">
          <span>{t("Table ", "টেবিল ") + bill.tableNumber.slice(1)}</span>
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
          <div>
            <dt>
              {t("Service charge", "সার্ভিস চার্জ")} (
              {bill.serviceChargeBps / 100}%)
            </dt>
            <dd>{money(bill.charge)}</dd>
          </div>
          <div className="receipt-grand">
            <dt>{t("Total", "মোট")}</dt>
            <dd>{money(bill.total)}</dd>
          </div>
        </dl>
        <p className={"receipt-status " + bill.status}>
          <CheckCircle2 size={17} />
          {bill.status === "paid"
            ? t("Paid at the restaurant", "রেস্টুরেন্টে পরিশোধিত")
            : t("Payment pending at the counter", "কাউন্টারে পরিশোধের অপেক্ষায়")}
          {bill.payment && <span> · {bill.payment.method}</span>}
        </p>
        {bill.payment?.reference && (
          <p className="receipt-reference">
            {t("Payment reference", "পেমেন্ট রেফারেন্স")} {bill.payment.reference}
          </p>
        )}
        <p className="receipt-thanks">
          {t(
            "Thank you for sharing your table with us.",
            "আমাদের সঙ্গে সময় কাটানোর জন্য ধন্যবাদ।",
          )}
        </p>
        <div className="receipt-print">
          <Button secondary onClick={() => window.print()}>
            <Printer size={16} />
            {t("Print receipt", "রসিদ প্রিন্ট করুন")}
          </Button>
        </div>
      </article>
    </section>
  );
}
