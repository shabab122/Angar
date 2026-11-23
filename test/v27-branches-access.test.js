import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixture,
  post,
  patch,
  ok,
  error,
  password,
  key,
  browser,
} from "./support.js";
import { getBranchRuntime } from "../server/branches.js";
import { passwordHash } from "../server/security.js";
import { hasPermission } from "../server/access.js";
const limits = {
  refundApproval: null,
  purchaseApproval: null,
  purchasePayment: null,
  expenseApproval: null,
};
async function branch(f, id = "uttara") {
  const request = {
    id,
    name: "Uttara",
    address: "Uttara, Dhaka",
    copyMenu: true,
    tables: 2,
    currentPassword: password,
    requestKey: key(),
  };
  const result = ok(await post(f.staff.admin, "/api/branches", request), 201);
  const context = await getBranchRuntime(f.store, f.config).get(id);
  return { ...context, request, result };
}
test("branches isolate menu, stock, table visits, cash and guest identities without moving legacy data", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  await f.account(guest);
  const table = await f.open();
  await f.order(guest, table);
  const child = await branch(f);
  try {
    assert.equal(child.result.branch.state, "ready");
    const invalidCallback = await f.staff.admin(
      "/api/courier/webhook?branch=uttara",
      {
        method: "POST",
        raw: "{}",
        headers: { "Content-Type": "application/json" },
      },
    );
    error(invalidCallback, 401, "COURIER_SIGNATURE");
    assert.equal(invalidCallback.headers.getSetCookie().length, 0);
    assert.equal(ok(await f.staff.admin("/api/branches")).current, "main");
    const gatewayReturn = await f.staff.admin(
      "/api/payments/sslcommerz/return/invalid?branch=uttara",
    );
    assert.equal(gatewayReturn.status, 303);
    assert.ok(
      gatewayReturn.headers.get("location").endsWith("/orders?branch=uttara"),
    );
    assert.equal(gatewayReturn.headers.getSetCookie().length, 0);

    assert.equal(await f.store.orders.countDocuments({}), 1);
    assert.equal(await child.store.orders.countDocuments({}), 0);
    assert.equal(
      await child.store.dishes.countDocuments({}),
      await f.store.dishes.countDocuments({}),
    );
    assert.equal(
      await child.store.tables.countDocuments({ activeVisitId: null }),
      2,
    );
    assert.equal(await child.store.staff.countDocuments({}), 4);
    await post(guest, "/api/branches/select", { branchId: "uttara" });
    assert.equal(ok(await guest("/api/account")).customer, null);
    assert.equal(ok(await guest("/api/context")).table, null);
    assert.deepEqual(ok(await guest("/api/orders")).orders, []);
    ok(
      await post(f.staff.admin, "/api/branches/select", { branchId: "uttara" }),
    );
    assert.equal(ok(await f.staff.admin("/api/staff/me")).branchId, "uttara");
    ok(
      await patch(f.staff.admin, "/api/staff/menu/mutton-kacchi", {
        price: 777,
        available: true,
      }),
    );
    assert.equal(
      (await child.store.dishes.findOne({ _id: "mutton-kacchi" })).price,
      777,
    );
    assert.equal(
      (await f.store.dishes.findOne({ _id: "mutton-kacchi" })).price,
      420,
    );
    await child.store.ingredients.insertOne({
      _id: "child-only",
      name: "Separate stock",
      onHand: 500,
    });
    assert.equal(await f.store.ingredients.countDocuments({}), 0);
    const cashier = f.browser();
    ok(await post(cashier, "/api/branches/select", { branchId: "uttara" }));
    error(
      await post(cashier, "/api/staff/login", {
        username: "cashier",
        password,
      }),
      403,
      "BRANCH_FORBIDDEN",
    );
    error(
      await f.staff.admin("/api/staff/orders", {
        headers: { "X-Angar-Branch": "main" },
      }),
      409,
      "BRANCH_CHANGED",
    );
    ok(await post(f.staff.admin, "/api/branches/select", { branchId: "main" }));
    assert.equal(ok(await f.staff.admin("/api/staff/orders")).orders.length, 1);
    const qr = await child.store.tables.findOne({ number: "T01" }),
      phone = f.browser();
    assert.equal((await phone("/b/uttara/t/" + qr.qrToken)).status, 303);
    assert.equal(ok(await phone("/api/context")).table.number, "T01");
    assert.equal(ok(await phone("/api/branches")).current, "uttara");
  } finally {
    await child.store.db.dropDatabase();
  }
});
test("branch provisioning is retryable and rejects reused keys, role escalation and unrelated occupied databases", async (t) => {
  const f = await fixture(t),
    child = await branch(f);
  try {
    ok(await post(f.staff.admin, "/api/branches", child.request), 201);
    assert.equal(await child.store.tables.countDocuments({}), 2);
    error(
      await post(f.staff.admin, "/api/branches", {
        ...child.request,
        name: "Other",
      }),
      409,
      "BRANCH_EXISTS",
    );
    error(
      await post(f.staff.waiter, "/api/branches", {
        ...child.request,
        id: "banani",
        requestKey: key(),
      }),
      403,
      "PLATFORM_ADMIN_REQUIRED",
    );
    const digest = await passwordHash(password);
    await f.store.staff.insertOne({
      username: "branch-admin",
      name: "Branch manager",
      role: "admin",
      active: true,
      passwordHash: digest,
      branchIds: ["uttara"],
      authVersion: 0,
    });
    const local = f.browser();
    ok(await post(local, "/api/branches/select", { branchId: "uttara" }));
    ok(
      await post(local, "/api/staff/login", {
        username: "branch-admin",
        password,
      }),
    );
    assert.deepEqual(ok(await local("/api/staff/team")).users, []);
    const rootAdmin = await f.store.staff.findOne({ username: "admin" });
    error(
      await patch(local, "/api/staff/team/" + rootAdmin._id, {
        name: "Changed",
        role: "admin",
        active: true,
        reason: "Unauthorized target",
        currentPassword: password,
      }),
      403,
      "STAFF_SCOPE",
    );
    error(
      await post(local, "/api/staff/team", {
        username: "escalate",
        name: "Escalating manager",
        role: "admin",
        password,
        currentPassword: password,
      }),
      403,
      "STAFF_SCOPE",
    );
    const created = ok(
      await post(local, "/api/staff/team", {
        username: "uttara-waiter",
        name: "Uttara waiter",
        role: "waiter",
        password,
        currentPassword: password,
      }),
      201,
    ).user;
    assert.deepEqual(created.branchIds, ["uttara"]);
    assert.equal(
      hasPermission(
        await f.store.staff.findOne({ username: "uttara-waiter" }),
        "orders.serve",
      ),
      true,
    );
  } finally {
    await child.store.db.dropDatabase();
  }
});
test("custom permission changes revoke every session, keep branch scope and guard view/action alternatives", async (t) => {
  const f = await fixture(t),
    cashier = await f.store.staff.findOne({ username: "cashier" });
  const profile = {
    branchIds: ["main"],
    denied: ["billing.manage", "reports.view", "printing.receipt"],
    limitsMinor: limits,
    expectedAuthVersion: 0,
    currentPassword: password,
    reason: "Counter permissions reviewed",
  };
  ok(
    await patch(
      f.staff.admin,
      "/api/staff/team/" + cashier._id + "/access",
      profile,
    ),
  );
  error(await f.staff.cashier("/api/staff/me"), 401, "STAFF_REQUIRED");
  const limited = f.browser();
  ok(
    await post(limited, "/api/staff/login", { username: "cashier", password }),
  );
  error(
    await post(limited, "/api/staff/billing/T01/finalize"),
    403,
    "PERMISSION_DENIED",
  );
  error(await limited("/api/staff/reports/sales"), 403, "PERMISSION_DENIED");
  assert.equal(ok(await limited("/api/staff/overview")).sales, 0);
  error(
    await patch(
      f.staff.admin,
      "/api/staff/team/" + cashier._id + "/access",
      profile,
    ),
    409,
    "ACCESS_CHANGED",
  );
  const admin = await f.store.staff.findOne({ username: "admin" });
  error(
    await patch(f.staff.admin, "/api/staff/team/" + admin._id + "/access", {
      ...profile,
      denied: [],
    }),
    409,
    "OWN_ACCESS",
  );
});
test("refund and purchase approval limits are checked against stored money inside the approving transaction", async (t) => {
  const f = await fixture(t),
    digest = await passwordHash(password);
  await f.store.staff.insertOne({
    username: "limited-admin",
    role: "admin",
    active: true,
    passwordHash: digest,
    authVersion: 0,
    branchIds: ["main"],
    access: {
      denied: [],
      limitsMinor: {
        ...limits,
        refundApproval: 1000,
        purchaseApproval: 1000,
        purchasePayment: 1000,
        expenseApproval: 1000,
      },
    },
  });
  const limited = f.browser();
  ok(
    await post(limited, "/api/staff/login", {
      username: "limited-admin",
      password,
    }),
  );
  const bill = await f.finalized(f.browser());
  ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
  );
  const payment = (
    await f.store.bills.findOne({
      _id: (await import("mongodb")).ObjectId.createFromHexString(bill.id),
    })
  ).payments[0];
  const refund = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/refunds", {
      paymentId: payment.id,
      amountMinor: 2000,
      reason: "Customer approved return",
      requestKey: key(),
    }),
    201,
  ).refund;
  error(
    await post(limited, "/api/staff/refunds/" + refund.id + "/decision", {
      decision: "approve",
      reason: "Manager reviewed amount",
    }),
    403,
    "APPROVAL_LIMIT",
  );
  assert.equal(
    (await f.store.refunds.findOne({ _id: refund.id })).status,
    "requested",
  );
  const ingredient = ok(
    await post(f.staff.admin, "/api/staff/inventory/ingredients", {
      name: "Test rice",
      unit: "g",
      initialStock: 0,
      reorderLevel: 10,
    }),
    201,
  ).ingredient;
  const supplier = ok(
    await post(f.staff.admin, "/api/staff/suppliers", {
      name: "Test supplier",
      contact: "",
      phone: "",
      email: "",
      address: "",
      notes: "",
      active: true,
    }),
    201,
  ).supplier;
  const purchase = ok(
    await post(f.staff.admin, "/api/staff/purchases", {
      supplierId: supplier.id,
      lines: [
        {
          ingredientId: ingredient.id,
          quantity: 100,
          unitPriceMinor: 2000,
          pricePerQuantity: 100,
        },
      ],
      dueOn: "",
      notes: "",
      requestKey: key(),
    }),
    201,
  ).purchase;
  error(
    await post(limited, "/api/staff/purchases/" + purchase.id + "/action", {
      action: "order",
      expectedRevision: purchase.revision,
      reason: "Approve stored purchase amount",
    }),
    403,
    "APPROVAL_LIMIT",
  );
  assert.equal(
    (
      await f.store.purchases.findOne({
        _id: (await import("mongodb")).ObjectId.createFromHexString(
          purchase.id,
        ),
      })
    ).status,
    "draft",
  );
});
test("restricted administrators cannot reset broader accounts or grant larger approval limits through another account", async (t) => {
  const f = await fixture(t);
  await f.store.staff.insertOne({
    username: "limited-access",
    role: "admin",
    active: true,
    passwordHash: await passwordHash(password),
    branchIds: ["main"],
    authVersion: 0,
    access: {
      denied: ["refund.execute"],
      limitsMinor: { ...limits, refundApproval: 1000 },
    },
  });
  const limited = f.browser();
  ok(
    await post(limited, "/api/staff/login", {
      username: "limited-access",
      password,
    }),
  );
  const root = await f.store.staff.findOne({ username: "admin" });
  error(
    await post(limited, "/api/staff/team/" + root._id + "/password", {
      newPassword: password + "new",
      currentPassword: password,
      reason: "Attempted broader account reset",
    }),
    403,
    "STAFF_PRIVILEGE",
  );
  const target = ok(
    await post(limited, "/api/staff/team", {
      username: "limited-child",
      name: "Limited delegate",
      role: "admin",
      password,
      currentPassword: password,
    }),
    201,
  ).user;
  assert.equal(target.limitsMinor.refundApproval, 1000);
  assert.ok(target.denied.includes("refund.execute"));
  error(
    await patch(limited, "/api/staff/team/" + target.id + "/access", {
      branchIds: ["main"],
      denied: [],
      limitsMinor: limits,
      expectedAuthVersion: 0,
      currentPassword: password,
      reason: "Attempted larger delegation",
    }),
    403,
    "STAFF_PRIVILEGE",
  );
});
