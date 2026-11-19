import test from "node:test";
import assert from "node:assert/strict";
import { fixture, post, patch, ok, error, password } from "./support.js";

test("individual staff accounts require a personal password, enforce roles and revoke all old sessions", async (t) => {
  const f = await fixture(t),
    newUser = {
      username: "floor_member",
      name: "Floor Member",
      role: "waiter",
      password: "Temporary-floor-password-123!",
      currentPassword: password,
    };
  error(await post(f.staff.cashier, "/api/staff/team", newUser), 403);
  const user = ok(
    await post(f.staff.admin, "/api/staff/team", newUser),
    201,
  ).user;
  assert.equal(user.mustChangePassword, true);
  assert.equal(user.passwordHash, undefined);
  const first = f.browser(),
    second = f.browser();
  ok(
    await post(first, "/api/staff/login", {
      username: newUser.username,
      password: newUser.password,
    }),
  );
  error(await first("/api/staff/orders"), 403, "PASSWORD_CHANGE_REQUIRED");
  error(
    await post(first, "/api/staff/password", {
      currentPassword: "Wrong",
      newPassword: password,
    }),
    401,
  );
  const personal = "Personal-floor-password-456!";
  ok(
    await post(first, "/api/staff/password", {
      currentPassword: newUser.password,
      newPassword: personal,
    }),
    204,
  );
  error(await first("/api/staff/me"), 401);
  for (const browser of [first, second])
    ok(
      await post(browser, "/api/staff/login", {
        username: newUser.username,
        password: personal,
      }),
    );
  error(await first("/api/staff/team"), 403);
  ok(await first("/api/staff/orders"));
  const edited = {
    name: "Kitchen Member",
    role: "kitchen",
    active: true,
    reason: "Transferred to kitchen",
    currentPassword: password,
  };
  ok(await patch(f.staff.admin, "/api/staff/team/" + user.id, edited));
  error(await first("/api/staff/me"), 401);
  error(await second("/api/staff/me"), 401);
  assert.equal(
    ok(
      await post(first, "/api/staff/login", {
        username: newUser.username,
        password: personal,
      }),
    ).role,
    "kitchen",
  );
  ok(
    await post(f.staff.admin, "/api/staff/team/" + user.id + "/password", {
      currentPassword: password,
      newPassword: newUser.password,
      reason: "Temporary password requested",
    }),
    204,
  );
  error(await first("/api/staff/me"), 401);
  ok(
    await patch(f.staff.admin, "/api/staff/team/" + user.id, {
      ...edited,
      active: false,
      reason: "Employment ended",
    }),
  );
  error(
    await post(first, "/api/staff/login", {
      username: newUser.username,
      password: newUser.password,
    }),
    401,
  );
});

test("staff changes require administrator reauthentication and cannot disable the last admin", async (t) => {
  const f = await fixture(t),
    team = ok(await f.staff.admin("/api/staff/team")),
    admin = team.users.find((row) => row.username === "admin");
  const edit = {
    name: "Admin",
    role: "waiter",
    active: false,
    reason: "Change requested",
    currentPassword: password,
  };
  error(
    await patch(f.staff.admin, "/api/staff/team/" + admin.id, {
      ...edit,
      currentPassword: "wrong",
    }),
    401,
    "PASSWORD_REQUIRED",
  );
  error(
    await patch(f.staff.admin, "/api/staff/team/" + admin.id, edit),
    409,
    "LAST_ADMIN",
  );
  assert.equal(
    (await f.store.staff.findOne({ username: "admin" })).active,
    true,
  );
  const response = await f.staff.admin("/api/staff/team");
  assert.equal(response.text.includes("passwordHash"), false);
  assert.equal(response.text.includes(password), false);
});

test("two administrators changing each other's access concurrently cannot remove both administrators", async (t) => {
  const f = await fixture(t),
    second = f.browser();
  const user = ok(
    await post(f.staff.admin, "/api/staff/team", {
      username: "second_admin",
      name: "Second Administrator",
      role: "admin",
      password: "Temporary-admin-password-456!",
      currentPassword: password,
    }),
    201,
  ).user;
  ok(
    await post(second, "/api/staff/login", {
      username: "second_admin",
      password: "Temporary-admin-password-456!",
    }),
  );
  ok(
    await post(second, "/api/staff/password", {
      currentPassword: "Temporary-admin-password-456!",
      newPassword: password,
    }),
    204,
  );
  ok(
    await post(second, "/api/staff/login", {
      username: "second_admin",
      password,
    }),
  );
  const admin = (
    await f.store.staff.findOne({ username: "admin" })
  )._id.toString();
  const changes = await Promise.all([
    patch(f.staff.admin, "/api/staff/team/" + user.id, {
      name: user.name,
      role: "waiter",
      active: false,
      reason: "Concurrent test access change",
      currentPassword: password,
    }),
    patch(second, "/api/staff/team/" + admin, {
      name: "Admin",
      role: "waiter",
      active: false,
      reason: "Concurrent test access change",
      currentPassword: password,
    }),
  ]);
  assert.equal(changes.filter((response) => response.status === 200).length, 1);
  assert.equal(
    await f.store.staff.countDocuments({ role: "admin", active: true }),
    1,
  );
});
