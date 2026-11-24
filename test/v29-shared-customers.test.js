import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, password, key } from "./support.js";
import { branch } from "./v28-support.js";
import { passwordHash } from "../server/security.js";
import { transaction } from "../server/money.js";
test("legacy notification consent is paused when merging into a different shared identity", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    guest = f.browser(),
    member = await f.account(guest),
    legacy = {
      _id: new ObjectId(),
      name: "Prior customer",
      email: member.email,
      passwordHash: await passwordHash(password + "legacy"),
      points: 2,
      active: true,
    };
  await child.store.legacyCustomers.insertOne(legacy);
  await child.store.notificationPreferences.insertOne({
    _id: "customer:" + legacy._id,
    customerId: legacy._id,
    generation: 3,
    inApp: true,
    email: true,
    sms: true,
    push: true,
  });
  await child.store.pushSubscriptions.insertOne({
    _id: "old-device",
    actorKey: "customer:" + legacy._id,
  });
  ok(
    await post(guest, "/api/account/link-branch", {
      branchId: "uttara",
      currentPassword: password,
      branchPassword: password + "legacy",
    }),
  );
  const preference = await child.store.notificationPreferences.findOne({
    customerId: legacy._id,
  });
  assert.equal(preference.generation, 4);
  assert.equal(preference.email, false);
  assert.equal(preference.sms, false);
  assert.equal(preference.push, false);
  assert.equal(await child.store.pushSubscriptions.countDocuments({}), 0);
});
test("refunds using a linked legacy customer ID adjust the one shared points balance", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    guest = f.browser(),
    member = await f.account(guest),
    bill = await f.finalized(guest);
  ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
  );
  const before = ok(await guest("/api/account")).customer.points,
    legacy = {
      _id: new ObjectId(),
      email: member.email,
      name: "Legacy owner",
      active: true,
      passwordHash: await passwordHash(password + "legacy"),
      points: 7,
    };
  await child.store.legacyCustomers.insertOne(legacy);
  ok(
    await post(guest, "/api/account/link-branch", {
      branchId: "uttara",
      currentPassword: password,
      branchPassword: password + "legacy",
    }),
  );
  await f.store.loyaltyLedger.updateMany(
    { billId: new ObjectId(bill.id), key: /^earn:/ },
    { $set: { customerId: legacy._id } },
  );
  await f.store.bills.updateOne(
    { _id: new ObjectId(bill.id) },
    { $set: { "items.$[].ownerCustomerId": legacy._id } },
  );
  const saved = await f.store.bills.findOne({ _id: new ObjectId(bill.id) }),
    payment = saved.payments[0],
    refund = ok(
      await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/refunds", {
        paymentId: payment.id,
        amountMinor: saved.totalMinor,
        reason: "Verified full return after linking",
        requestKey: key(),
      }),
      201,
    ).refund;
  ok(
    await post(f.staff.admin, "/api/staff/refunds/" + refund.id + "/decision", {
      decision: "approve",
      reason: "Original invoice and return checked",
    }),
  );
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/refunds/" + refund.id + "/execute",
      { verified: true, reference: "LEGACY-RETURN" },
    ),
  );
  assert.ok(before > 0);
  assert.equal(ok(await guest("/api/account")).customer.points, 7);
});
test("shared customer sign-in, profile and loyalty balance persist across branches while business orders stay scoped", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    guest = f.browser(),
    member = await f.account(guest);
  await f.store.customers.updateOne(
    { _id: new ObjectId(member.id) },
    { $set: { points: 50 } },
  );
  ok(await post(guest, "/api/branches/select", { branchId: "uttara" }));
  assert.equal(ok(await guest("/api/account")).customer.id, member.id);
  assert.equal(ok(await guest("/api/account/loyalty")).points, 50);
  const other = f.browser();
  ok(await post(other, "/api/branches/select", { branchId: "uttara" }));
  ok(
    await post(other, "/api/account/login", { email: member.email, password }),
  );
  error(
    await post(other, "/api/account/register", {
      name: "Duplicate",
      email: member.email,
      password,
    }),
    409,
    "ACCOUNT_EXISTS",
  );
  assert.equal(
    await child.store.customers.countDocuments({ email: member.email }),
    1,
  );
  const results = await Promise.all([
    transaction(f.store, (session) =>
      f.store.customers.updateOne(
        { _id: new ObjectId(member.id), points: { $gte: 40 } },
        { $inc: { points: -40 } },
        { session },
      ),
    ),
    transaction(child.store, (session) =>
      child.store.customers.updateOne(
        { _id: new ObjectId(member.id), points: { $gte: 40 } },
        { $inc: { points: -40 } },
        { session },
      ),
    ),
  ]);
  assert.deepEqual(results.map((r) => r.modifiedCount).sort(), [0, 1]);
  assert.equal(ok(await guest("/api/account")).customer.points, 10);
});
test("separate legacy accounts require both passwords and merge their balances and private histories exactly once", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    guest = f.browser(),
    member = await f.account(guest);
  await f.store.customers.updateOne(
    { _id: new ObjectId(member.id) },
    { $set: { points: 10 } },
  );
  const legacy = {
    _id: new ObjectId(),
    name: "Prior branch member",
    email: member.email,
    passwordHash: await passwordHash(password + "legacy"),
    points: 7,
    active: true,
    authVersion: 0,
  };
  await child.store.legacyCustomers.insertOne(legacy);
  await child.store.orders.insertOne({
    _id: new ObjectId(),
    code: "LEGACY-MEMBER",
    guestHash: "legacy",
    requestKey: key(),
    customerId: legacy._id,
    createdAt: new Date(),
    items: [],
    total: 100,
    status: "paid",
    tableNumber: "T01",
  });
  await child.store.orders.insertOne({
    _id: new ObjectId(),
    code: "PRIVATE-OTHER",
    guestHash: "other",
    requestKey: key(),
    customerId: new ObjectId(),
    createdAt: new Date(),
    items: [],
    total: 100,
    status: "paid",
    tableNumber: "T01",
  });
  assert.equal(ok(await guest("/api/account/history")).orders.length, 0);
  const input = {
    branchId: "uttara",
    currentPassword: password,
    branchPassword: password + "legacy",
  };
  error(
    await post(guest, "/api/account/link-branch", {
      ...input,
      branchPassword: "wrong",
    }),
    401,
    "LOGIN_FAILED",
  );
  const results = await Promise.all([
    post(guest, "/api/account/link-branch", input),
    post(guest, "/api/account/link-branch", input),
  ]);
  results.forEach((result) => ok(result));
  assert.equal(ok(await guest("/api/account")).customer.points, 17);
  const history = ok(await guest("/api/account/history"));
  assert.deepEqual(
    history.orders.map((row) => row.code),
    ["LEGACY-MEMBER"],
  );
  assert.equal(history.orders[0].branchId, "uttara");
  assert.equal(
    (await child.store.legacyCustomers.findOne({ _id: legacy._id })).points,
    0,
  );
  await child.store.customers.updateOne(
    { _id: legacy._id },
    { $inc: { points: -3 } },
  );
  assert.equal(ok(await guest("/api/account")).customer.points, 14);
  // A branch snapshot taken before linking must not credit its old balance again.
  await child.store.legacyCustomers.updateOne(
    { _id: legacy._id },
    {
      $unset: { linkedCustomerId: "", linkedAt: "" },
      $set: { points: 7, passwordHash: legacy.passwordHash, authVersion: 0 },
    },
  );
  ok(await post(guest, "/api/account/link-branch", input));
  assert.equal(ok(await guest("/api/account")).customer.points, 14);
});
test("a distinct legacy customer upgrades at first successful login without changing old order identities", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    legacy = {
      _id: new ObjectId(),
      name: "Legacy member",
      email: key() + "@example.test",
      passwordHash: await passwordHash(password),
      points: 12,
      active: true,
      authVersion: 0,
    };
  await child.store.legacyCustomers.insertOne(legacy);
  const guest = f.browser();
  ok(await post(guest, "/api/branches/select", { branchId: "uttara" }));
  const login = ok(
    await post(guest, "/api/account/login", { email: legacy.email, password }),
  );
  assert.equal(login.customer.id, String(legacy._id));
  assert.equal(login.customer.points, 12);
  assert.equal(
    (await f.store.sharedCustomers.findOne({ _id: legacy._id })).points,
    12,
  );
  ok(await post(guest, "/api/branches/select", { branchId: "main" }));
  assert.equal(ok(await guest("/api/account")).customer.id, String(legacy._id));
});
test("a legacy password cannot take over an existing shared identity with the same email", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    owner = f.browser(),
    member = await f.account(owner);
  await child.store.legacyCustomers.insertOne({
    _id: new ObjectId(),
    email: member.email,
    name: "Separate user",
    active: true,
    passwordHash: await passwordHash(password + "legacy"),
    points: 100,
  });
  const attacker = f.browser();
  ok(await post(attacker, "/api/branches/select", { branchId: "uttara" }));
  error(
    await post(attacker, "/api/account/login", {
      email: member.email,
      password: password + "legacy",
    }),
    401,
    "LOGIN_FAILED",
  );
  assert.equal(ok(await owner("/api/account")).customer.points, 0);
});
test("combined table and takeaway history has stable pagination, branch labels and private ownership", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    guest = f.browser(),
    member = await f.account(guest),
    at = new Date();
  for (let i = 0; i < 60; i++) {
    const store = i % 2 ? child.store : f.store,
      row = {
        _id: new ObjectId(),
        customerId: new ObjectId(member.id),
        code: "COMBINED-" + i,
        guestHash: "history",
        requestKey: key(),
        createdAt: at,
        status: "paid",
        items: [],
        total: i,
        tableNumber: "T01",
        kind: "pickup",
        quote: { totals: { totalMinor: i * 100 } },
      };
    await (i % 3 ? store.orders : store.fulfillments).insertOne(row);
  }
  const seen = [];
  let cursor = null;
  do {
    const page = ok(
      await guest(
        "/api/account/history" +
          (cursor ? "?before=" + encodeURIComponent(cursor) : ""),
      ),
    );
    seen.push(...page.orders);
    cursor = page.next;
  } while (cursor);
  assert.equal(seen.length, 60);
  assert.equal(
    new Set(
      seen.map((row) => row.branchId + ":" + row.sourceKind + ":" + row.id),
    ).size,
    60,
  );
  assert.ok(seen.some((row) => row.sourceKind === "fulfillment"));
  assert.ok(seen.some((row) => row.branchId === "uttara"));
  error(await f.browser()("/api/account/history"), 401, "CUSTOMER_REQUIRED");
});
test("changing the shared password revokes customer sessions in every branch", async (t) => {
  const f = await fixture(t);
  await branch(t, f);
  const one = f.browser(),
    two = f.browser(),
    member = await f.account(one);
  ok(await post(two, "/api/branches/select", { branchId: "uttara" }));
  ok(await post(two, "/api/account/login", { email: member.email, password }));
  ok(
    await post(one, "/api/account/password", {
      currentPassword: password,
      newPassword: password + "new",
    }),
    204,
  );
  assert.equal(ok(await two("/api/account")).customer, null);
  assert.ok(ok(await one("/api/account")).customer);
});
