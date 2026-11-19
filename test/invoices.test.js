import test from "node:test";
import assert from "node:assert/strict";
import { financialTotals } from "../server/invoices.js";
import { fixture, post, ok, error, key } from "./support.js";

const invoice = {
  businessName: "Angar Test Restaurant",
  address: "Test address, Dhaka",
  phone: "01700000000",
  email: "billing@example.test",
  taxRegistration: "TEST-BIN-ONLY",
  footer: "Thank you for dining with us",
  prefix: "AKV",
  numbering: "sequential",
};
const tax = {
  enabled: true,
  label: "VAT",
  rateBps: 1000,
  mode: "exclusive",
  base: "food_and_service",
};
async function configure(f, override = {}, expectedRevision = 0) {
  return post(f.staff.admin, "/api/staff/invoice-settings", {
    tax,
    invoice,
    expectedRevision,
    reason: "Test billing configuration",
    ...override,
  });
}
test("tax arithmetic separates inclusive tax and preserves every paisa", () => {
  const exclusive = financialTotals(84000, { serviceChargeBps: 500, tax });
  assert.equal(exclusive.chargeMinor, 4200);
  assert.equal(exclusive.taxMinor, 8820);
  assert.equal(exclusive.totalMinor, 97020);
  const inclusive = financialTotals(84000, {
    serviceChargeBps: 500,
    tax: { ...tax, mode: "inclusive" },
  });
  assert.equal(inclusive.totalMinor, 88200);
  assert.equal(inclusive.taxMinor, 8018);
  assert.equal(
    inclusive.accountingFoodMinor +
      inclusive.accountingChargeMinor +
      inclusive.taxMinor,
    inclusive.totalMinor,
  );
  const defaultBill = financialTotals(12345, { serviceChargeBps: 0 });
  assert.equal(defaultBill.totalMinor, 12345);
  assert.equal(defaultBill.taxMinor, 0);
  const foodOnly = financialTotals(12345, {
    serviceChargeBps: 500,
    tax: { ...tax, base: "food", rateBps: 725 },
  });
  assert.equal(foodOnly.taxMinor, 895);
  assert.equal(foodOnly.totalMinor, 13857);
});

test("invoice settings are role-protected, sequential numbers are unique and old snapshots stay unchanged", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  error(await f.staff.cashier("/api/staff/invoice-settings"), 403);
  await f.store.settings.updateOne(
    { _id: "restaurant" },
    { $set: { serviceChargeBps: 500 } },
    { upsert: true },
  );
  ok(await configure(f));
  error(await configure(f), 409, "SETTINGS_UPDATED");
  const table = await f.open(),
    order = await f.order(guest, table);
  await f.serve(order);
  const preview = ok(await guest("/api/table/bill")).preview;
  assert.equal(preview.totalMinor, 97020);
  const bills = await Promise.all([
    post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
    post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
  ]);
  const first = ok(bills[0]).bill;
  assert.equal(ok(bills[1]).bill.id, first.id);
  assert.match(first.receiptNo, /^AKV-\d{4}-000001$/);
  assert.equal(first.totalMinor, preview.totalMinor);
  assert.equal(first.tax, 88.2);
  assert.equal(first.invoice.businessName, invoice.businessName);
  ok(
    await configure(
      f,
      {
        tax: { ...tax, rateBps: 2000 },
        invoice: { ...invoice, businessName: "Future Restaurant Name" },
      },
      1,
    ),
  );
  const old = ok(await guest("/api/bills/" + first.id)).bill;
  assert.equal(old.taxRateBps, 1000);
  assert.equal(old.invoice.businessName, invoice.businessName);
  const other = await f.finalized(f.browser(), "T02");
  assert.match(other.receiptNo, /^AKV-\d{4}-000002$/);
  assert.equal(other.totalMinor, 105840);
});

test("inclusive tax is excluded from food sales and full refunds issue balanced tax credit notes", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  await f.store.settings.updateOne(
    { _id: "restaurant" },
    { $set: { serviceChargeBps: 500 } },
    { upsert: true },
  );
  ok(await configure(f, { tax: { ...tax, mode: "inclusive" } }));
  const initial = await f.finalized(guest),
    bill = ok(
      await post(f.staff.cashier, "/api/staff/bills/" + initial.id + "/pay", {
        method: "cash",
        verified: true,
        reference: "",
      }),
    ).bill;
  assert.equal(bill.totalMinor, 88200);
  assert.equal(bill.taxIncluded, true);
  const before = ok(await f.staff.cashier("/api/staff/reports/sales"));
  assert.equal(
    before.summary.subtotalMinor +
      before.summary.serviceChargeMinor +
      before.accounting.taxMinor,
    before.summary.revenueMinor,
  );
  const request = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/refunds", {
      paymentId: bill.payments[0].id,
      amountMinor: bill.totalMinor,
      reason: "Whole purchase returned",
      requestKey: key(),
    }),
    201,
  ).refund;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/refunds/" + request.id + "/decision",
      { decision: "approve", reason: "Full return accepted" },
    ),
  );
  const refund = ok(
    await post(
      f.staff.cashier,
      "/api/staff/refunds/" + request.id + "/execute",
      { verified: true, reference: "" },
    ),
  ).refund;
  assert.equal(
    refund.creditNote.foodMinor +
      refund.creditNote.chargeMinor +
      refund.creditNote.taxMinor,
    bill.totalMinor,
  );
  assert.equal(refund.creditNote.taxMinor, Math.round(bill.tax * 100));
  const after = ok(await f.staff.cashier("/api/staff/reports/sales"));
  assert.equal(after.accounting.refundsMinor, 88200);
  assert.equal(after.accounting.afterRefundsMinor, 0);
  assert.equal(after.accounting.taxAfterRefundsMinor, 0);
  const csv = await f.staff.cashier(
    "/api/staff/reports/sales.csv?section=summary",
  );
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes("Tax refunded BDT"));
});
