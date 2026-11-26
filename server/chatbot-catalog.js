import {
  normalizeDish,
  publicSettings,
  restaurantSettings,
} from "./restaurant.js";

export const cleanText = (value, max = 300) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .slice(0, max)
    : "";
export const fold = (value) =>
  cleanText(value, 1000)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[০-৯]/g, (digit) => String("০১২৩৪৫৬৭৮৯".indexOf(digit)));

export async function assistantCatalog(store) {
  const since = new Date(Date.now() - 30 * 86400000);
  const popularity = (collection, statuses) =>
    collection
      .aggregate([
        { $match: { status: { $in: statuses }, createdAt: { $gte: since } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.dishId",
            quantity: { $sum: "$items.quantity" },
          },
        },
        { $limit: 1000 },
      ])
      .toArray();
  const [raw, reviews, tableOrders, offPremise, settings, fulfillment] =
    await Promise.all([
      store.dishes.find({}).sort({ position: 1, _id: 1 }).limit(500).toArray(),
      store.reviews
        .aggregate([
          {
            $match: {
              status: "approved",
              source: "guest",
              visibility: { $ne: "private" },
              rating: { $gte: 1, $lte: 5 },
            },
          },
          {
            $group: {
              _id: "$dishId",
              count: { $sum: 1 },
              average: { $avg: "$rating" },
            },
          },
          { $limit: 1000 },
        ])
        .toArray(),
      popularity(store.orders, ["served", "paid"]),
      popularity(store.fulfillments, ["collected", "delivered"]),
      restaurantSettings(store),
      store.settings.findOne({ _id: "fulfillment" }),
    ]);
  const ratings = new Map(
    reviews.map((row) => [
      String(row._id),
      { count: row.count, average: Math.round(row.average * 100) / 100 },
    ]),
  );
  const counts = new Map();
  for (const row of [...tableOrders, ...offPremise])
    counts.set(
      String(row._id),
      (counts.get(String(row._id)) || 0) + Math.max(0, row.quantity || 0),
    );
  const menu = raw
    .map(normalizeDish)
    .filter(
      (row) =>
        typeof row._id === "string" &&
        Number.isFinite(row.price) &&
        row.price >= 0,
    )
    .map((row) => ({
      id: row._id,
      name: cleanText(row.name, 80),
      nameBn: cleanText(row.nameBn, 80),
      description: cleanText(row.description),
      descriptionBn: cleanText(row.descriptionBn),
      category: row.category,
      price: row.price,
      available: Boolean(row.available),
      serves: Number.isInteger(row.serves) && row.serves > 0 ? row.serves : 1,
      spice: ["mild", "medium", "hot"].includes(row.spice)
        ? row.spice
        : "medium",
      signature: Boolean(row.signature),
      rating: ratings.get(row._id) || null,
      popularity: counts.get(row._id) || 0,
    }));
  return {
    menu,
    restaurant: publicSettings(settings),
    fulfillment: {
      pickupEnabled: Boolean(fulfillment?.pickupEnabled),
      deliveryEnabled: Boolean(fulfillment?.deliveryEnabled),
    },
  };
}

const stop = new Set(
  "what is the a an of for can you me tell about price cost how much dish dishes food menu please show something recommend best rating highest rated available under within budget people person and with details am i want like it that this one only in my have do there are much কম কত দাম খাবার খাবারের আমাকে আমার একটা একটি দিন দেখান দেখাও চাই কি কী এই ওই আর মধ্যে টাকার জন জন্য আছে পাওয়া যায় সম্পর্কে বলুন".split(
    /\s+/,
  ),
);
export function matchingDishes(menu, query) {
  const text = fold(query),
    tokens = text
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter((s) => s.length > 1 && !stop.has(s));
  if (!tokens.length) return [];
  return menu
    .map((dish) => {
      const haystack = fold(
        dish.name + " " + dish.nameBn + " " + dish.id.replaceAll("-", " "),
      );
      const score = tokens.filter((token) => {
        if (haystack.includes(token)) return true;
        // Keep Bengali vowel marks together and match common possessives such
        // as “কাচ্চির দাম” against the menu name “কাচ্চি”.
        return (
          token.length > 3 &&
          /\p{Script=Bengali}/u.test(token) &&
          token.endsWith("র") &&
          haystack.includes(token.slice(0, -1))
        );
      }).length;
      return { dish, score };
    })
    .filter((row) => row.score >= Math.min(2, tokens.length))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.dish);
}

export function selectedDishes(catalog, plan) {
  let rows = catalog.menu;
  if (plan.intent === "details") {
    const found = rows.filter((row) => plan.dishIds.includes(row.id));
    rows = found.length ? found : matchingDishes(rows, plan.query);
  } else {
    rows = rows.filter((row) => row.available);
    if (plan.category !== "all")
      rows = rows.filter((row) => row.category === plan.category);
    if (plan.spice !== "any")
      rows = rows.filter((row) => row.spice === plan.spice);
    if (plan.query) rows = matchingDishes(rows, plan.query);
    if (plan.budget !== null)
      rows = rows.filter(
        (row) =>
          Math.round(row.price * 100) * Math.ceil(plan.people / row.serves) <=
          Math.round(plan.budget * 100),
      );
    rows = [...rows].sort((a, b) => {
      if (plan.sort === "value")
        return (
          a.price * Math.ceil(plan.people / a.serves) -
            b.price * Math.ceil(plan.people / b.serves) ||
          a.name.localeCompare(b.name)
        );
      if (plan.sort === "popular" && a.popularity !== b.popularity)
        return b.popularity - a.popularity;
      if (plan.sort === "rating" && Boolean(a.rating) !== Boolean(b.rating))
        return a.rating ? -1 : 1;
      if (plan.sort === "rating" && a.rating && b.rating)
        return (
          b.rating.average - a.rating.average ||
          b.rating.count - a.rating.count ||
          a.name.localeCompare(b.name)
        );
      return (
        Number(b.signature) - Number(a.signature) ||
        a.name.localeCompare(b.name)
      );
    });
  }
  return rows.slice(0, 3).map(({ popularity, ...dish }) => ({
    ...dish,
    quantity: Math.ceil(plan.people / dish.serves),
    total:
      (Math.round(dish.price * 100) * Math.ceil(plan.people / dish.serves)) /
      100,
    basis:
      plan.sort === "popular" && popularity > 0
        ? "popular"
        : plan.sort === "rating" && dish.rating
          ? "rating"
          : dish.signature
            ? "signature"
            : "menu",
  }));
}
