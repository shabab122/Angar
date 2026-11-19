import { randomBytes } from "node:crypto";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { restaurantSettings } from "./restaurant.js";
import { transaction, allocateMinor } from "./money.js";

export const taxDefaults = {
  enabled: false,
  label: "VAT",
  rateBps: 0,
  mode: "exclusive",
  base: "food",
};
export const invoiceDefaults = {
  businessName: "",
  address: "",
  phone: "",
  email: "",
  taxRegistration: "",
  footer: "",
  prefix: "AK",
  numbering: "random",
};
export function financialTotals(netFoodMinor, settings) {
  const tax = { ...taxDefaults, ...settings.tax };
  const chargeMinor = Math.round(
    (netFoodMinor * settings.serviceChargeBps) / 10000,
  );
  const taxableMinor =
    netFoodMinor + (tax.base === "food_and_service" ? chargeMinor : 0);
  const taxMinor = tax.enabled
    ? Math.round(
        (taxableMinor * tax.rateBps) /
          (tax.mode === "inclusive" ? 10000 + tax.rateBps : 10000),
      )
    : 0;
  const inclusive = tax.enabled && tax.mode === "inclusive";
  const portions =
    taxMinor && inclusive
      ? allocateMinor(taxMinor, [
          netFoodMinor,
          tax.base === "food_and_service" ? chargeMinor : 0,
        ])
      : [0, 0];
  return {
    chargeMinor,
    taxMinor,
    taxRateBps: tax.enabled ? tax.rateBps : 0,
    taxLabel: tax.label,
    taxIncluded: inclusive,
    taxBase: tax.base,
    totalMinor: netFoodMinor + chargeMinor + (inclusive ? 0 : taxMinor),
    accountingFoodMinor: netFoodMinor - portions[0],
    accountingChargeMinor: chargeMinor - portions[1],
  };
}
export function invoiceSnapshot(settings) {
  const invoice = { ...invoiceDefaults, ...settings.invoice };
  return {
    businessName: invoice.businessName || settings.name,
    address: invoice.address || settings.location,
    phone: invoice.phone,
    email: invoice.email,
    taxRegistration: invoice.taxRegistration,
    footer: invoice.footer,
    branch: settings.branch,
  };
}
export async function nextReceiptNumber(store, settings, session) {
  const invoice = { ...invoiceDefaults, ...settings.invoice };
  if (invoice.numbering !== "sequential")
    return invoice.prefix + "-" + randomBytes(6).toString("hex").toUpperCase();
  const year = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
  }).format(new Date());
  const row = await store.settings.findOneAndUpdate(
    { _id: "invoice-counter:" + invoice.prefix + ":" + year },
    { $inc: { sequence: 1 } },
    { session, upsert: true, returnDocument: "after" },
  );
  return (
    invoice.prefix + "-" + year + "-" + String(row.sequence).padStart(6, "0")
  );
}
const text = (length) => z.string().trim().max(length);
const inputSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(3).max(160),
  tax: z.strictObject({
    enabled: z.boolean(),
    label: text(30).min(1),
    rateBps: z.number().int().min(0).max(10000),
    mode: z.enum(["exclusive", "inclusive"]),
    base: z.enum(["food", "food_and_service"]),
  }),
  invoice: z.strictObject({
    businessName: text(100),
    address: text(240),
    phone: text(40),
    email: text(254).refine(
      (value) => !value || z.email().safeParse(value).success,
      "Enter a valid invoice email.",
    ),
    taxRegistration: text(80),
    footer: text(200),
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,8}$/),
    numbering: z.enum(["random", "sequential"]),
  }),
});
export function registerInvoices(api, store, requireAdmin) {
  api.get("/invoice-settings", requireAdmin, async (req, res) => {
    const settings = await restaurantSettings(store);
    res.json({
      tax: { ...taxDefaults, ...settings.tax },
      invoice: { ...invoiceDefaults, ...settings.invoice },
      revision: settings.billingRevision || 0,
      serviceChargeBps: settings.serviceChargeBps,
      example: financialTotals(100000, settings),
    });
  });
  api.post("/invoice-settings", requireAdmin, async (req, res) => {
    const input = body(inputSchema, req.body);
    await transaction(store, async (session) => {
      const settings = await store.settings.findOneAndUpdate(
        { _id: "restaurant" },
        { $inc: { configurationRevision: 1 } },
        { session, upsert: true, returnDocument: "after" },
      );
      if ((settings.billingRevision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "SETTINGS_UPDATED",
          "Invoice settings changed. Refresh before saving.",
        );
      await store.settings.updateOne(
        { _id: "restaurant" },
        {
          $set: { tax: input.tax, invoice: input.invoice },
          $inc: { billingRevision: 1 },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "invoice.settings_updated",
          before: {
            tax: settings.tax || taxDefaults,
            invoice: settings.invoice || invoiceDefaults,
          },
          after: { tax: input.tax, invoice: input.invoice },
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
}
