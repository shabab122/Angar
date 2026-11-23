import { connectDatabase } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { transaction } from "../server/money.js";
import { branchSlug } from "../server/branches.js";
const args = process.argv.slice(2),
  value = (flag) => args[args.indexOf(flag) + 1] || "";
const slug = args.includes("--branch") ? value("--branch") : "",
  database = args.includes("--database") ? value("--database") : "",
  confirm = args.includes("--confirm-branch") ? value("--confirm-branch") : "",
  reason = args.includes("--reason") ? value("--reason") : "";
if (
  !branchSlug.safeParse(slug).success ||
  slug === "main" ||
  confirm !== slug ||
  !/^[A-Za-z][A-Za-z0-9_-]{1,62}$/.test(database) ||
  reason.length < 3
)
  throw new Error(
    'Use --branch CODE --database RESTORED_DB --confirm-branch CODE --reason "Reviewed isolated restored branch". Only a verified restore and a disabled recovery-required registry entry can be bound.',
  );
const config = loadConfig(),
  root = await connectDatabase(config);
try {
  if (database === root.db.databaseName)
    throw new Error("A branch cannot use its identity database.");
  const target = root.client.db(database);
  const guard = await target
      .collection("_restoreGuard")
      .findOne({ verified: true, boundAt: { $exists: false } }),
    marker = await target
      .collection("settings")
      .findOne({ _id: "branch-identity", branchId: slug });
  if (!guard || !marker)
    throw new Error(
      "The target is not a verified isolated restore of this branch. Nothing was changed.",
    );
  await transaction(root, async (session) => {
    await root.identitySettings.updateOne(
      { _id: "branch-setup-lock" },
      { $inc: { revision: 1 } },
      { session, upsert: true },
    );
    const registry = await root.branches.findOne(
      { _id: slug, active: false, state: "recovery_required" },
      { session },
    );
    if (!registry)
      throw new Error(
        "The recovered branch registry is not awaiting recovery. Active branches are never rebound by this command.",
      );
    if (
      await root.branches.findOne(
        { _id: { $ne: slug }, databaseOverride: database },
        { session },
      )
    )
      throw new Error("Another branch already uses this restored database.");
    const bound = await target.collection("_restoreGuard").updateOne(
      { _id: guard._id, verified: true, boundAt: { $exists: false } },
      {
        $set: { boundAt: new Date(), bindingIdentity: root.db.databaseName },
      },
      { session },
    );
    if (!bound.matchedCount)
      throw new Error(
        "This restore was already bound to another application. Make and verify a separate restored copy.",
      );
    await target.collection("settings").updateOne(
      { _id: "branch-identity", branchId: slug },
      {
        $set: {
          identityDatabase: root.db.databaseName,
          recoveredAt: new Date(),
        },
      },
      { session },
    );
    await root.branches.updateOne(
      { _id: slug },
      {
        $set: {
          databaseOverride: database,
          active: true,
          state: "ready",
          recoveredAt: new Date(),
        },
      },
      { session },
    );
    await root.transfers.updateMany(
      {
        $or: [{ fromBranch: slug }, { toBranch: slug }],
        status: { $in: ["requested", "approved", "dispatched", "received"] },
      },
      { $set: { needsRecovery: true } },
      { session },
    );
    await root.audit.insertOne(
      {
        type: "branch.recovered",
        branchId: slug,
        database,
        by: "operator-cli",
        reason,
        at: new Date(),
      },
      { session },
    );
  });
  console.log("Verified restored branch bound:", slug, "->", database);
  console.log(
    "Keep its photo directory under UPLOAD_DIR/branches/" +
      slug +
      ". Review ordering, payment, backup and notification settings before service.",
  );
} finally {
  await root.client.close();
}
