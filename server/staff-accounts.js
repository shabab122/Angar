import {
  memberBranches,
  isPlatformAdmin,
  capabilities,
  assertManageStaff,
  inheritedAccess,
  mergeInheritedAccess,
  hasBranchAccess,
  hasPermission,
  permissionCatalog,
  permissionKeys,
} from "./access.js";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { body, HttpError } from "./http.js";
import {
  passwordHash,
  passwordMatches,
  STAFF_COOKIE,
  STAFF_ROLES,
  cookieOptions,
} from "./security.js";
import { transaction } from "./money.js";

export const staffIdentity = (user) => ({
  branchIds: memberBranches(user),
  platformAdmin: isPlatformAdmin(user),
  capabilities: capabilities(user),
  limitsMinor: user.access?.limitsMinor || {},
  username: user.username,
  role: user.role,
  name: user.name || user.username,
  mustChangePassword: Boolean(user.mustChangePassword),
  mfaEnabled: Boolean(user.mfa?.enabled),
});
const reason = z.string().trim().min(3).max(160);
const name = z.string().trim().min(2).max(80);
const password = z.string().min(12).max(128);
const currentPassword = z.string().min(1).max(128);
const userView = (user) => ({
  id: user._id.toString(),
  authVersion: user.authVersion || 0,
  denied: user.access?.denied || [],
  ...staffIdentity(user),
  active: user.active,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
});
async function reauthenticate(store, req, input) {
  const user = await store.staff.findOne({
    _id: req.staff._id,
    active: true,
    role: "admin",
  });
  if (!(await passwordMatches(input, user?.passwordHash)))
    throw new HttpError(
      401,
      "PASSWORD_REQUIRED",
      "Your administrator password is incorrect.",
    );
}
async function lockAdministrator(store, req, session) {
  await store.identitySettings.updateOne(
    { _id: "staff-access-lock" },
    { $inc: { revision: 1 } },
    { upsert: true, session },
  );
  const actor = await store.staff.findOneAndUpdate(
    { _id: req.staff._id, active: true, role: "admin" },
    { $inc: { accessRevision: 1 } },
    { session, returnDocument: "after" },
  );
  if (
    !actor ||
    (actor.authVersion || 0) !== (req.staff.authVersion || 0) ||
    !hasBranchAccess(actor, store.branchId) ||
    !hasPermission(actor, "staff.manage")
  )
    throw new HttpError(
      401,
      "STAFF_REQUIRED",
      "Your access changed. Sign in again.",
    );
}

export { userView as staffAccountView };
export function registerStaffAccounts(
  api,
  store,
  config,
  requireAdmin,
  requireId,
) {
  const limit = rateLimit({
    windowMs: 15 * 60000,
    limit: 25,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMIT",
        message: "Too many staff access changes. Try again later.",
      },
    },
  });
  api.get("/access-catalog", requireAdmin, async (req, res) =>
    res.json({
      permissions: permissionCatalog.map(([key, label, roles]) => ({
        key,
        label,
        roles,
      })),
      limits: [
        "refundApproval",
        "purchaseApproval",
        "purchasePayment",
        "expenseApproval",
      ],
      branches: (
        await store.branches
          .find({ active: true, state: "ready" })
          .sort({ _id: 1 })
          .toArray()
      ).map((row) => ({ id: row._id, name: row.name })),
    }),
  );
  api.patch("/team/:id/access", requireAdmin, limit, async (req, res) => {
    if (!isPlatformAdmin(req.staff))
      throw new HttpError(
        403,
        "PLATFORM_ADMIN_REQUIRED",
        "A main-branch administrator manages shared permissions and branch assignments.",
      );
    const amount = z.number().int().min(0).max(10_000_000_000).nullable();
    const input = body(
      z.strictObject({
        branchIds: z
          .array(z.string().regex(/^[a-z][a-z0-9-]{1,23}$/))
          .min(1)
          .max(20)
          .refine((v) => new Set(v).size === v.length),
        denied: z
          .array(z.enum(permissionKeys))
          .max(permissionKeys.length)
          .refine((v) => new Set(v).size === v.length),
        limitsMinor: z.strictObject({
          refundApproval: amount,
          purchaseApproval: amount,
          purchasePayment: amount,
          expenseApproval: amount,
        }),
        expectedAuthVersion: z.number().int().min(0),
        currentPassword,
        reason,
      }),
      req.body,
    );
    const id = requireId(req.params.id);
    if (id.equals(req.staff._id))
      throw new HttpError(
        409,
        "OWN_ACCESS",
        "Use another main-branch administrator to change your own permissions.",
      );
    await reauthenticate(store, req, input.currentPassword);
    const user = await transaction(store, async (session) => {
      await lockAdministrator(store, req, session);
      if (
        (await store.branches.countDocuments(
          { _id: { $in: input.branchIds }, active: true, state: "ready" },
          { session },
        )) !== input.branchIds.length
      )
        throw new HttpError(
          400,
          "BRANCH_UNAVAILABLE",
          "Assign only active, provisioned branches.",
        );
      const target = await store.staff.findOne({ _id: id }, { session });
      if (!target)
        throw new HttpError(404, "NOT_FOUND", "Staff account not found.");
      if ((target.authVersion || 0) !== input.expectedAuthVersion)
        throw new HttpError(
          409,
          "ACCESS_CHANGED",
          "This staff account changed. Refresh before saving.",
        );
      assertManageStaff(req.staff, target, store.branchId);
      const after = {
        ...target,
        branchIds: input.branchIds,
        access: { denied: input.denied, limitsMinor: input.limitsMinor },
      };
      assertManageStaff(req.staff, after, store.branchId);
      if (
        isPlatformAdmin(target) &&
        hasPermission(target, "staff.manage") &&
        (!isPlatformAdmin(after) || !hasPermission(after, "staff.manage"))
      ) {
        const other = await store.staff
          .find(
            {
              _id: { $ne: id },
              active: true,
              role: "admin",
              $or: [{ branchIds: "main" }, { branchIds: { $exists: false } }],
            },
            { session },
          )
          .toArray();
        if (!other.some((u) => hasPermission(u, "staff.manage")))
          throw new HttpError(
            409,
            "LAST_ADMIN",
            "Keep an active main-branch administrator with staff management permission.",
          );
      }
      const changed = await store.staff.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            branchIds: input.branchIds,
            access: after.access,
            updatedAt: new Date(),
          },
          $inc: { authVersion: 1 },
        },
        { session, returnDocument: "after" },
      );
      await store.sessions.deleteMany({ staffId: id }, { session });
      await store.staffMfaChallenges.deleteMany({ staffId: id }, { session });
      await store.staffMfaEnrollments.deleteOne({ _id: id }, { session });
      await store.audit.insertOne(
        {
          type: "staff.permissions_updated",
          staffId: id,
          before: {
            branchIds: memberBranches(target),
            access: target.access || {},
          },
          after: { branchIds: input.branchIds, access: after.access },
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return changed;
    });
    res.json({ user: userView(user) });
  });
  api.get("/team", requireAdmin, async (req, res) => {
    const users = await store.staff
      .find(
        isPlatformAdmin(req.staff)
          ? {}
          : { branchIds: [store.branchId], role: { $ne: "admin" } },
      )
      .sort({ active: -1, username: 1 })
      .limit(250)
      .toArray();
    res.json({
      users: users.map(userView),
      roles: isPlatformAdmin(req.staff)
        ? STAFF_ROLES
        : STAFF_ROLES.filter((role) => role !== "admin"),
    });
  });
  api.post("/team", requireAdmin, limit, async (req, res) => {
    const input = body(
      z.strictObject({
        username: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9_-]{3,32}$/),
        name,
        role: z.enum(STAFF_ROLES),
        password,
        currentPassword,
      }),
      req.body,
    );
    await reauthenticate(store, req, input.currentPassword);
    if (input.role === "admin" && !isPlatformAdmin(req.staff))
      throw new HttpError(
        403,
        "STAFF_SCOPE",
        "A main-branch administrator creates administrator accounts.",
      );
    const digest = await passwordHash(input.password);
    try {
      const user = await transaction(store, async (session) => {
        await lockAdministrator(store, req, session);
        if ((await store.staff.countDocuments({}, { session })) >= 250)
          throw new HttpError(
            409,
            "STAFF_LIMIT",
            "This restaurant reached its staff account limit.",
          );
        const user = {
          _id: new ObjectId(),
          username: input.username,
          name: input.name,
          role: input.role,
          branchIds: [store.branchId || "main"],
          access: inheritedAccess(req.staff, input.role),
          active: true,
          passwordHash: digest,
          authVersion: 0,
          mustChangePassword: true,
          createdAt: new Date(),
          createdBy: req.staff.username,
        };
        await store.staff.insertOne(user, { session });
        await store.audit.insertOne(
          {
            type: "staff.created",
            staffId: user._id,
            username: user.username,
            role: user.role,
            by: req.staff.username,
            at: new Date(),
          },
          { session },
        );
        return user;
      });
      res.status(201).json({ user: userView(user) });
    } catch (error) {
      if (error.code === 11000)
        throw new HttpError(
          409,
          "USERNAME_EXISTS",
          "This username is already in use.",
        );
      throw error;
    }
  });
  api.patch("/team/:id", requireAdmin, limit, async (req, res) => {
    const input = body(
      z.strictObject({
        name,
        role: z.enum(STAFF_ROLES),
        active: z.boolean(),
        reason,
        currentPassword,
      }),
      req.body,
    );
    await reauthenticate(store, req, input.currentPassword);
    const user = await transaction(store, async (session) => {
      await lockAdministrator(store, req, session);
      const existing = await store.staff.findOne(
        { _id: requireId(req.params.id) },
        { session },
      );
      if (!existing)
        throw new HttpError(404, "NOT_FOUND", "Staff account not found.");
      assertManageStaff(req.staff, existing, store.branchId);
      if (input.role === "admin" && !isPlatformAdmin(req.staff))
        throw new HttpError(
          403,
          "STAFF_SCOPE",
          "Only a main-branch administrator can grant administrator access.",
        );
      if (
        isPlatformAdmin(existing) &&
        (input.role !== "admin" || !input.active) &&
        (await store.staff.countDocuments(
          {
            _id: { $ne: existing._id },
            active: true,
            role: "admin",
            $or: [{ branchIds: "main" }, { branchIds: { $exists: false } }],
          },
          { session },
        )) === 0
      )
        throw new HttpError(
          409,
          "LAST_ADMIN",
          "Keep an active main-branch administrator.",
        );
      if (
        existing.role === "admin" &&
        existing.active &&
        (input.role !== "admin" || !input.active) &&
        (await store.staff.countDocuments(
          { role: "admin", active: true },
          { session },
        )) <= 1
      )
        throw new HttpError(
          409,
          "LAST_ADMIN",
          "Keep at least one active administrator.",
        );
      if (
        existing._id.equals(req.staff._id) &&
        (input.role !== "admin" || !input.active)
      )
        throw new HttpError(
          409,
          "OWN_ACCESS",
          "Use another administrator account to change your own role or deactivate access.",
        );
      const changed =
        existing.role !== input.role || existing.active !== input.active;
      const user = await store.staff.findOneAndUpdate(
        { _id: existing._id },
        {
          $set: {
            name: input.name,
            role: input.role,
            ...(existing.role !== input.role
              ? {
                  access: mergeInheritedAccess(
                    req.staff,
                    input.role,
                    existing.access,
                  ),
                }
              : {}),
            active: input.active,
            updatedAt: new Date(),
          },
          ...(changed ? { $inc: { authVersion: 1 } } : {}),
        },
        { session, returnDocument: "after" },
      );
      if (changed)
        await store.sessions.deleteMany({ staffId: existing._id }, { session });
      await store.audit.insertOne(
        {
          type: "staff.access_updated",
          staffId: existing._id,
          before: { role: existing.role, active: existing.active },
          after: { role: input.role, active: input.active },
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return user;
    });
    res.json({ user: userView(user) });
  });
  api.post("/team/:id/password", requireAdmin, limit, async (req, res) => {
    const input = body(
      z.strictObject({ newPassword: password, currentPassword, reason }),
      req.body,
    );
    await reauthenticate(store, req, input.currentPassword);
    const id = requireId(req.params.id);
    if (id.equals(req.staff._id))
      throw new HttpError(
        409,
        "OWN_ACCESS",
        "Change your own password from My access.",
      );
    const digest = await passwordHash(input.newPassword);
    await transaction(store, async (session) => {
      await lockAdministrator(store, req, session);
      const existing = await store.staff.findOne({ _id: id }, { session });
      if (!existing)
        throw new HttpError(404, "NOT_FOUND", "Staff account not found.");
      assertManageStaff(req.staff, existing, store.branchId);
      const target = await store.staff.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            passwordHash: digest,
            mustChangePassword: true,
            passwordChangedAt: new Date(),
          },
          $inc: { authVersion: 1 },
        },
        { session },
      );
      if (!target)
        throw new HttpError(404, "NOT_FOUND", "Staff account not found.");
      await store.sessions.deleteMany({ staffId: id }, { session });
      await store.audit.insertOne(
        {
          type: "staff.password_reset",
          staffId: id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.status(204).end();
  });
  api.post("/password", limit, async (req, res) => {
    const input = body(
      z.strictObject({ currentPassword, newPassword: password }),
      req.body,
    );
    const user = await store.staff.findOne({
      _id: req.staff._id,
      active: true,
    });
    if (!(await passwordMatches(input.currentPassword, user?.passwordHash)))
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "The current password is incorrect.",
      );
    if (input.newPassword === input.currentPassword)
      throw new HttpError(
        400,
        "PASSWORD_UNCHANGED",
        "Choose a different new password.",
      );
    const digest = await passwordHash(input.newPassword);
    await transaction(store, async (session) => {
      const result = await store.staff.updateOne(
        { _id: user._id, passwordHash: user.passwordHash, active: true },
        {
          $set: {
            passwordHash: digest,
            mustChangePassword: false,
            passwordChangedAt: new Date(),
          },
          $inc: { authVersion: 1 },
        },
        { session },
      );
      if (!result.matchedCount)
        throw new HttpError(
          409,
          "ACCESS_CHANGED",
          "Your access changed. Sign in again.",
        );
      await store.sessions.deleteMany({ staffId: user._id }, { session });
      await store.audit.insertOne(
        {
          type: "staff.password_changed",
          staffId: user._id,
          by: user.username,
          at: new Date(),
        },
        { session },
      );
    });
    res.clearCookie(STAFF_COOKIE, cookieOptions(config));
    res.status(204).end();
  });
}
