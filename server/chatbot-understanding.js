import { z } from "zod";
import { fold, matchingDishes } from "./chatbot-catalog.js";

export const planSchema = z.strictObject({
  intent: z.enum([
    "recommend",
    "details",
    "hours",
    "location",
    "ordering",
    "reservations",
    "payment",
    "delivery",
    "events",
    "loyalty",
    "order_status",
    "allergy",
    "help",
    "out_of_scope",
  ]),
  sort: z.enum(["rating", "popular", "value", "signature", "menu"]),
  category: z.enum(["all", "mains", "grill", "drinks", "dessert"]),
  spice: z.enum(["any", "mild", "medium", "hot"]),
  budget: z.number().min(1).max(100000).nullable(),
  people: z.number().int().min(1).max(10),
  query: z.string().max(100),
  dishIds: z.array(z.string().max(64)).max(3),
  followUp: z.boolean(),
});
export const emptyPlan = () => ({
  intent: "help",
  sort: "rating",
  category: "all",
  spice: "any",
  budget: null,
  people: 1,
  query: "",
  dishIds: [],
  followUp: false,
});
export function replyLanguage(message, language = "en") {
  if (
    /\p{Script=Bengali}/u.test(message) ||
    /\b(?:in bangla|in bengali)\b/i.test(message)
  )
    return "bn";
  if (/[a-z]/i.test(message)) return "en";
  return language;
}
export function explicitNumbers(message) {
  const text = fold(message);
  const budget =
    /(?:budget(?:\s+(?:is|of))?\s*[:=]?|under|within|below|up to|less than|বাজেট)\s*(?:৳|bdt|tk\.?|taka)?\s*(\d+(?:\.\d{1,2})?)/i.exec(
      text,
    )?.[1] ||
    /(?:৳|bdt|tk\.?)\s*(\d+(?:\.\d{1,2})?)/i.exec(text)?.[1] ||
    /(\d+(?:\.\d{1,2})?)\s*(?:টাকা(?:র)?|taka|tk\b|bdt\b)/i.exec(text)?.[1];
  const people =
    /\bfor\s+(\d{1,2})\s*(?:people|persons?|guests?)?\b/i.exec(text)?.[1] ||
    /(\d{1,2})\s*(?:people|persons?|guests?|জন(?:ের)?)/i.exec(text)?.[1];
  return {
    budget: budget ? Number(budget) : null,
    people: people ? Number(people) : null,
  };
}

// This path is explicitly labelled basic help. It is also used when local AI is
// offline, busy, times out, or returns a plan that fails validation.
export function basicPlan(
  message,
  catalog,
  previous = null,
  previousDishes = [],
) {
  const text = fold(message),
    numbers = explicitNumbers(text);
  const followUp = Boolean(
    previous &&
    (/\b(?:and|those|these|instead|cheaper|same|first|second|third|only|what about)\b|আর|ওটা|এটা|দ্বিতীয়|শুধু|বরং/u.test(
      text,
    ) ||
      numbers.budget !== null ||
      numbers.people !== null ||
      /mild|less spicy|কম ঝাল/u.test(text)),
  );
  const plan = {
    ...(followUp ? previous : emptyPlan()),
    followUp,
    query: "",
    dishIds: [],
  };
  const intents = [
    [
      "allergy",
      /allerg|gluten|dairy|lactose|nuts?\b|vegan|vegetarian|halal|অ্যালার্জি|এলার্জি|নিরামিষ|হালাল/u,
    ],
    [
      "order_status",
      /my order|track.*order|order.*status|আমার অর্ডার|অর্ডার.*অবস্থা/u,
    ],
    ["hours", /opening|closing|hours|what time|কখন|খোলার|বন্ধের|সময়/u],
    ["location", /where|address|location|parking|কোথায়|ঠিকানা|পার্কিং/u],
    [
      "reservations",
      /reserv|book.*table|wait.*list|queue|বুকিং|টেবিল.*বুক|অপেক্ষা/u,
    ],
    ["events", /event|private dining|party|অনুষ্ঠান|ইভেন্ট/u],
    ["payment", /pay|refund|bill|vat|tax|split|বিল|পেমেন্ট|ভ্যাট|রিফান্ড/u],
    ["delivery", /deliver|pickup|takeaway|ডেলিভারি|টেকঅ্যাওয়ে/u],
    ["loyalty", /loyalty|points?|coupon|কুপন|পয়েন্ট/u],
    [
      "ordering",
      /how.*order|place.*order|qr|waiter|অর্ডার.*কিভাবে|কীভাবে.*অর্ডার|ওয়েটার/u,
    ],
  ];
  const topic = intents.find(([, expression]) => expression.test(text));
  if (topic) plan.intent = topic[0];
  else if (
    /recommend|suggest|menu|dish|food|favo[u]?rite|best|popular|rated|rating|cheap|budget|under|within|grill|drink|dessert|খাবার|মেনু|সেরা|বাজেট|পছন্দ|ঝাল|জনপ্রিয়|রেটিং|পানীয়|মিষ্টি/u.test(
      text,
    ) ||
    followUp
  )
    plan.intent = "recommend";
  else
    plan.intent =
      /^(hi|hello|hey|help|হাই|হ্যালো|সালাম|আসসালামু আলাইকুম)[\s!.?]*$/u.test(text)
        ? "help"
        : "out_of_scope";
  const matches = matchingDishes(catalog.menu, text);
  if (
    /price|cost|how much|details|tell me about|available|দাম|বিবরণ|পাওয়া যায়|বিস্তারিত/u.test(
      text,
    ) &&
    matches.length
  ) {
    plan.intent = "details";
    plan.dishIds = matches.slice(0, 3).map((dish) => dish.id);
  }
  const ordinal = /\bfirst\b|প্রথম/u.test(text)
    ? 0
    : /\bsecond\b|দ্বিতীয়/u.test(text)
      ? 1
      : /\bthird\b|তৃতীয়/u.test(text)
        ? 2
        : null;
  if (ordinal !== null && previousDishes[ordinal]) {
    plan.intent = "details";
    plan.dishIds = [previousDishes[ordinal].id];
  }
  if (/most ordered|best.sell|popular|বেশি.*অর্ডার|জনপ্রিয়/u.test(text))
    plan.sort = "popular";
  else if (/rating|rated|favo[u]?rite|best|রেটিং|সেরা/u.test(text))
    plan.sort = "rating";
  else if (/cheapest|cheaper|affordable|সস্তা|কম দাম|কমদাম/u.test(text))
    plan.sort = "value";
  else if (/signature|house|chef|বিশেষ/u.test(text)) plan.sort = "signature";
  if (/drink|beverage|পানীয়|শরবত/u.test(text)) plan.category = "drinks";
  else if (/dessert|sweet|মিষ্টি/u.test(text)) plan.category = "dessert";
  else if (/grill|kebab|গ্রিল|কাবাব/u.test(text) && !plan.dishIds.length)
    plan.category = "grill";
  else if (/rice|main dish|ভাত|প্রধান খাবার/u.test(text))
    plan.category = "mains";
  if (/any categor|all categor|সব ধরনের|যেকোনো খাবার/u.test(text))
    plan.category = "all";
  if (/mild|less spicy|not spicy|কম ঝাল|ঝাল ছাড়া/u.test(text))
    plan.spice = "mild";
  else if (/medium|মাঝারি ঝাল/u.test(text)) plan.spice = "medium";
  else if (/hot|very spicy|বেশি ঝাল/u.test(text)) plan.spice = "hot";
  if (/any spice|যেকোনো ঝাল/u.test(text)) plan.spice = "any";
  if (
    numbers.budget !== null &&
    numbers.budget >= 1 &&
    numbers.budget <= 100000
  )
    plan.budget = numbers.budget;
  if (/no budget|any price|বাজেট নেই/u.test(text)) plan.budget = null;
  if (numbers.people !== null && numbers.people >= 1 && numbers.people <= 10)
    plan.people = numbers.people;
  if (numbers.people > 10) plan.intent = "events";
  if (topic?.[0] === "allergy") plan.intent = "allergy";
  return plan;
}

export function safePlan(raw, message, previous, catalog, lastDishes = []) {
  const plan = planSchema.parse(raw),
    numbers = explicitNumbers(message),
    text = fold(message),
    basic = basicPlan(message, catalog, previous, lastDishes);
  if (
    ["help", "out_of_scope"].includes(plan.intent) &&
    !["help", "out_of_scope"].includes(basic.intent)
  )
    plan.intent = basic.intent;
  plan.dishIds = plan.dishIds.filter((id) =>
    catalog.menu.some((dish) => dish.id === id),
  );
  if (
    numbers.budget !== null &&
    numbers.budget >= 1 &&
    numbers.budget <= 100000
  )
    plan.budget = numbers.budget;
  else if (
    plan.budget !== null &&
    /budget|under|within|below|less than|up to|টাকা|বাজেট/i.test(message)
  ) {
    /* Explicit worded budget, interpreted by local AI. */
  } else if (!plan.followUp || !previous) plan.budget = null;
  else if (plan.budget !== null && plan.budget !== previous.budget)
    plan.budget = previous.budget;
  if (numbers.people !== null && numbers.people >= 1 && numbers.people <= 10)
    plan.people = numbers.people;
  else if (
    /\b(?:people|persons?|guests?|group|friends?|children|kids|family|of us)\b|জন/u.test(
      message,
    )
  ) {
    /* Keep a worded group size from the validated plan. */
  } else if (!plan.followUp || !previous) plan.people = 1;
  else plan.people = previous.people;
  // The model interprets natural language; explicit preferences and neutral
  // defaults are still enforced by the application, never invented by a model.
  if (/mild|less spicy|not spicy|not (?:too )?hot|কম ঝাল|ঝাল ছাড়া/u.test(text))
    plan.spice = "mild";
  else if (/medium|মাঝারি ঝাল/u.test(text)) plan.spice = "medium";
  else if (/\bhot\b|very spicy|বেশি ঝাল/u.test(text)) plan.spice = "hot";
  else if (/any spice|যেকোনো ঝাল/u.test(text)) plan.spice = "any";
  else if (!/spic|heat|ঝাল/u.test(text))
    plan.spice = plan.followUp ? previous?.spice || "any" : "any";
  if (
    /drink|beverage|dessert|sweet|grill|rice|main dish|পানীয়|শরবত|মিষ্টি|গ্রিল|ভাত|প্রধান খাবার/u.test(
      text,
    )
  )
    plan.category = basic.category;
  else plan.category = plan.followUp ? previous?.category || "all" : "all";
  if (
    /most ordered|best.sell|popular|বেশি.*অর্ডার|জনপ্রিয়|rating|rated|favo[u]?rite|best|রেটিং|সেরা|cheapest|cheaper|affordable|সস্তা|কম দাম|কমদাম|signature|house|chef|বিশেষ/u.test(
      text,
    )
  )
    plan.sort = basic.sort;
  if (
    /^(?:food|foods|dish|dishes|menu|mild|medium|hot|spicy|cheap|cheaper|খাবার|মেনু|কম ঝাল|মাঝারি ঝাল|বেশি ঝাল)$/u.test(
      fold(plan.query).trim(),
    )
  )
    plan.query = "";
  if (
    /allerg|gluten|dairy|lactose|nuts?\b|vegan|vegetarian|halal|অ্যালার্জি|এলার্জি|নিরামিষ|হালাল/u.test(
      text,
    )
  )
    plan.intent = "allergy";
  if (
    basic.intent === "details" &&
    basic.dishIds.length &&
    /\b(?:first|second|third)\b|প্রথম|দ্বিতীয়|তৃতীয়/u.test(text)
  ) {
    plan.intent = "details";
    plan.dishIds = basic.dishIds;
  }
  if (numbers.people > 10) plan.intent = "events";
  return plan;
}
