import { loadConfig } from "../server/config.js";
import { connectDatabase } from "../server/db.js";
import { transaction } from "../server/money.js";
const args = process.argv.slice(2),
  value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : "";
  };
const username = value("--username"),
  reason = value("--reason");
if (
  !/^[a-z0-9_-]{1,32}$/.test(username) ||
  value("--confirm-reset") !== username ||
  reason.trim().length < 3
)
  throw new Error(
    "This local operator recovery disables the selected staff account's second factor and revokes every session. Use --username USER --confirm-reset USER --reason 'Identity verified by operator'. Prefer an unused recovery code first.",
  );
const store = await connectDatabase(loadConfig());
try {
  await transaction(store, async (session) => {
    const user = await store.staff.findOneAndUpdate(
      { username, active: true },
      {
        $set: { mfa: null, mustChangePassword: true },
        $inc: { authVersion: 1 },
      },
      { session },
    );
    if (!user) throw new Error("Active staff account not found.");
    await store.sessions.deleteMany({ staffId: user._id }, { session });
    await store.staffMfaChallenges.deleteMany(
      { staffId: user._id },
      { session },
    );
    await store.staffMfaEnrollments.deleteOne({ _id: user._id }, { session });
    await store.audit.insertOne(
      {
        type: "staff.mfa_operator_recovery",
        staffId: user._id,
        by: "local-operator",
        reason: reason.trim().slice(0, 160),
        at: new Date(),
      },
      { session },
    );
  });
  console.log(
    "Selected account recovered. All old sessions were revoked; a password change is required at the next login. Re-enroll its authenticator after verifying the operator's recovery.",
  );
} finally {
  await store.client.close();
}
