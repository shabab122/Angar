import path from "node:path";
import { z } from "zod";
import { connectDatabase } from "./db.js";
import { restaurantSettings } from "./restaurant.js";
import {
  cookieOptions,
  hash,
  passwordMatches,
  randomToken,
  STAFF_COOKIE,
  sessionToken,
} from "./security.js";
import { HttpError, body } from "./http.js";
import { transaction } from "./money.js";
import { hasPermission, isPlatformAdmin } from "./access.js";
export const BRANCH_COOKIE = "angar_branch";
export const branchSlug = z.string().regex(/^[a-z][a-z0-9-]{1,23}$/);
const runtimes = new WeakMap();
export const branchPath = (value, branch = "main") => {
  if (branch === "main") return value;
  const u = new URL(value, "https://branch.invalid");
  u.searchParams.set("branch", branch);
  return u.pathname + u.search + u.hash;
};
export const branchDatabase = (root, slug) =>
  "angar_branch_" + hash(root + ":" + slug).slice(0, 32);
export async function authenticatedStaff(store, req, config) {
  const token = req.cookies?.[STAFF_COOKIE];
  const session = sessionToken(token)
    ? await store.sessions.findOne({
        _id: hash(token),
        expiresAt: { $gt: new Date() },
      })
    : null;
  const user = session
    ? await store.staff.findOne({ _id: session.staffId, active: true })
    : null;
  if (!user || (user.authVersion || 0) !== (session.authVersion || 0))
    throw new HttpError(
      401,
      "STAFF_REQUIRED",
      "Sign in to the staff workspace.",
    );
  if (user.mustChangePassword)
    throw new HttpError(
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "Change your temporary password first.",
    );
  if (
    config.staffMfa?.requireAdmin &&
    user.role === "admin" &&
    !user.mfa?.enabled
  )
    throw new HttpError(
      403,
      "MFA_REQUIRED",
      "Finish administrator authenticator setup first.",
    );
  return user;
}
const publicBranch = (row) => ({
  id: row._id,
  name: row.name,
  address: row.address || "",
  state: row.state,
  active: row.active,
  createdAt: row.createdAt,
});
export function getBranchRuntime(root, config) {
  if (runtimes.has(root)) return runtimes.get(root);
  const cache = new Map(),
    master = config.identityDatabase || config.mongoDatabase;
  const ready = (async () => {
    if (await root.settings.findOne({ _id: "branch-identity" }))
      throw new HttpError(
        503,
        "BRANCH_ROOT_REQUIRED",
        "MONGODB_DB must point to the main identity database, not a child branch database.",
      );
    const restaurant = await restaurantSettings(root);
    await root.branches.updateOne(
      { _id: "main" },
      {
        $setOnInsert: {
          name: restaurant.branch || "Main branch",
          address: restaurant.address || "",
          state: "ready",
          active: true,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  })();
  async function get(slug) {
    await ready;
    if (slug === "main")
      return {
        store: root,
        config: { ...config, branchId: "main" },
        branch: await root.branches.findOne({ _id: "main" }),
      };
    const branch = await root.branches.findOne({
      _id: slug,
      active: true,
      state: "ready",
    });
    if (!branch)
      throw new HttpError(
        404,
        "BRANCH_UNAVAILABLE",
        "This branch is unavailable. Choose an active branch.",
      );
    const name = branch.databaseOverride || branchDatabase(master, slug);
    const claim = await root.client
      .db(name)
      .collection("settings")
      .findOne({ _id: "branch-identity" });
    if (claim?.branchId !== slug || claim?.identityDatabase !== master)
      throw new HttpError(
        503,
        "BRANCH_RECOVERY_REQUIRED",
        "This branch needs operator recovery or provisioning before it can open.",
      );
    if (!cache.has(slug))
      cache.set(
        slug,
        (async () => {
          const childConfig = {
            ...config,
            branchId: slug,
            identityDatabase: master,
            mongoDatabase: name,
            uploadDir: path.join(config.uploadDir, "branches", slug),
            backupS3: {
              ...config.backupS3,
              prefix:
                (config.backupS3?.prefix || "angar-backups/").replace(
                  /\/?$/,
                  "/",
                ) +
                "branches/" +
                slug +
                "/",
            },
            backup: {
              ...config.backup,
              directory: path.join(config.backup.directory, "branches", slug),
            },
            mail: {
              ...config.mail,
              outboxDir: path.join(config.mail.outboxDir, "branches", slug),
            },
            sms: {
              ...config.sms,
              outboxDir: path.join(config.sms.outboxDir, "branches", slug),
            },
          };
          const store = await connectDatabase(childConfig, root.client);
          store.rootStore = root;
          return { store, config: childConfig };
        })().catch((error) => {
          cache.delete(slug);
          throw error;
        }),
      );
    return { ...(await cache.get(slug)), branch };
  }
  const runtime = {
    ready,
    get,
    root,
    master,
    async all() {
      await ready;
      return root.branches
        .find({ active: true, state: "ready" })
        .sort({ _id: 1 })
        .toArray();
    },
  };
  runtimes.set(root, runtime);
  return runtime;
}
export function registerBranchManagement(router, root, config) {
  const runtime = getBranchRuntime(root, config);
  router.get("/branches", async (req, res) => {
    const branches = await runtime.all();
    const selected = req.signedCookies[BRANCH_COOKIE] || "main";
    if (!branches.some((branch) => branch._id === selected)) {
      res.cookie(
        BRANCH_COOKIE,
        "main",
        cookieOptions(config, { signed: true, maxAge: 365 * 86400000 }),
      );
      for (const name of ["angar_table", "angar_staff_pending"])
        res.clearCookie(name, cookieOptions(config));
    }
    res.json({
      branches: branches.map(publicBranch),
      current: branches.some(
        (branch) => branch._id === (req.signedCookies[BRANCH_COOKIE] || "main"),
      )
        ? req.signedCookies[BRANCH_COOKIE] || "main"
        : "main",
    });
  });
  router.post("/branches/select", async (req, res) => {
    const input = body(z.strictObject({ branchId: branchSlug }), req.body);
    await runtime.get(input.branchId);
    res.cookie(
      BRANCH_COOKIE,
      input.branchId,
      cookieOptions(config, { signed: true, maxAge: 365 * 86400000 }),
    );
    for (const name of ["angar_table", "angar_staff_pending"])
      res.clearCookie(name, cookieOptions(config));
    res.json({ selected: input.branchId });
  });
  const requirePlatform = async (req, res, next) => {
    req.staff = await authenticatedStaff(root, req, config);
    if (
      !isPlatformAdmin(req.staff) ||
      !hasPermission(req.staff, "branches.manage")
    )
      throw new HttpError(
        403,
        "PLATFORM_ADMIN_REQUIRED",
        "A main-branch administrator manages restaurant branches and shared access.",
      );
    next();
  };
  router.get("/branches/manage", requirePlatform, async (req, res) => {
    await runtime.ready;
    res.json({
      branches: (await root.branches.find({}).sort({ _id: 1 }).toArray()).map(
        (row) => ({
          ...publicBranch(row),
          ...(row.state === "provisioning"
            ? {
                provisioning: {
                  requestKey: row.requestKey,
                  ...row.provisioning,
                },
              }
            : {}),
        }),
      ),
    });
  });
  router.post("/branches", requirePlatform, async (req, res) => {
    const input = body(
      z.strictObject({
        id: branchSlug.refine((v) => v !== "main"),
        name: z.string().trim().min(2).max(80),
        address: z.string().trim().max(240).default(""),
        copyMenu: z.boolean().default(true),
        tables: z.number().int().min(1).max(50).default(6),
        currentPassword: z.string().min(1).max(128),
        requestKey: z.string().regex(/^[a-f0-9]{32}$/),
      }),
      req.body,
    );
    if (!(await passwordMatches(input.currentPassword, req.staff.passwordHash)))
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter the administrator password.",
      );
    const { currentPassword, ...safe } = input,
      fingerprint = hash(JSON.stringify(safe));
    const row = await transaction(root, async (session) => {
      await root.identitySettings.updateOne(
        { _id: "branch-setup-lock" },
        { $inc: { revision: 1 } },
        { session },
      );
      const old = await root.branches.findOne({ _id: input.id }, { session });
      if (old) {
        if (
          old.requestKey !== input.requestKey ||
          old.fingerprint !== fingerprint
        )
          throw new HttpError(
            409,
            "BRANCH_EXISTS",
            "This branch code already exists.",
          );
        return old;
      }
      if ((await root.branches.countDocuments({}, { session })) >= 20)
        throw new HttpError(
          409,
          "BRANCH_LIMIT",
          "This installation supports up to 20 branches.",
        );
      const used = new Set(
        (await root.branches.find({}, { session }).toArray())
          .map((row) => row.invoicePrefix)
          .filter(Boolean),
      );
      const mainSettings = await restaurantSettings(root, session);
      used.add(mainSettings.invoice?.prefix || "AK");
      let sequence = 1;
      while (used.has("BR" + String(sequence).padStart(4, "0"))) sequence++;
      const invoicePrefix = "BR" + String(sequence).padStart(4, "0");
      const row = {
        _id: input.id,
        invoicePrefix,
        provisioning: { copyMenu: input.copyMenu, tables: input.tables },
        name: input.name,
        address: input.address,
        state: "provisioning",
        active: false,
        createdBy: req.staff.username,
        createdAt: new Date(),
        requestKey: input.requestKey,
        fingerprint,
      };
      await root.branches.insertOne(row, { session });
      return row;
    });
    if (row.state === "ready")
      return res.status(201).json({ branch: publicBranch(row) });
    const db = root.client.db(branchDatabase(runtime.master, input.id)),
      settings = db.collection("settings");
    const claim = await settings.findOne({ _id: "branch-identity" });
    if (
      claim &&
      (claim.identityDatabase !== runtime.master ||
        claim.branchId !== input.id ||
        claim.requestKey !== input.requestKey)
    )
      throw new HttpError(
        409,
        "BRANCH_DATABASE",
        "This database already belongs to another provisioning request.",
      );
    if (!claim && (await db.listCollections().toArray()).length)
      throw new HttpError(
        409,
        "BRANCH_DATABASE",
        "A non-empty database already occupies this branch address. Nothing was overwritten.",
      );
    await settings.updateOne(
      { _id: "branch-identity" },
      {
        $setOnInsert: {
          branchId: input.id,
          identityDatabase: runtime.master,
          requestKey: input.requestKey,
        },
      },
      { upsert: true },
    );
    const childConfig = {
      ...config,
      identityDatabase: runtime.master,
      mongoDatabase: db.databaseName,
      branchId: input.id,
    };
    const child = await connectDatabase(childConfig, root.client);
    if (input.copyMenu) {
      const dishes = await root.dishes.find({}).toArray();
      if (dishes.length)
        await child.dishes.bulkWrite(
          dishes.map((dish) => ({
            updateOne: {
              filter: { _id: dish._id },
              update: { $setOnInsert: dish },
              upsert: true,
            },
          })),
        );
    }
    const base = await restaurantSettings(root);
    await child.settings.updateOne(
      { _id: "restaurant" },
      {
        $setOnInsert: {
          ...base,
          branch: input.name,
          address: input.address,
          location: input.address || base.location,
          orderingEnabled: false,
          invoice: {
            ...base.invoice,
            prefix:
              row.invoicePrefix ||
              "B" + hash(input.id).slice(0, 7).toUpperCase(),
            address: input.address,
          },
          fulfillment: {
            ...base.fulfillment,
            pickupEnabled: false,
            deliveryEnabled: false,
            zones: [],
          },
        },
      },
      { upsert: true },
    );
    await child.tables.bulkWrite(
      Array.from({ length: input.tables }, (_, index) => ({
        updateOne: {
          filter: { number: "T" + String(index + 1).padStart(2, "0") },
          update: {
            $setOnInsert: {
              number: "T" + String(index + 1).padStart(2, "0"),
              capacity: 4,
              qrToken: randomToken(24),
              activeVisitId: null,
              billingState: "open",
              revision: 0,
            },
          },
          upsert: true,
        },
      })),
    );
    await root.branches.updateOne(
      { _id: input.id, requestKey: input.requestKey },
      { $set: { state: "ready", active: true, readyAt: new Date() } },
    );
    await root.audit.insertOne({
      type: "branch.created",
      branchId: input.id,
      by: req.staff.username,
      at: new Date(),
    });
    res.status(201).json({
      branch: publicBranch(await root.branches.findOne({ _id: input.id })),
    });
  });
  router.patch("/branches/:id", requirePlatform, async (req, res) => {
    const input = body(
      z.strictObject({
        name: z.string().trim().min(2).max(80),
        address: z.string().trim().max(240),
        currentPassword: z.string().min(1).max(128),
        reason: z.string().trim().min(3).max(160),
      }),
      req.body,
    );
    if (!(await passwordMatches(input.currentPassword, req.staff.passwordHash)))
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter the administrator password.",
      );
    const context = await runtime.get(body(branchSlug, req.params.id));
    await context.store.settings.updateOne(
      { _id: "restaurant" },
      {
        $set: {
          branch: input.name,
          address: input.address,
          ...(input.address ? { location: input.address } : {}),
        },
      },
      { upsert: true },
    );
    await root.branches.updateOne(
      { _id: req.params.id },
      { $set: { name: input.name, address: input.address } },
    );
    await root.audit.insertOne({
      type: "branch.updated",
      branchId: req.params.id,
      reason: input.reason,
      by: req.staff.username,
      at: new Date(),
    });
    res.json({ saved: true });
  });
}
