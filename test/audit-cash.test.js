import test from "node:test";
import assert from "node:assert/strict";
import { fixture, post, ok, error, key } from "./support.js";

test("audit search is admin-only, paginated, allowlisted and CSV-safe", async (t) => {
  const f = await fixture(t),
    at = new Date();
  await f.store.audit.insertMany(
    Array.from({ length: 55 }, (_, i) => ({
      type: "test.safe",
      by: "cashier",
      at,
      reason: i === 54 ? "=HYPERLINK(unsafe)" : "Review " + i,
      password: "do-not-expose",
      token: "hidden-token",
      recipe: { secret: "hidden-recipe" },
    })),
  );
  error(await f.staff.cashier("/api/staff/audit"), 403);
  error(await f.browser()("/api/staff/audit"), 401);
  const first = ok(
    await f.staff.admin("/api/staff/audit?type=test.safe&actor=cashier"),
  );
  assert.equal(first.records.length, 50);
  assert.ok(first.nextCursor);
  const second = ok(
    await f.staff.admin(
      "/api/staff/audit?type=test.safe&cursor=" + first.nextCursor,
    ),
  );
  assert.equal(second.records.length, 5);
  assert.equal(
    new Set([...first.records, ...second.records].map((row) => row.id)).size,
    55,
  );
  assert.equal(JSON.stringify(first).includes("do-not-expose"), false);
  assert.equal(JSON.stringify(first).includes("hidden-token"), false);
  const found = ok(await f.staff.admin("/api/staff/audit?q=HYPERLINK"));
  assert.equal(found.records.length, 1);
  const csv = await f.staff.admin("/api/staff/audit/export.csv?type=test.safe");
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes("'=HYPERLINK"));
  assert.equal(csv.text.includes("do-not-expose"), false);
});
test("cash shifts capture partial receipts and approved cash refunds once and close against the counted balance", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  error(await f.staff.kitchen("/api/staff/cash-drawer"), 403);
  const input = {
    openingMinor: 100000,
    reason: "Opening cash counted",
    verified: true,
    requestKey: key(),
  };
  const shift = ok(
    await post(f.staff.cashier, "/api/staff/cash-drawer/open", input),
    201,
  ).shift;
  assert.equal(
    ok(await post(f.staff.cashier, "/api/staff/cash-drawer/open", input), 201)
      .shift.id,
    shift.id,
  );
  error(
    await post(f.staff.admin, "/api/staff/cash-drawer/open", {
      ...input,
      requestKey: key(),
    }),
    409,
    "SHIFT_OPEN",
  );
  const bill = await f.finalized(guest),
    endpoint = "/api/staff/bills/" + bill.id + "/pay";
  const receipt = {
    method: "cash",
    verified: true,
    amountMinor: 40000,
    requestKey: key(),
  };
  ok(await post(f.staff.cashier, endpoint, receipt));
  ok(await post(f.staff.cashier, endpoint, receipt));
  let current = ok(await f.staff.cashier("/api/staff/cash-drawer")).active;
  assert.equal(current.expectedMinor, 140000);
  error(
    await post(
      f.staff.cashier,
      "/api/staff/cash-drawer/" + shift.id + "/close",
      {
        expectedRevision: shift.revision,
        countedMinor: 140000,
        reason: "Cannot close stale count",
        verified: true,
        requestKey: key(),
      },
    ),
    409,
    "SHIFT_UPDATED",
  );
  const paid = ok(
    await post(f.staff.cashier, endpoint, {
      method: "cash",
      verified: true,
      amountMinor: 44000,
      requestKey: key(),
    }),
  ).bill;
  const refund = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/refunds", {
      paymentId: paid.payments[0].id,
      amountMinor: 10000,
      reason: "Partial cash return",
      requestKey: key(),
    }),
    201,
  ).refund;
  ok(
    await post(f.staff.admin, "/api/staff/refunds/" + refund.id + "/decision", {
      decision: "approve",
      reason: "Manager confirmed return",
    }),
  );
  const execute = { verified: true, reference: "Cash actually returned" };
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/refunds/" + refund.id + "/execute",
      execute,
    ),
  );
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/refunds/" + refund.id + "/execute",
      execute,
    ),
  );
  current = ok(await f.staff.cashier("/api/staff/cash-drawer")).active;
  assert.equal(current.expectedMinor, 174000);
  assert.equal(current.cashInMinor, 84000);
  assert.equal(current.cashOutMinor, 10000);
  const close = {
    expectedRevision: current.revision,
    countedMinor: 173950,
    reason: "Closing count is fifty paisa short",
    verified: true,
    requestKey: key(),
  };
  const closed = ok(
    await post(
      f.staff.cashier,
      "/api/staff/cash-drawer/" + shift.id + "/close",
      close,
    ),
  ).shift;
  assert.equal(closed.varianceMinor, -50);
  assert.equal(
    ok(
      await post(
        f.staff.cashier,
        "/api/staff/cash-drawer/" + shift.id + "/close",
        close,
      ),
    ).shift.id,
    closed.id,
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/cash-drawer/" + shift.id + "/review",
      { reason: "Variance reviewed against receipt count" },
    ),
  );
  assert.equal(
    (
      await f.staff.cashier(
        "/api/staff/cash-drawer/" + shift.id + "/export.csv",
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.store.cashMovements.find({ shiftId: { $ne: null } }).toArray())
      .length,
    3,
  );
});
test("cash received without a shift stays unassigned and concurrent shift openings cannot both succeed", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    bill = await f.finalized(guest);
  ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/cash-drawer")).unassigned.length,
    1,
  );
  const open = () => ({
    openingMinor: 5000,
    reason: "Drawer counted",
    verified: true,
    requestKey: key(),
  });
  const results = await Promise.all([
    post(f.staff.admin, "/api/staff/cash-drawer/open", open()),
    post(f.staff.cashier, "/api/staff/cash-drawer/open", open()),
  ]);
  assert.equal(results.filter((row) => row.status === 201).length, 1);
  assert.equal(results.filter((row) => row.status === 409).length, 1);
  const active = ok(await f.staff.cashier("/api/staff/cash-drawer")).active;
  assert.equal(active.expectedMinor, 5000);
  const movement = {
    direction: "out",
    amountMinor: 5001,
    reason: "Too much cash withdrawal",
    reference: "",
    verified: true,
    requestKey: key(),
  };
  error(
    await post(f.staff.cashier, "/api/staff/cash-drawer/movements", movement),
    409,
    "CASH_LOW",
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/cash-drawer")).active.expectedMinor,
    5000,
  );
});
