import { z } from "zod";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function body(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      parsed.error.issues[0]?.message || "Invalid input.",
    );
  }
  return parsed.data;
}

export const dishId = z.string().regex(/^[a-z0-9-]{1,64}$/, "Invalid dish.");
export const price = z.number().int().min(1).max(100000);
export const orderInput = z.strictObject({
  visitKey: z.string().regex(/^[a-f0-9]{16}$/, "Invalid table visit."),
  items: z
    .array(
      z.strictObject({
        dishId,
        variantId: dishId.optional(),
        addonIds: z
          .array(dishId)
          .max(6)
          .refine((values) => new Set(values).size === values.length)
          .optional(),
        quantity: z.number().int().min(1).max(10),
        expectedPrice: price,
      }),
    )
    .min(1)
    .max(12)
    .refine(
      (items) =>
        new Set(
          items.map((item) =>
            [
              item.dishId,
              item.variantId || "",
              [...(item.addonIds || [])].sort().join(","),
            ].join("|"),
          ),
        ).size === items.length,
      "Add each dish once and use the quantity control.",
    ),
  note: z.string().trim().max(200).default(""),
});
export const reviewInput = z.strictObject({
  dishId,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(400).default(""),
  liked: z.string().trim().max(200).default(""),
  improve: z.string().trim().max(200).default(""),
  visibility: z.enum(["public", "private"]).default("public"),
});
export const loginInput = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{1,32}$/, "Invalid username."),
  password: z.string().min(1).max(128),
});
export const actionInput = z.strictObject({
  action: z.enum(["send", "reject", "start", "ready", "serve"]),
  reason: z.string().trim().max(160).default(""),
});
export const reviewDecisionInput = z.strictObject({
  status: z.enum(["approved", "hidden"]),
  reason: z.string().trim().max(250).default(""),
  reply: z.string().trim().max(400).default(""),
});
const option = z.strictObject({
  id: dishId,
  name: z.string().trim().min(1).max(50),
  nameBn: z.string().trim().max(70).default(""),
  price: z.number().int().min(0).max(10000),
});
export const dishEditInput = z.strictObject({
  price,
  available: z.boolean(),
  name: z.string().trim().min(2).max(80).optional(),
  nameBn: z.string().trim().max(100).optional(),
  description: z.string().trim().min(3).max(300).optional(),
  descriptionBn: z.string().trim().max(400).optional(),
  image: z
    .string()
    .regex(/^\/assets\/[a-z0-9-]+\.webp$/)
    .optional(),
  category: z.enum(["mains", "grill", "drinks", "dessert"]).optional(),
  serves: z.number().int().min(1).max(10).optional(),
  spice: z.enum(["mild", "medium", "hot"]).optional(),
  variants: z
    .array(option)
    .max(5)
    .refine(
      (values) =>
        new Set(values.map((value) => value.id)).size === values.length,
      "Size IDs must be unique.",
    )
    .optional(),
  addons: z
    .array(option)
    .max(6)
    .refine(
      (values) =>
        new Set(values.map((value) => value.id)).size === values.length,
      "Add-on IDs must be unique.",
    )
    .optional(),
});

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) {
    return res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
  }
  if (
    error.type === "entity.parse.failed" ||
    error.type === "entity.too.large"
  ) {
    return res
      .status(error.status)
      .json({
        error: { code: "INVALID_BODY", message: "Invalid request body." },
      });
  }
  console.error(
    "Request failed:",
    req.method,
    error.name,
    error.code || "",
    error.message,
  );
  const unavailable = [
    "MongoServerSelectionError",
    "MongoNetworkError",
    "MongoNetworkTimeoutError",
  ].includes(error.name);
  res.status(unavailable ? 503 : 500).json({
    error: {
      code: unavailable ? "UNAVAILABLE" : "SERVER_ERROR",
      message: "Something went wrong. Please try again.",
    },
  });
}
