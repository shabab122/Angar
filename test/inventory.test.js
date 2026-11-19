import test from "node:test";
import assert from "node:assert/strict";
import { fixture, post, ok, error, key } from "./support.js";
import { tableVisitKey } from "../server/security.js";
const createIngredient = async (f, stock = 1500) =>
  ok(
    await post(f.staff.admin, "/api/staff/inventory/ingredients", {
      name: "Rice",
      unit: "g",
      initialStock: stock,
      reorderLevel: 600,
    }),
    201,
  ).ingredient;
const recipe = (f, ingredient, quantity, expectedRevision = 0) =>
  post(f.staff.admin, "/api/staff/inventory/recipes/mutton-kacchi", {
    enabled: true,
    expectedRevision,
    base: [{ ingredientId: ingredient.id, quantity }],
    variants: [],
    addons: [],
    reason: "Recipe approved by kitchen manager",
  });
const send = (f, order) =>
  post(f.staff.admin, "/api/staff/orders/" + order.id + "/action", {
    action: "send",
  });
const getRice = async (f) =>
  ok(await f.staff.admin("/api/staff/inventory")).ingredients.find(
    (row) => row.name === "Rice",
  );

test("size and add-on recipes add to the base recipe per ordered portion", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    rice = await createIngredient(f, 2000);
  const potatoes = ok(
    await post(f.staff.admin, "/api/staff/inventory/ingredients", {
      name: "Potato",
      unit: "pcs",
      initialStock: 10,
      reorderLevel: 2,
    }),
    201,
  ).ingredient;
  ok(
    await post(f.staff.admin, "/api/staff/inventory/recipes/mutton-kacchi", {
      enabled: true,
      expectedRevision: 0,
      base: [{ ingredientId: rice.id, quantity: 250 }],
      variants: [
        {
          optionId: "hearty",
          ingredients: [{ ingredientId: rice.id, quantity: 100 }],
        },
      ],
      addons: [
        {
          optionId: "extra-potato",
          ingredients: [{ ingredientId: potatoes.id, quantity: 1 }],
        },
      ],
      reason: "Sized portions and extra potato",
    }),
  );
  const table = await f.open();
  await guest("/t/" + table.qrToken);
  const order = ok(
    await post(
      guest,
      "/api/orders",
      {
        visitKey: tableVisitKey(table.activeVisitId),
        items: [
          {
            dishId: "mutton-kacchi",
            quantity: 2,
            variantId: "hearty",
            addonIds: ["extra-potato"],
            expectedPrice: 600,
          },
        ],
        note: "",
      },
      { "Idempotency-Key": key() },
    ),
    201,
  ).order;
  ok(await send(f, order));
  assert.equal((await getRice(f)).stock, 1300);
  assert.equal(
    (await f.store.ingredients.findOne({ name: "Potato" })).stock,
    8,
  );
});

test("inventory reserves at kitchen acceptance, snapshots recipes, adjusts edits and releases pre-cooking cancellation", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    rice = await createIngredient(f);
  ok(await recipe(f, rice, 250));
  const order = await f.order(guest, await f.open());
  assert.equal((await getRice(f)).stock, 1500);
  ok(await send(f, order));
  assert.equal((await getRice(f)).stock, 1000);
  // A changed recipe applies to future acceptance, not an already queued order.
  ok(await recipe(f, rice, 1000, 1));
  const current = ok(await guest("/api/orders")).orders.find(
    (row) => row.id === order.id,
  );
  const changed = ok(
    await post(
      guest,
      "/api/orders/" + order.id + "/changes",
      {
        type: "edit",
        expectedRevision: current.revision,
        lines: [{ index: 0, quantity: 3 }],
        note: "",
        reason: "Another guest joined",
      },
      { "Idempotency-Key": key() },
    ),
    201,
  ).order;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/orders/" +
        order.id +
        "/changes/" +
        changed.changeRequest.id +
        "/decision",
      { decision: "approve", reason: "Extra portion confirmed" },
    ),
  );
  assert.equal((await getRice(f)).stock, 750);
  ok(
    await post(f.staff.admin, "/api/staff/orders/" + order.id + "/cancel", {
      reason: "Party cancelled before cooking",
    }),
    204,
  );
  assert.equal((await getRice(f)).stock, 1500);
  const movements = await f.store.stockMovements
    .find({ orderCode: order.code })
    .toArray();
  assert.equal(
    movements.reduce((sum, row) => sum + row.delta, 0),
    0,
  );
});

test("concurrent kitchen acceptance cannot overspend an ingredient and cooking does not restore consumed stock", async (t) => {
  const f = await fixture(t),
    rice = await createIngredient(f, 1000);
  ok(await recipe(f, rice, 400));
  const first = f.browser(),
    second = f.browser(),
    one = await f.order(first, await f.open("T01")),
    two = await f.order(second, await f.open("T02"));
  const results = await Promise.all([send(f, one), send(f, two)]);
  assert.equal(results.filter((row) => row.status === 200).length, 1);
  assert.equal(
    results.find((row) => row.status === 409).data.error.code,
    "STOCK_LOW",
  );
  assert.equal((await getRice(f)).stock, 200);
  assert.equal((await getRice(f)).low, true);
  const accepted = results[0].status === 200 ? one : two;
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/orders/" + accepted.id + "/action",
      { action: "start" },
    ),
  );
  error(
    await post(f.staff.admin, "/api/staff/orders/" + accepted.id + "/cancel", {
      reason: "Too late after cooking",
    }),
    409,
    "ORDER_LOCKED",
  );
  assert.equal((await getRice(f)).stock, 200);
});

test("stock movements are retry-safe, role-restricted and cannot make stock negative", async (t) => {
  const f = await fixture(t),
    rice = await createIngredient(f, 1000),
    requestKey = key();
  const path = "/api/staff/inventory/ingredients/" + rice.id + "/stock";
  const input = {
    kind: "receive",
    quantity: 500,
    reason: "Supplier stock received",
    reference: "SUPPLIER-1",
    requestKey,
  };
  error(await post(f.staff.kitchen, path, input), 403);
  ok(await post(f.staff.admin, path, input));
  ok(await post(f.staff.admin, path, input));
  assert.equal((await getRice(f)).stock, 1500);
  error(
    await post(f.staff.admin, path, { ...input, quantity: 501 }),
    409,
    "REQUEST_REUSED",
  );
  error(
    await post(f.staff.kitchen, path, {
      ...input,
      kind: "waste",
      quantity: 1501,
      requestKey: key(),
    }),
    409,
    "STOCK_LOW",
  );
  ok(
    await post(f.staff.kitchen, path, {
      ...input,
      kind: "waste",
      quantity: 100,
      requestKey: key(),
    }),
  );
  assert.equal((await getRice(f)).stock, 1400);
  error(await f.staff.waiter("/api/staff/inventory"), 403);
});
