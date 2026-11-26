import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  assistantFixture,
  ask,
  answer,
  aiPlan,
  post,
  ok,
  key,
} from "./v210-support.js";
import { branch } from "./v28-support.js";
import { password } from "./support.js";

test("AI recommendations rank actual public guest ratings and exclude samples, private reviews, pending reviews and unavailable dishes", async (t) => {
  const f = await assistantFixture(t),
    client = f.browser();
  const review = (dishId, rating, extra = {}) => ({
    _id: new ObjectId(),
    orderId: new ObjectId(),
    dishId,
    rating,
    source: "guest",
    visibility: "public",
    status: "approved",
    ...extra,
  });
  await f.store.reviews.insertMany([
    review("mutton-kacchi", 4),
    review("chicken-tikka", 5),
    review("chicken-tikka", 5),
    review("mint-borhani", 5, { source: "sample" }),
    review("beef-tehari", 5, { visibility: "private" }),
    review("beef-seekh", 5, { status: "pending" }),
    review("pistachio-phirni", 5),
  ]);
  await f.store.dishes.updateOne(
    { _id: "pistachio-phirni" },
    { $set: { available: false } },
  );
  const turn = answer(
    await ask(client, "What are your favorite highly rated dishes?"),
  );
  assert.equal(turn.mode, "ollama");
  assert.equal(turn.reply.dishes[0].id, "chicken-tikka");
  assert.deepEqual(turn.reply.dishes[0].rating, { count: 2, average: 5 });
  assert.equal(turn.reply.dishes[1].id, "mutton-kacchi");
  assert.equal(
    turn.reply.dishes.some((dish) => dish.id === "pistachio-phirni"),
    false,
  );
  assert.equal(
    turn.reply.dishes.find((dish) => dish.id === "beef-seekh")?.rating || null,
    null,
  );
  assert.equal("fingerprint" in turn, false);
  assert.match(turn.reply.text, /guest ratings/);
});
test("missing real ratings use transparent house picks instead of invented stars, and sample ratings do not count", async (t) => {
  const f = await assistantFixture(t);
  await f.store.reviews.insertOne({
    dishId: "mint-borhani",
    rating: 5,
    source: "sample",
    status: "approved",
    visibility: "public",
  });
  const turn = answer(await ask(f.browser(), "Recommend the best food"));
  assert.equal(turn.reply.dishes[0].id, "mutton-kacchi");
  assert.ok(turn.reply.dishes.every((dish) => dish.rating === null));
  assert.match(turn.reply.text, /house signatures/);
});
test("group budgets use exact current base prices and follow-up questions retain context without a combined-meal claim", async (t) => {
  const f = await assistantFixture(t, {
    plan: (context) =>
      context.previousRequest
        ? aiPlan({ ...context.previousRequest, spice: "mild", followUp: true })
        : aiPlan({ budget: 500, people: 2, sort: "value" }),
  });
  const client = f.browser();
  let turn = answer(await ask(client, "Food under ৳500 for 2 people"));
  assert.equal(turn.reply.filters.budget, 500);
  assert.equal(turn.reply.filters.people, 2);
  assert.ok(turn.reply.dishes.every((dish) => dish.total <= 500));
  assert.ok(turn.reply.dishes.every((dish) => dish.quantity === 2));
  turn = answer(await ask(client, "Only mild instead"));
  assert.equal(turn.reply.filters.budget, 500);
  assert.equal(turn.reply.filters.people, 2);
  assert.ok(turn.reply.dishes.every((dish) => dish.spice === "mild"));
  const last = f.calls.filter((call) => call.path === "/api/chat").at(-1);
  assert.equal(
    JSON.parse(last.body.messages.at(-1).content).previousRequest.budget,
    500,
  );
  assert.equal(last.body.stream, false);
  assert.equal(last.body.think, false);
  assert.equal(last.body.format.type, "object");
});
test("a menu edit while the model is answering cannot return a stale available dish or old price", async (t) => {
  const f = await assistantFixture(t, {
    plan: async (_context, _request, runtime) => {
      await runtime.store.dishes.updateOne(
        { _id: "mutton-kacchi" },
        { $set: { price: 999, available: false } },
      );
      return aiPlan({ intent: "details", dishIds: ["mutton-kacchi"] });
    },
  });
  const turn = answer(
    await ask(f.browser(), "What is the price of mutton kacchi?"),
  );
  assert.equal(turn.reply.dishes[0].price, 999);
  assert.equal(turn.reply.dishes[0].available, false);
  assert.equal(turn.reply.dishes[0].total, 999);
});
test("popular recommendations use completed recent branch orders without exposing sales amounts or order records", async (t) => {
  const f = await assistantFixture(t, { plan: aiPlan({ sort: "popular" }) });
  await f.store.orders.insertMany([
    {
      _id: new ObjectId(),
      code: "PRIVATE-RECENT",
      guestHash: key(),
      requestKey: key(),
      status: "served",
      createdAt: new Date(),
      items: [{ dishId: "beef-seekh", quantity: 8 }],
    },
    {
      _id: new ObjectId(),
      code: "PRIVATE-CANCELLED",
      guestHash: key(),
      requestKey: key(),
      status: "cancelled",
      createdAt: new Date(),
      items: [{ dishId: "mutton-kacchi", quantity: 100 }],
    },
    {
      _id: new ObjectId(),
      code: "PRIVATE-OLD",
      guestHash: key(),
      requestKey: key(),
      status: "paid",
      createdAt: new Date(Date.now() - 40 * 86400000),
      items: [{ dishId: "mutton-kacchi", quantity: 100 }],
    },
  ]);
  const response = await ask(f.browser(), "What is most popular?");
  const turn = answer(response);
  assert.equal(turn.reply.dishes[0].id, "beef-seekh");
  assert.equal(turn.reply.dishes[0].basis, "popular");
  assert.equal("popularity" in turn.reply.dishes[0], false);
  assert.equal(response.text.includes("PRIVATE-RECENT"), false);
});
test("English and Bengali answers use branch facts and never invent allergy certifications or perform a booking", async (t) => {
  const f = await assistantFixture(t, {
    plan: ({ question }) =>
      aiPlan({
        intent: question.includes("allergy")
          ? "allergy"
          : question.includes("reserve")
            ? "reservations"
            : "hours",
      }),
  });
  await f.store.settings.updateOne(
    { _id: "restaurant" },
    { $set: { hours: "1 PM – 9 PM" } },
    { upsert: true },
  );
  const client = f.browser();
  const hours = answer(await ask(client, "খোলার সময় কখন?"));
  assert.equal(hours.reply.language, "bn");
  assert.match(hours.reply.text, /1 PM – 9 PM/);
  const allergy = answer(await ask(client, "Is this safe for my nut allergy?"));
  assert.equal(allergy.reply.dishes.length, 0);
  assert.match(allergy.reply.text, /cannot confirm/);
  const reservation = answer(await ask(client, "Please reserve a table"));
  assert.equal(reservation.reply.links[0].to, "/reservations");
  assert.equal(await f.store.reservations.countDocuments({}), 0);
  assert.equal(await f.store.bills.countDocuments({}), 0);
});
test("chat history belongs only to its signed guest or customer and stale identity scopes cannot submit or clear another chat", async (t) => {
  const f = await assistantFixture(t),
    one = f.browser(),
    two = f.browser();
  const state = ok(await one("/api/assistant"));
  answer(await ask(one, "My private menu question"));
  assert.equal(ok(await two("/api/assistant")).conversation.turns.length, 0);
  assert.equal(
    (
      await post(two, "/api/assistant/clear", {
        scope: state.scope,
        expectedRevision: 1,
      })
    ).status,
    409,
  );
  ok(
    await post(one, "/api/account/register", {
      name: "Private member",
      email: "private-member@example.test",
      password,
    }),
    201,
  );
  assert.equal(ok(await one("/api/assistant")).conversation.turns.length, 0);
  assert.equal(
    (
      await post(one, "/api/assistant/messages", {
        scope: state.scope,
        expectedRevision: 1,
        requestKey: key(),
        message: "Old guest scope",
        language: "en",
      })
    ).status,
    409,
  );
  answer(await ask(one, "Show the menu"));
  const transmitted = JSON.stringify(f.calls);
  assert.equal(transmitted.includes("private-member@example.test"), false);
  assert.equal(transmitted.includes(password), false);
  assert.equal(transmitted.includes("ownerKey"), false);
});
test("shared customer login keeps branch-specific assistant histories and recommendations isolated", async (t) => {
  const f = await assistantFixture(t),
    child = await branch(t, f),
    client = f.browser();
  ok(
    await post(client, "/api/account/register", {
      name: "Multi branch guest",
      email: key() + "@example.test",
      password,
    }),
    201,
  );
  const mainState = ok(await client("/api/assistant"));
  answer(await ask(client, "My main branch favorite dishes"));
  await child.store.dishes.updateOne(
    { _id: "mutton-kacchi" },
    { $set: { price: 777 } },
  );
  ok(await post(client, "/api/branches/select", { branchId: "uttara" }));
  const childState = ok(await client("/api/assistant"));
  assert.notEqual(childState.scope, mainState.scope);
  assert.equal(childState.conversation.turns.length, 0);
  const turn = answer(await ask(client, "My other branch favorite dishes"));
  assert.equal(
    turn.reply.dishes.find((dish) => dish.id === "mutton-kacchi").price,
    777,
  );
  ok(await post(client, "/api/branches/select", { branchId: "main" }));
  const restored = ok(await client("/api/assistant"));
  assert.equal(restored.conversation.turns.length, 1);
  assert.equal(
    restored.conversation.turns[0].message,
    "My main branch favorite dishes",
  );
});
