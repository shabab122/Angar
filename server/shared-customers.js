import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { transaction } from "./money.js";
import { passwordMatches } from "./security.js";
import { getBranchRuntime } from "./branches.js";
export const customerIds = (customer) =>
  customer ? [customer._id, ...(customer.aliases || [])] : [];
export const ownsCustomer = (customer, id) =>
  Boolean(
    id && customerIds(customer).some((value) => String(value) === String(id)),
  );
function identityFilter(filter) {
  if (filter._id instanceof ObjectId)
    return { $or: [{ _id: filter._id }, { aliases: filter._id }] };
  if (typeof filter.email === "string") return { email: filter.email };
  return null;
}
function aliasFilter(filter) {
  if (!(filter._id instanceof ObjectId)) return filter;
  const { _id, ...rest } = filter;
  return {
    ...rest,
    $and: [...(rest.$and || []), { $or: [{ _id }, { aliases: _id }] }],
  };
}
// Legacy branch documents are retained for unclaimed accounts and old financial
// references. Once linked, all ID-based balance updates resolve to one identity.
export function sharedCustomerCollection(shared, legacy) {
  return new Proxy(shared, {
    get(target, key) {
      if (
        ["findOne", "findOneAndUpdate", "updateOne", "updateMany"].includes(key)
      )
        return async (filter, ...args) => {
          const options = key === "findOne" ? args[0] : args[1],
            identity = identityFilter(filter),
            exists =
              identity &&
              (await shared.findOne(identity, {
                session: options?.session,
                projection: { _id: 1 },
              })),
            collection = exists || shared === legacy ? shared : legacy;
          const result = await collection[key](
            collection === shared ? aliasFilter(filter) : filter,
            ...args,
          );
          return key === "findOne" || key === "findOneAndUpdate"
            ? result
              ? { ...result, _shared: collection === shared }
              : null
            : result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export async function claimLegacyCustomer(
  store,
  config,
  legacy,
  canonical = null,
) {
  if (
    !store.legacyCustomers ||
    store.legacyCustomers.namespace === store.sharedCustomers.namespace
  )
    return canonical || legacy;
  return transaction(store, async (session) => {
    await store.identitySettings.updateOne(
      { _id: "customer-link-lock" },
      { $inc: { revision: 1 } },
      { session, upsert: true },
    );
    const local = await store.legacyCustomers.findOneAndUpdate(
      { _id: legacy._id, active: true },
      { $inc: { migrationRevision: 1 } },
      { session, returnDocument: "after" },
    );
    if (
      local &&
      ((local.authVersion || 0) !== (legacy.authVersion || 0) ||
        local.passwordHash !== legacy.passwordHash) &&
      !local.linkedCustomerId
    )
      throw new HttpError(
        409,
        "ACCOUNT_CHANGED",
        "The branch account changed. Verify its current password again.",
      );
    if (!local)
      throw new HttpError(
        409,
        "ACCOUNT_CHANGED",
        "The legacy account changed. Sign in again.",
      );
    if (local.linkedCustomerId) {
      const linked = await store.sharedCustomers.findOne(
        { _id: local.linkedCustomerId, active: true },
        { session },
      );
      if (!linked || (canonical && !canonical._id.equals(linked._id)))
        throw new HttpError(
          409,
          "ACCOUNT_LINKED",
          "This branch account is already linked to another identity.",
        );
      if (
        !linked.legacyLinks?.some(
          (link) =>
            link.branchId === (store.branchId || "main") &&
            String(link.legacyId) === String(local._id),
        )
      )
        throw new HttpError(
          409,
          "ACCOUNT_RECOVERY",
          "The shared identity and branch link snapshots do not match. An operator must restore compatible account records before linking again.",
        );
      return linked;
    }
    let owner = await store.sharedCustomers.findOne(
      { email: local.email },
      { session },
    );
    if (canonical) {
      if (
        !owner ||
        !owner._id.equals(canonical._id) ||
        (owner.authVersion || 0) !== (canonical.authVersion || 0) ||
        !owner.active
      )
        throw new HttpError(
          409,
          "ACCOUNT_CHANGED",
          "The shared account changed. Sign in again.",
        );
    } else if (owner && !owner._id.equals(local._id))
      throw new HttpError(
        409,
        "ACCOUNT_LINK_REQUIRED",
        "Sign in to the shared account, then link this branch using both account passwords.",
      );
    if (
      owner?.legacyLinks?.some(
        (link) =>
          link.branchId === (store.branchId || "main") &&
          String(link.legacyId) === String(local._id),
      )
    ) {
      await store.legacyCustomers.updateOne(
        { _id: local._id },
        {
          $set: {
            linkedCustomerId: owner._id,
            points: 0,
            linkedAt: new Date(),
          },
        },
        { session },
      );
      return owner;
    }
    if (!Number.isSafeInteger(local.points || 0))
      throw new HttpError(
        409,
        "LOYALTY_REVIEW",
        "This legacy points balance needs operator review.",
      );
    const link = {
      branchId: store.branchId || "main",
      legacyId: local._id,
      at: new Date(),
    };
    if (!owner) {
      const { _shared, linkedCustomerId, ...copy } = local;
      owner = {
        ...copy,
        points: local.points || 0,
        legacyLinks: [link],
        sharedSince: new Date(),
        identityRevision: 1,
      };
      await store.sharedCustomers.insertOne(owner, { session });
    } else {
      if (!Number.isSafeInteger((owner.points || 0) + (local.points || 0)))
        throw new HttpError(
          409,
          "LOYALTY_REVIEW",
          "The combined points balance exceeds its supported limit.",
        );
      const alias = owner._id.equals(local._id) ? {} : { aliases: local._id };
      owner = await store.sharedCustomers.findOneAndUpdate(
        { _id: owner._id },
        {
          $inc: { points: local.points || 0, identityRevision: 1 },
          $push: { legacyLinks: link },
          ...(Object.keys(alias).length ? { $addToSet: alias } : {}),
        },
        { session, returnDocument: "after" },
      );
    }
    await store.legacyCustomers.updateOne(
      { _id: local._id },
      {
        $set: { linkedCustomerId: owner._id, points: 0, linkedAt: new Date() },
        $inc: { authVersion: 1 },
      },
      { session },
    );
    await store.legacyCustomerSessions.deleteMany(
      { customerId: local._id },
      { session },
    );
    if (!owner._id.equals(local._id)) {
      await store.notificationPreferences.updateMany(
        { customerId: local._id },
        {
          $set: {
            inApp: false,
            email: false,
            sms: false,
            push: false,
            sinceAt: new Date(),
          },
          $inc: { generation: 1 },
        },
        { session },
      );
      await store.pushSubscriptions.deleteMany(
        { actorKey: "customer:" + local._id },
        { session },
      );
    }
    await store.audit.insertOne(
      {
        type: "customer.branch_linked",
        customerId: owner._id,
        legacyId: local._id,
        branchId: store.branchId,
        transferredPoints: local.points || 0,
        at: new Date(),
      },
      { session },
    );
    return owner;
  });
}
export function registerSharedCustomerLinks(
  api,
  store,
  config,
  requireCustomer,
  authLimit,
) {
  api.post(
    "/account/link-branch",
    requireCustomer,
    authLimit,
    async (req, res) => {
      const input = body(
          z.strictObject({
            branchId: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
            currentPassword: z.string().min(1).max(128),
            branchPassword: z.string().min(1).max(128),
          }),
          req.body,
        ),
        root = store.rootStore || store,
        context = await getBranchRuntime(root, config).get(input.branchId),
        owner = await store.sharedCustomers.findOne({
          _id: req.customer._id,
          active: true,
        }),
        legacy = await context.store.legacyCustomers.findOne({
          email: req.customer.email,
          active: true,
        });
      const [ownerValid, localValid] = await Promise.all([
        passwordMatches(input.currentPassword, owner?.passwordHash),
        passwordMatches(input.branchPassword, legacy?.passwordHash),
      ]);
      if (!ownerValid || !localValid)
        throw new HttpError(
          401,
          "LOGIN_FAILED",
          "Both account passwords must match before branch history and points can be linked.",
        );
      if (
        context.store.legacyCustomers.namespace ===
        store.sharedCustomers.namespace
      )
        return res.json({ linked: true });
      await claimLegacyCustomer(context.store, context.config, legacy, owner);
      res.json({ linked: true });
    },
  );
}
export async function combinedCustomerRows(
  store,
  config,
  customer,
  kind,
  before = null,
) {
  const root = store.rootStore || store,
    runtime = getBranchRuntime(root, config),
    result = [],
    unavailable = [];
  for (const branch of await runtime.all()) {
    try {
      const context = await runtime.get(branch._id),
        collections =
          kind === "loyalty"
            ? [["loyalty", context.store.loyaltyLedger]]
            : [
                ["table", context.store.orders],
                ["fulfillment", context.store.fulfillments],
              ];
      for (const [type, collection] of collections) {
        const date = kind === "loyalty" ? "at" : "createdAt",
          filter = {
            customerId: { $in: customerIds(customer) },
            ...(before ? { [date]: { $lte: new Date(before) } } : {}),
          };
        const rows = await collection
          .find(filter)
          .sort({ [date]: -1, _id: -1 })
          .limit(kind === "loyalty" ? 50 : 26)
          .toArray();
        for (const row of rows)
          result.push({
            ...row,
            sourceKind: type,
            branchId: branch._id,
            branchName: branch.name,
          });
      }
    } catch {
      unavailable.push(branch._id);
    }
  }
  return { rows: result, unavailable };
}
