import { z } from "zod";
import { body, HttpError } from "./http.js";
import { transaction } from "./money.js";
import {
  isPlatformAdmin,
  identityStaff,
  effectiveStaff,
  hasPermission,
  memberBranches,
  permissionKeys,
  assertManageStaff,
} from "./access.js";
const amount = z.number().int().min(0).max(10_000_000_000).nullable();
const profile = z
  .strictObject({
    role: z.enum(["admin", "kitchen", "waiter", "cashier"]),
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
  })
  .nullable();
export function registerBranchStaff(api, store, helpers) {
  const {
    requireAdmin,
    requireId,
    view,
    limit,
    reauthenticate,
    lockAdministrator,
  } = helpers;
  api.patch(
    "/team/:id/branch-access",
    requireAdmin,
    limit,
    async (req, res) => {
      if (
        !isPlatformAdmin(req.staff) ||
        !hasPermission(identityStaff(req.staff), "staff.manage")
      )
        throw new HttpError(
          403,
          "PLATFORM_ADMIN_REQUIRED",
          "A main-branch administrator manages branch role profiles.",
        );
      const input = body(
          z.strictObject({
            branchId: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
            profile,
            expectedAuthVersion: z.number().int().min(0),
            currentPassword: z.string().min(1).max(128),
            reason: z.string().trim().min(3).max(160),
          }),
          req.body,
        ),
        id = requireId(req.params.id);
      if (id.equals(req.staff._id))
        throw new HttpError(
          409,
          "OWN_ACCESS",
          "Use another main-branch administrator to change your own branch role.",
        );
      await reauthenticate(store, req, input.currentPassword);
      const user = await transaction(store, async (session) => {
        await lockAdministrator(store, req, session);
        const target = await store.staff.findOne({ _id: id }, { session });
        if (!target)
          throw new HttpError(404, "NOT_FOUND", "Staff account not found.");
        if ((target.authVersion || 0) !== input.expectedAuthVersion)
          throw new HttpError(
            409,
            "ACCESS_CHANGED",
            "This account changed. Reload before saving a branch role.",
          );
        if (
          !(await store.branches.findOne(
            { _id: input.branchId, active: true, state: "ready" },
            { session },
          )) ||
          (!isPlatformAdmin(target) &&
            !memberBranches(target).includes(input.branchId))
        )
          throw new HttpError(
            400,
            "BRANCH_ASSIGNMENT",
            "Assign this staff member to the active branch before setting its role.",
          );
        assertManageStaff(req.staff, target, store.branchId);
        const branchAccess = { ...target.branchAccess };
        if (input.profile)
          branchAccess[input.branchId] = {
            role: input.profile.role,
            access: {
              denied: input.profile.denied,
              limitsMinor: input.profile.limitsMinor,
            },
          };
        else delete branchAccess[input.branchId];
        const after = { ...target, branchAccess };
        assertManageStaff(req.staff, after, store.branchId);
        if (
          isPlatformAdmin(target) &&
          input.branchId === "main" &&
          !hasPermission(effectiveStaff(after, "main"), "staff.manage")
        ) {
          const others = await store.staff
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
          if (
            !others.some(
              (u) =>
                hasPermission(u, "staff.manage") &&
                hasPermission(effectiveStaff(u, "main"), "staff.manage"),
            )
          )
            throw new HttpError(
              409,
              "LAST_ADMIN",
              "Keep an active main-branch administrator with staff management access.",
            );
        }
        const changed = await store.staff.findOneAndUpdate(
          { _id: id },
          {
            $set: { branchAccess, updatedAt: new Date() },
            $inc: { authVersion: 1 },
          },
          { session, returnDocument: "after" },
        );
        await store.sessions.deleteMany({ staffId: id }, { session });
        await store.staffMfaChallenges.deleteMany({ staffId: id }, { session });
        await store.staffMfaEnrollments.deleteOne({ _id: id }, { session });
        await store.audit.insertOne(
          {
            type: "staff.branch_role_updated",
            staffId: id,
            branchId: input.branchId,
            before: target.branchAccess?.[input.branchId] || null,
            after: branchAccess[input.branchId] || null,
            by: req.staff.username,
            reason: input.reason,
            at: new Date(),
          },
          { session },
        );
        return changed;
      });
      res.json({ user: view(user) });
    },
  );
}
