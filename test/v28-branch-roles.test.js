import test from "node:test";
import assert from "node:assert/strict";
import { fixture, post, patch, ok, error, password } from "./support.js";
import { branch, limits } from "./v28-support.js";
import { effectiveStaff, isPlatformAdmin } from "../server/access.js";
const profile = (role, extra = {}) => ({
  role,
  denied: [],
  limitsMinor: { ...limits },
  ...extra,
});
test("default access changes cannot remove the last manager who can actually manage the main branch", async (t) => {
  const f = await fixture(t);
  await branch(t, f);
  const root = await f.store.staff.findOne({ username: "admin" }),
    actor = {
      username: "other-platform-admin",
      role: "admin",
      active: true,
      passwordHash: root.passwordHash,
      branchIds: ["main"],
      authVersion: 0,
      branchAccess: {
        main: { role: "kitchen", access: { denied: [], limitsMinor: limits } },
      },
    };
  await f.store.staff.insertOne(actor);
  const client = f.browser();
  ok(await post(client, "/api/branches/select", { branchId: "uttara" }));
  ok(
    await post(client, "/api/staff/login", {
      username: actor.username,
      password,
    }),
  );
  error(
    await patch(client, "/api/staff/team/" + root._id + "/access", {
      branchIds: ["main"],
      denied: ["staff.manage"],
      limitsMinor: limits,
      expectedAuthVersion: 0,
      currentPassword: password,
      reason: "Attempt to leave no usable main manager",
    }),
    403,
    "STAFF_PRIVILEGE",
  );
});
async function setProfile(f, target, branchId, settings, version = 0) {
  return patch(
    f.staff.admin,
    "/api/staff/team/" + target._id + "/branch-access",
    {
      branchId,
      profile: settings,
      expectedAuthVersion: version,
      currentPassword: password,
      reason: "Branch duties reviewed by manager",
    },
  );
}
test("one identity receives different branch roles, denied actions and amount limits without gaining platform authority", async (t) => {
  const f = await fixture(t);
  await branch(t, f);
  const user = await f.store.staff.findOne({ username: "waiter" });
  await f.store.staff.updateOne(
    { _id: user._id },
    { $set: { branchIds: ["main", "uttara"] } },
  );
  ok(
    await setProfile(
      f,
      user,
      "uttara",
      profile("cashier", {
        denied: ["reports.view"],
        limitsMinor: { ...limits, purchasePayment: 1000 },
      }),
    ),
  );
  error(await f.staff.waiter("/api/staff/me"), 401, "STAFF_REQUIRED");
  const current = f.browser();
  ok(await post(current, "/api/staff/login", { username: "waiter", password }));
  assert.equal(ok(await current("/api/staff/me")).role, "waiter");
  ok(await post(current, "/api/branches/select", { branchId: "uttara" }));
  const identity = ok(await current("/api/staff/me"));
  assert.equal(identity.role, "cashier");
  assert.equal(identity.limitsMinor.purchasePayment, 1000);
  assert.equal(identity.capabilities["orders.serve"], false);
  error(await current("/api/staff/reports/sales"), 403, "PERMISSION_DENIED");
  error(
    await current("/api/organization/dashboard"),
    403,
    "PLATFORM_ADMIN_REQUIRED",
  );
  assert.equal(identity.platformAdmin, false);
  ok(await setProfile(f, user, "uttara", profile("admin"), 1));
  error(await current("/api/staff/me"), 401, "STAFF_REQUIRED");
  ok(await post(current, "/api/staff/login", { username: "waiter", password }));
  assert.equal(ok(await current("/api/staff/me")).role, "admin");
  error(await current("/api/monitoring"), 403, "PLATFORM_ADMIN_REQUIRED");
  error(await current("/api/branches/manage"), 403, "PLATFORM_ADMIN_REQUIRED");
  assert.equal(
    isPlatformAdmin(
      effectiveStaff(await f.store.staff.findOne({ _id: user._id }), "uttara"),
    ),
    false,
  );
  ok(await setProfile(f, user, "uttara", null, 2));
  error(await current("/api/staff/me"), 401, "STAFF_REQUIRED");
  ok(await post(current, "/api/staff/login", { username: "waiter", password }));
  assert.equal(ok(await current("/api/staff/me")).role, "waiter");
});
test("branch overrides require membership, fresh versions and another authorized administrator", async (t) => {
  const f = await fixture(t);
  await branch(t, f);
  const user = await f.store.staff.findOne({ username: "waiter" }),
    admin = await f.store.staff.findOne({ username: "admin" });
  error(
    await setProfile(f, user, "uttara", profile("admin")),
    400,
    "BRANCH_ASSIGNMENT",
  );
  error(
    await setProfile(f, admin, "main", profile("kitchen")),
    409,
    "OWN_ACCESS",
  );
  ok(await setProfile(f, user, "main", profile("cashier")));
  error(
    await setProfile(f, user, "main", profile("waiter")),
    409,
    "ACCESS_CHANGED",
  );
  const assigned = ok(await f.staff.admin("/api/staff/team")).users.find(
    (row) => row.id === String(user._id),
  );
  assert.equal(assigned.branchAccess.main.role, "cashier");
});
test("branch-specific approval limits are re-read inside actual purchase approval transactions", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    user = await f.store.staff.findOne({ username: "waiter" });
  await f.store.staff.updateOne(
    { _id: user._id },
    { $set: { branchIds: ["main", "uttara"] } },
  );
  ok(
    await setProfile(
      f,
      user,
      "uttara",
      profile("admin", { limitsMinor: { ...limits, purchaseApproval: 1000 } }),
    ),
  );
  const client = f.browser();
  ok(await post(client, "/api/branches/select", { branchId: "uttara" }));
  ok(await post(client, "/api/staff/login", { username: "waiter", password }));
  const rice = ok(
      await post(client, "/api/staff/inventory/ingredients", {
        name: "Approval rice",
        unit: "g",
        initialStock: 0,
        reorderLevel: 10,
      }),
      201,
    ).ingredient,
    supplier = ok(
      await post(client, "/api/staff/suppliers", {
        name: "Branch supplier",
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
    await post(client, "/api/staff/purchases", {
      supplierId: supplier.id,
      lines: [
        {
          ingredientId: rice.id,
          quantity: 100,
          unitPriceMinor: 1500,
          pricePerQuantity: 100,
        },
      ],
      dueOn: "",
      notes: "",
      requestKey: "e".repeat(32),
    }),
    201,
  ).purchase;
  error(
    await post(client, "/api/staff/purchases/" + purchase.id + "/action", {
      action: "order",
      expectedRevision: purchase.revision,
      reason: "Actual amount exceeds branch limit",
    }),
    403,
    "APPROVAL_LIMIT",
  );
  assert.equal(
    (await child.store.purchases.findOne({ code: purchase.code })).status,
    "draft",
  );
});
test("administrators with lower branch limits cannot grant broader branch profiles through a shared identity", async (t) => {
  const f = await fixture(t);
  await branch(t, f);
  const base = await f.store.staff.findOne({ username: "admin" });
  const limited = {
    username: "limited-branch",
    role: "admin",
    active: true,
    passwordHash: base.passwordHash,
    authVersion: 0,
    branchIds: ["main"],
    access: { denied: [], limitsMinor: limits },
    branchAccess: {
      uttara: {
        role: "admin",
        access: {
          denied: [],
          limitsMinor: { ...limits, refundApproval: 1000 },
        },
      },
    },
  };
  await f.store.staff.insertOne(limited);
  const target = await f.store.staff.findOne({ username: "waiter" });
  await f.store.staff.updateOne(
    { _id: target._id },
    { $set: { branchIds: ["main", "uttara"] } },
  );
  const client = f.browser();
  ok(
    await post(client, "/api/staff/login", {
      username: limited.username,
      password,
    }),
  );
  error(
    await patch(client, "/api/staff/team/" + target._id + "/branch-access", {
      branchId: "uttara",
      profile: profile("admin"),
      expectedAuthVersion: 0,
      currentPassword: password,
      reason: "Attempt broader branch approval",
    }),
    403,
    "STAFF_PRIVILEGE",
  );
});
test("the administrator MFA requirement follows an effective branch role", async (t) => {
  const f = await fixture(t, { staffMfa: { requireAdmin: true, key: "" } }),
    admin = await f.store.staff.findOne({ username: "admin" }),
    user = await f.store.staff.findOne({ username: "waiter" });
  await f.store.staff.updateOne(
    { _id: user._id },
    {
      $set: {
        branchAccess: {
          main: { role: "admin", access: { denied: [], limitsMinor: limits } },
        },
      },
    },
  );
  const client = f.browser(),
    login = ok(
      await post(client, "/api/staff/login", { username: "waiter", password }),
    );
  assert.equal(login.mfaSetupRequired, true);
  error(await client("/api/staff/overview"), 403, "MFA_REQUIRED");
  assert.equal(ok(await client("/api/staff/mfa")).required, true);
  assert.equal(Boolean(admin.mfa), false);
});
