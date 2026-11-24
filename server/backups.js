import { effectiveStaff } from "./access.js";
import path from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  stat,
  lstat,
  link,
  unlink,
  rm,
} from "node:fs/promises";
import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { BSON } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { passwordMatches } from "./security.js";
import { queueCloudBackup, hasVerifiedCloudCopy } from "./backup-cloud.js";

const compress = promisify(gzip),
  decompress = promisify(gunzip);
const magic = Buffer.from("ANGAR_BACKUP_V1\n"),
  maxBytes = 96 * 1024 * 1024;
const identifier = /^BK-[a-f0-9]{32}$/;
const transient = new Set([
  "staffSessions",
  "customerSessions",
  "accountTokens",
  "backupJobs",
  "runtimeLeases",
  "notificationJobs",
  "phoneChallenges",
  "phoneSendLimits",
  "pushSubscriptions",
  "staffMfaChallenges",
  "staffMfaEnrollments",
  "backupSyncJobs",
  "printJobs",
  "staffAlertDeliveries",
  "courierWebhookEvents",
  "monitoringInstances",
  "monitoringDeliveries",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const defaults = { enabled: false, everyHours: 24, keep: 7, nextAt: null };
const safeError = (error) =>
  error instanceof HttpError
    ? error.message
    : "The operation could not complete. Check database access, free disk space, backup key and photo storage.";
function canonical(value) {
  const sorted = (x) =>
    Array.isArray(x)
      ? x.map(sorted)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((key) => [key, sorted(x[key])]),
          )
        : x;
  return JSON.stringify(
    sorted(BSON.EJSON.serialize(value, { relaxed: false })),
  );
}
const collectionHash = (rows) => digest(Buffer.from(canonical(rows)));
function ready(config) {
  return /^[a-f0-9]{64}$/i.test(config.backup?.key || "");
}
function fileFor(config, id) {
  if (!identifier.test(id))
    throw new HttpError(400, "INVALID_BACKUP", "Invalid backup identifier.");
  return path.join(config.backup.directory, id + ".akbackup");
}
const jobView = (job) => ({
  id: job._id,
  type: job.type,
  bundleId: job.bundleId,
  status: job.status,
  createdAt: job.createdAt,
  completedAt: job.completedAt,
  message: job.message || "",
  result: job.result || null,
});
export async function administratorPassword(store, req, password) {
  const user = await store.staff.findOne({
    _id: req.staff._id,
    active: true,
  });
  if (
    !user ||
    (user.authVersion || 0) !== (req.staff.authVersion || 0) ||
    !(await passwordMatches(password, user.passwordHash))
  )
    throw new HttpError(
      401,
      "PASSWORD_REQUIRED",
      "Re-enter your current administrator password.",
    );
}

export async function createBackup(store, config, id) {
  if (!ready(config))
    throw new HttpError(
      503,
      "BACKUP_SETUP",
      "Run setup and retain the generated BACKUP_ENCRYPTION_KEY before creating backups.",
    );
  const destination = fileFor(config, id);
  await mkdir(config.backup.directory, { recursive: true, mode: 0o700 });
  try {
    await stat(destination);
    return (await openBackup(config, id)).summary;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const collections = Object.values(store)
    .filter(
      (value) =>
        value?.collectionName && value.dbName === store.db.databaseName,
    )
    .sort((a, b) => a.collectionName.localeCompare(b.collectionName));
  const definitions = [];
  for (const collection of collections)
    definitions.push({
      name: collection.collectionName,
      indexes: await collection.indexes().catch((error) => {
        if (error.code === 26) return [];
        throw error;
      }),
    });
  const session = store.client.startSession({ snapshot: true });
  const contents = [],
    photoNames = new Set();
  let size = 0,
    documents = 0;
  try {
    for (const definition of definitions) {
      const rows = [];
      for await (const document of store.db
        .collection(definition.name)
        .find({}, { session, promoteLongs: false, promoteValues: false })
        .sort({ _id: 1 })) {
        size += Buffer.byteLength(canonical(document));
        documents++;
        if (size > maxBytes || documents > 250000)
          throw new HttpError(
            409,
            "BACKUP_SIZE",
            "This application backup exceeds its 96 MiB / 250,000 document limit. Use a managed database backup for larger datasets.",
          );
        rows.push(document);
        if (definition.name === "reviews" && document.imageFile)
          photoNames.add(document.imageFile);
      }
      contents.push({ ...definition, rows, sha256: collectionHash(rows) });
    }
  } finally {
    await session.endSession();
  }
  const photos = [];
  for (const name of [...photoNames].sort()) {
    if (!/^[a-f0-9]{36}\.webp$/.test(name))
      throw new HttpError(
        409,
        "BACKUP_PHOTO",
        "A review photo has an invalid filename.",
      );
    const file = path.join(config.uploadDir, name),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024)
      throw new HttpError(
        409,
        "BACKUP_PHOTO",
        "A review photo cannot be backed up safely.",
      );
    const bytes = await readFile(file);
    size += bytes.length * 1.4;
    if (size > maxBytes)
      throw new HttpError(
        409,
        "BACKUP_SIZE",
        "Database and photos exceed the application backup size limit.",
      );
    photos.push({
      name,
      sha256: digest(bytes),
      data: bytes.toString("base64"),
    });
  }
  const summary = {
    collections: contents.length,
    documents,
    photos: photos.length,
    sourceDatabase: config.mongoDatabase,
  };
  const archive = {
    version: 1,
    id,
    createdAt: new Date(),
    summary,
    collections: contents,
    photos,
  };
  const encoded = {
    ...archive,
    createdAt: archive.createdAt.toISOString(),
    collections: contents.map((collection) => ({
      ...collection,
      rows: BSON.EJSON.serialize(collection.rows, { relaxed: false }),
      indexes: BSON.EJSON.serialize(collection.indexes, { relaxed: false }),
    })),
  };
  const plain = Buffer.from(JSON.stringify(encoded));
  if (plain.length > maxBytes)
    throw new HttpError(
      409,
      "BACKUP_SIZE",
      "The encoded application backup exceeds 96 MiB.",
    );
  const zipped = await compress(plain),
    iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(config.backup.key, "hex"),
      iv,
    );
  cipher.setAAD(magic);
  const bytes = Buffer.concat([
    magic,
    iv,
    cipher.update(zipped),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const temporary = destination + "." + randomBytes(6).toString("hex") + ".tmp";
  await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  try {
    await link(temporary, destination);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return (await openBackup(config, id)).summary;
}

export async function openBackup(config, id) {
  if (!ready(config))
    throw new HttpError(
      503,
      "BACKUP_SETUP",
      "The original backup encryption key is required.",
    );
  const file = fileFor(config, id),
    info = await stat(file);
  if (!info.isFile() || info.size > maxBytes + 1048576)
    throw new HttpError(
      400,
      "INVALID_BACKUP",
      "Invalid or oversized backup file.",
    );
  const bytes = await readFile(file);
  try {
    if (!bytes.subarray(0, magic.length).equals(magic)) throw Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.backup.key, "hex"),
      bytes.subarray(magic.length, magic.length + 12),
    );
    decipher.setAAD(magic);
    decipher.setAuthTag(bytes.subarray(-16));
    const zipped = Buffer.concat([
      decipher.update(bytes.subarray(magic.length + 12, -16)),
      decipher.final(),
    ]);
    const plain = await decompress(zipped, { maxOutputLength: maxBytes });
    const archive = JSON.parse(plain.toString());
    if (
      archive.version !== 1 ||
      archive.id !== id ||
      !Array.isArray(archive.collections) ||
      !Array.isArray(archive.photos)
    )
      throw Error();
    for (const collection of archive.collections) {
      collection.rows = BSON.EJSON.deserialize(collection.rows, {
        relaxed: false,
      });
      collection.indexes = BSON.EJSON.deserialize(collection.indexes, {
        relaxed: true,
      });
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(collection.name) ||
        !Array.isArray(collection.rows) ||
        collectionHash(collection.rows) !== collection.sha256
      )
        throw Error();
    }
    for (const photo of archive.photos)
      if (
        !/^[a-f0-9]{36}\.webp$/.test(photo.name) ||
        digest(Buffer.from(photo.data, "base64")) !== photo.sha256
      )
        throw Error();
    return archive;
  } catch {
    throw new HttpError(
      400,
      "BACKUP_INTEGRITY",
      "Backup authentication/checksum failed. Use the original key and an intact backup.",
    );
  }
}

export async function restoreBackup(
  store,
  config,
  id,
  targetName,
  mediaDirectory,
) {
  if (
    !/^[a-zA-Z][a-zA-Z0-9_-]{2,54}$/.test(targetName) ||
    targetName === config.mongoDatabase ||
    ["admin", "local", "config"].includes(targetName)
  )
    throw new HttpError(
      400,
      "RESTORE_TARGET",
      "Choose a new, separate application database name.",
    );
  const media = path.resolve(mediaDirectory);
  if (
    [
      path.resolve(config.uploadDir),
      path.resolve(config.backup.directory),
    ].includes(media)
  )
    throw new HttpError(
      400,
      "RESTORE_TARGET",
      "Choose a separate, new media directory.",
    );
  const archive = await openBackup(config, id),
    target = store.client.db(targetName);
  if ((await target.listCollections({}, { nameOnly: true }).toArray()).length)
    throw new HttpError(
      409,
      "RESTORE_EXISTS",
      "The target database already exists. Existing databases are never overwritten.",
    );
  try {
    await stat(media);
    throw new HttpError(
      409,
      "RESTORE_EXISTS",
      "The target media directory already exists.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(media, { mode: 0o700, recursive: false });
  await target.createCollection("_restoreGuard");
  const owner = randomBytes(16).toString("hex");
  await target
    .collection("_restoreGuard")
    .insertOne({ _id: id, owner, createdAt: new Date() });
  const results = [];
  for (const collection of archive.collections) {
    const rows = transient.has(collection.name) ? [] : collection.rows;
    await target.createCollection(collection.name);
    for (let index = 0; index < rows.length; index += 100)
      await target
        .collection(collection.name)
        .insertMany(rows.slice(index, index + 100));
    for (const index of collection.indexes.filter(
      (index) => index.name !== "_id_",
    )) {
      const { key } = index;
      const options = Object.fromEntries(
        [
          "name",
          "unique",
          "sparse",
          "expireAfterSeconds",
          "partialFilterExpression",
          "collation",
          "hidden",
        ]
          .filter((key) => index[key] !== undefined)
          .map((key) => [key, index[key]]),
      );
      await target.collection(collection.name).createIndex(key, options);
    }
    const actual = await target
      .collection(collection.name)
      .find({}, { promoteLongs: false, promoteValues: false })
      .sort({ _id: 1 })
      .toArray();
    if (collectionHash(actual) !== collectionHash(rows))
      throw new HttpError(
        409,
        "RESTORE_VERIFY",
        "Restored database verification failed. Keep the target isolated.",
      );
    results.push({ collection: collection.name, documents: actual.length });
  }
  for (const photo of archive.photos) {
    const file = path.join(media, photo.name);
    await writeFile(file, Buffer.from(photo.data, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    if (digest(await readFile(file)) !== photo.sha256)
      throw new HttpError(
        409,
        "RESTORE_VERIFY",
        "Restored photo verification failed.",
      );
  }
  await target
    .collection("settings")
    .updateOne(
      { _id: "backup-config" },
      { $set: { enabled: false, nextAt: null, offsiteEnabled: false } },
    );
  await target
    .collection("settings")
    .updateOne({ _id: "print-config" }, { $set: { autoEnabled: false } });
  await target
    .collection("settings")
    .updateOne(
      { _id: "purchase-suggestion-policy" },
      { $set: { enabled: false, needsReview: true } },
    );
  await target
    .collection("settings")
    .updateOne(
      { _id: "staff-alert-config" },
      { $set: { emailEnabled: false } },
    );
  await target
    .collection("settings")
    .updateOne({ _id: "staff-alert-scan" }, { $set: { nextAt: new Date(0) } });
  await target.collection("notificationPreferences").updateMany(
    {},
    {
      $set: { email: false, sms: false, push: false, sinceAt: new Date() },
      $inc: { generation: 1 },
    },
  );
  await target.collection("branches").updateMany(
    { _id: { $ne: "main" } },
    {
      $set: { active: false, state: "recovery_required" },
      $unset: { databaseOverride: "" },
    },
  );
  await target
    .collection("stockTransfers")
    .updateMany(
      { status: { $in: ["requested", "approved", "dispatched"] } },
      { $set: { needsRecovery: true } },
    );
  await target
    .collection("identitySettings")
    .updateOne(
      { _id: "monitoring-policy" },
      { $set: { emailEnabled: false } },
      { upsert: true },
    );
  await target.collection("courierJobs").updateMany(
    {},
    {
      $unset: {
        driverTokenHash: "",
        location: "",
        locationAt: "",
        deliveryCode: "",
        deliveryCodeHash: "",
      },
      $set: { trackingRevoked: true },
    },
  );
  await target
    .collection("_restoreGuard")
    .updateOne({ _id: id, owner }, { $set: { verified: true } });
  return {
    database: targetName,
    mediaDirectory: media,
    verified: true,
    photos: archive.photos.length,
    collections: results,
    safetyResets: [...transient],
    owner,
  };
}

export async function verifyBackup(store, config, id) {
  const suffix = randomBytes(10).toString("hex"),
    database = "angar_verify_" + suffix;
  const media = path.join(config.backup.directory, "verify-" + suffix);
  try {
    const result = await restoreBackup(store, config, id, database, media);
    return {
      verified: result.verified,
      photos: result.photos,
      collections: result.collections,
    };
  } finally {
    const guard = await store.client
      .db(database)
      .collection("_restoreGuard")
      .findOne({ _id: id });
    if (guard) {
      await store.client.db(database).dropDatabase();
      await rm(media, { recursive: true, force: true });
    }
  }
}

export async function runBackupJobs(store, config, now = new Date()) {
  if (!ready(config)) return;
  const settings = await store.settings.findOne({
    _id: "backup-config",
    enabled: true,
    nextAt: { $lte: now },
  });
  if (settings) {
    const claimed = await store.settings.findOneAndUpdate(
      { _id: settings._id, enabled: true, nextAt: settings.nextAt },
      {
        $set: {
          nextAt: new Date(now.getTime() + settings.everyHours * 3600000),
        },
      },
    );
    if (claimed)
      await store.backupJobs.insertOne({
        _id: "BK-" + randomBytes(16).toString("hex"),
        type: "create",
        status: "queued",
        createdAt: now,
        requestedBy: "schedule",
      });
  }
  await store.backupJobs.updateMany(
    { status: "running", leaseUntil: { $lt: now } },
    { $set: { status: "queued" } },
  );
  const owner = randomBytes(16).toString("hex");
  const job = await store.backupJobs.findOneAndUpdate(
    { status: "queued" },
    {
      $set: {
        status: "running",
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + 180000),
      },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!job) return;
  const heartbeat = setInterval(() => {
    void store.backupJobs
      .updateOne(
        { _id: job._id, leaseOwner: owner, status: "running" },
        { $set: { leaseUntil: new Date(Date.now() + 180000) } },
      )
      .catch(() => {});
  }, 30000);
  heartbeat.unref();
  try {
    let result;
    if (job.type === "verify")
      result = await verifyBackup(store, config, job.bundleId);
    else {
      const summary = await createBackup(store, config, job._id);
      const drill = await verifyBackup(store, config, job._id);
      result = { ...summary, verified: drill.verified, verifiedAt: new Date() };
    }
    await store.backupJobs.updateOne(
      { _id: job._id, leaseOwner: owner },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          result,
          message:
            job.type === "verify"
              ? "Restore verified in an isolated database and media folder."
              : "Encrypted snapshot and photos saved; restoration verified in an isolated database and media folder.",
        },
      },
    );
    if (job.type === "create") {
      const policy = {
        ...defaults,
        ...(await store.settings.findOne({ _id: "backup-config" })),
      };
      if (policy.offsiteEnabled) await queueCloudBackup(store, config, job._id);
      const files = await store.backupJobs
        .find({
          type: "create",
          status: "completed",
          removedAt: { $exists: false },
        })
        .sort({ createdAt: -1 })
        .skip(policy.keep)
        .toArray();
      for (const old of files) {
        if (
          policy.offsiteEnabled &&
          !(await hasVerifiedCloudCopy(store, config, old._id))
        )
          continue;
        if (
          await store.backupJobs.findOne({
            type: "verify",
            bundleId: old._id,
            status: { $in: ["queued", "running"] },
          })
        )
          continue;
        await unlink(fileFor(config, old._id)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await store.backupJobs.updateOne(
          { _id: old._id },
          { $set: { removedAt: new Date() } },
        );
      }
    }
  } catch (error) {
    await store.backupJobs.updateOne(
      { _id: job._id, leaseOwner: owner },
      {
        $set: {
          status: "failed",
          completedAt: new Date(),
          message: safeError(error),
        },
      },
    );
  } finally {
    clearInterval(heartbeat);
  }
}

export function registerBackups(api, store, config, requireAdmin) {
  api.get("/backups", requireAdmin, async (req, res) => {
    const settings = {
      ...defaults,
      ...(await store.settings.findOne({ _id: "backup-config" })),
    };
    const jobs = await store.backupJobs
      .find({ removedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.json({
      ready: ready(config),
      settings: {
        enabled: settings.enabled,
        everyHours: settings.everyHours,
        keep: settings.keep,
        nextAt: settings.nextAt,
      },
      jobs: jobs.map(jobView),
    });
  });
  api.post("/backups/settings", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        enabled: z.boolean(),
        everyHours: z.number().int().min(1).max(168),
        keep: z.number().int().min(1).max(30),
        currentPassword: z.string().min(1).max(128),
      }),
      req.body,
    );
    await administratorPassword(store, req, input.currentPassword);
    if (input.enabled && !ready(config))
      throw new HttpError(
        503,
        "BACKUP_SETUP",
        "Configure the backup encryption key before enabling a schedule.",
      );
    await store.settings.updateOne(
      { _id: "backup-config" },
      {
        $set: {
          enabled: input.enabled,
          everyHours: input.everyHours,
          keep: input.keep,
          nextAt: input.enabled
            ? new Date(Date.now() + input.everyHours * 3600000)
            : null,
        },
      },
      { upsert: true },
    );
    await store.audit.insertOne({
      type: "backup.schedule_updated",
      by: req.staff.username,
      at: new Date(),
      enabled: input.enabled,
      everyHours: input.everyHours,
      keep: input.keep,
    });
    res.json({ saved: true });
  });
  for (const type of ["create", "verify"])
    api.post(
      type === "create" ? "/backups" : "/backups/:id/verify",
      requireAdmin,
      async (req, res) => {
        if (!ready(config))
          throw new HttpError(
            503,
            "BACKUP_SETUP",
            "Run setup and configure the backup encryption key first.",
          );
        if (type === "verify") fileFor(config, req.params.id);
        if (
          (await store.backupJobs.countDocuments({
            status: { $in: ["queued", "running"] },
          })) >= 3
        )
          throw new HttpError(
            409,
            "BACKUP_BUSY",
            "A backup operation is already queued. Wait for it to finish.",
          );
        const id = "BK-" + randomBytes(16).toString("hex"),
          job = {
            _id: id,
            type,
            ...(type === "verify" ? { bundleId: req.params.id } : {}),
            status: "queued",
            createdAt: new Date(),
            requestedBy: req.staff.username,
          };
        await store.backupJobs.insertOne(job);
        res.status(202).json({ job: jobView(job) });
      },
    );
  api.get("/backups/:id/download", requireAdmin, async (req, res) => {
    const job = await store.backupJobs.findOne({
      _id: req.params.id,
      type: "create",
      status: "completed",
      removedAt: { $exists: false },
    });
    if (!job) throw new HttpError(404, "NOT_FOUND", "Backup not found.");
    res
      .set("Cache-Control", "no-store")
      .download(fileFor(config, job._id), job._id + ".akbackup");
  });
}
