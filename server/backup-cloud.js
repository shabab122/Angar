import path from "node:path";
import {
  readFile,
  stat,
  mkdir,
  writeFile,
  link,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { passwordMatches, hash } from "./security.js";

const idPattern = /^BK-[a-f0-9]{32}$/,
  maxBytes = 97 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function settings(config) {
  const value = config.backupS3 || {},
    prefix = value.prefix || "angar-backups/";
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket || "") ||
    !/^[a-z0-9-]{2,60}$/.test(value.region || "") ||
    !/^[A-Za-z0-9_-][A-Za-z0-9/_-]{0,119}$/.test(prefix) ||
    prefix.includes("//")
  )
    throw new HttpError(
      503,
      "CLOUD_CONFIG",
      "Configure a private backup bucket, region and safe object prefix.",
    );
  if (value.endpoint) {
    let url;
    try {
      url = new URL(value.endpoint);
    } catch {
      throw new HttpError(503, "CLOUD_CONFIG", "Use an HTTPS S3 endpoint.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new HttpError(
        503,
        "CLOUD_CONFIG",
        "Use an HTTPS S3 endpoint without embedded credentials or query parameters.",
      );
  }
  if (
    !config.backupS3Client &&
    (!value.accessKeyId || !value.secretAccessKey) &&
    !value.useDefaultCredentials
  )
    throw new HttpError(
      503,
      "CLOUD_CONFIG",
      "Configure S3 credentials, or explicitly enable an operator-provided IAM credential chain.",
    );
  return { ...value, prefix: prefix.endsWith("/") ? prefix : prefix + "/" };
}
export function cloudReady(config) {
  try {
    settings(config);
    return true;
  } catch {
    return false;
  }
}
const destination = (config) => {
  const value = settings(config);
  return {
    bucket: value.bucket,
    region: value.region,
    endpoint: value.endpoint || "",
    prefix: value.prefix,
    forcePathStyle: Boolean(value.forcePathStyle),
  };
};
const fingerprint = (config) => hash(JSON.stringify(destination(config)));
export async function hasVerifiedCloudCopy(store, config, backupId) {
  return (
    cloudReady(config) &&
    Boolean(
      await store.backupSyncJobs.findOne({
        backupId,
        destinationHash: fingerprint(config),
        status: "verified",
      }),
    )
  );
}
function client(config) {
  if (config.backupS3Client) return config.backupS3Client;
  const value = settings(config);
  return new S3Client({
    region: value.region,
    ...(value.endpoint ? { endpoint: value.endpoint } : {}),
    forcePathStyle: Boolean(value.forcePathStyle),
    maxAttempts: 2,
    requestHandler: { requestTimeout: 120000, connectionTimeout: 10000 },
    ...(value.accessKeyId && value.secretAccessKey
      ? {
          credentials: {
            accessKeyId: value.accessKeyId,
            secretAccessKey: value.secretAccessKey,
            ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}),
          },
        }
      : {}),
  });
}
function localFile(config, id) {
  if (!idPattern.test(id || ""))
    throw new HttpError(
      400,
      "INVALID_BACKUP",
      "Use the exact encrypted backup identifier.",
    );
  return path.join(config.backup.directory, id + ".akbackup");
}
async function objectBytes(response) {
  if (response.ContentLength > maxBytes || !response.Body)
    throw new HttpError(
      409,
      "CLOUD_INTEGRITY",
      "The remote backup is missing or oversized.",
    );
  if (Buffer.isBuffer(response.Body) || response.Body instanceof Uint8Array) {
    if (response.Body.length > maxBytes)
      throw new HttpError(
        409,
        "CLOUD_INTEGRITY",
        "The remote backup is oversized.",
      );
    return Buffer.from(response.Body);
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const item of response.Body) {
      const chunk = Buffer.from(item);
      length += chunk.length;
      if (length > maxBytes)
        throw new HttpError(
          409,
          "CLOUD_INTEGRITY",
          "The remote backup is oversized.",
        );
      chunks.push(chunk);
    }
  } finally {
    response.Body.destroy?.();
  }
  return Buffer.concat(chunks);
}
export async function copyBackupToCloud(config, backupId) {
  const { openBackup } = await import("./backups.js");
  await openBackup(config, backupId);
  const value = settings(config),
    file = localFile(config, backupId),
    info = await stat(file);
  if (!info.isFile() || info.size > maxBytes)
    throw new HttpError(
      409,
      "CLOUD_SOURCE",
      "A valid local encrypted backup is required.",
    );
  const bytes = await readFile(file),
    sha256 = digest(bytes),
    Key = value.prefix + backupId + ".akbackup",
    service = client(config);
  try {
    try {
      await service.send(
        new PutObjectCommand({
          Bucket: value.bucket,
          Key,
          Body: bytes,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          Metadata: { sha256, "backup-id": backupId },
        }),
      );
    } catch (error) {
      if (
        ![409, 412].includes(error.$metadata?.httpStatusCode) &&
        !["PreconditionFailed", "ConditionalRequestConflict"].includes(
          error.name,
        )
      )
        throw error;
    }
    const response = await service.send(
        new GetObjectCommand({ Bucket: value.bucket, Key }),
      ),
      remote = await objectBytes(response);
    if (
      remote.length !== bytes.length ||
      digest(remote) !== sha256 ||
      (response.Metadata?.sha256 && response.Metadata.sha256 !== sha256)
    )
      throw new HttpError(
        409,
        "CLOUD_INTEGRITY",
        "Remote verification failed. An existing remote backup is never overwritten.",
      );
    return {
      backupId,
      ...destination(config),
      objectKey: Key,
      bytes: bytes.length,
      sha256,
      verifiedAt: new Date(),
      versionId: response.VersionId || "",
    };
  } finally {
    if (!config.backupS3Client) service.destroy();
  }
}
export async function queueCloudBackup(
  store,
  config,
  backupId,
  by = "schedule",
) {
  if (!cloudReady(config)) return false;
  localFile(config, backupId);
  const destinationHash = fingerprint(config),
    id = hash(backupId + ":" + destinationHash);
  await store.backupSyncJobs.updateOne(
    { _id: id },
    {
      $setOnInsert: {
        backupId,
        destination: destination(config),
        destinationHash,
        status: "queued",
        attempts: 0,
        createdAt: new Date(),
        nextAt: new Date(),
        requestedBy: by,
      },
    },
    { upsert: true },
  );
  return id;
}
export async function runCloudBackupJobs(store, config) {
  if (!cloudReady(config)) return;
  const policy = await store.settings.findOne({ _id: "backup-config" });
  if (policy?.offsiteEnabled) {
    const known = await store.backupSyncJobs
      .find(
        { destinationHash: fingerprint(config) },
        { projection: { backupId: 1 } },
      )
      .toArray();
    const sources = await store.backupJobs
      .find({
        type: "create",
        status: "completed",
        removedAt: { $exists: false },
        _id: { $nin: known.map((row) => row.backupId) },
      })
      .sort({ createdAt: 1 })
      .limit(30)
      .toArray();
    for (const source of sources)
      await queueCloudBackup(store, config, source._id);
  }
  const now = new Date(),
    owner = randomBytes(12).toString("hex");
  await store.backupSyncJobs.updateMany(
    { status: "uploading", leaseUntil: { $lt: now }, attempts: { $gte: 5 } },
    {
      $set: {
        status: "failed",
        message:
          "The final copy attempt was interrupted. Review the local bundle and destination before retrying.",
      },
    },
  );
  await store.backupSyncJobs.updateMany(
    { status: "uploading", leaseUntil: { $lt: now }, attempts: { $lt: 5 } },
    { $set: { status: "queued", nextAt: now } },
  );
  const job = await store.backupSyncJobs.findOneAndUpdate(
    {
      status: { $in: ["queued", "retrying"] },
      destinationHash: fingerprint(config),
      nextAt: { $lte: now },
      attempts: { $lt: 5 },
    },
    {
      $set: {
        status: "uploading",
        leaseOwner: owner,
        leaseUntil: new Date(Date.now() + 5 * 60000),
      },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!job) return;
  const heartbeat = setInterval(() => {
    void store.backupSyncJobs
      .updateOne(
        { _id: job._id, leaseOwner: owner, status: "uploading" },
        { $set: { leaseUntil: new Date(Date.now() + 5 * 60000) } },
      )
      .catch(() => {});
  }, 30000);
  heartbeat.unref();
  try {
    const result = await copyBackupToCloud(config, job.backupId);
    await store.backupSyncJobs.updateOne(
      { _id: job._id, leaseOwner: owner },
      {
        $set: {
          status: "verified",
          result,
          completedAt: new Date(),
          message: "Encrypted copy downloaded from cloud and SHA-256 verified.",
        },
      },
    );
    await store.audit.insertOne({
      type: "backup.cloud_verified",
      backupId: job.backupId,
      by: "backup-worker",
      at: new Date(),
    });
  } catch (error) {
    const retryable =
      !(error instanceof HttpError) &&
      error.code !== "ENOENT" &&
      job.attempts < 5;
    await store.backupSyncJobs.updateOne(
      { _id: job._id, leaseOwner: owner },
      {
        $set: {
          status: retryable ? "retrying" : "failed",
          nextAt: new Date(
            Date.now() + Math.min(60, 2 ** job.attempts) * 60000,
          ),
          message:
            error instanceof HttpError
              ? error.message
              : "Cloud copy was not verified. Check credentials, bucket permissions, network access and the original local backup.",
        },
      },
    );
  } finally {
    clearInterval(heartbeat);
  }
}
export async function listCloudBackups(config, cursor = "") {
  const value = settings(config),
    service = client(config);
  try {
    const result = await service.send(
      new ListObjectsV2Command({
        Bucket: value.bucket,
        Prefix: value.prefix,
        MaxKeys: 100,
        ...(cursor ? { ContinuationToken: cursor } : {}),
      }),
    );
    return {
      backups: (result.Contents || [])
        .filter(
          (row) =>
            row.Key?.startsWith(value.prefix) &&
            idPattern.test(
              row.Key.slice(value.prefix.length).replace(/\.akbackup$/, ""),
            ) &&
            row.Key.endsWith(".akbackup"),
        )
        .map((row) => ({
          id: row.Key.slice(value.prefix.length, -9),
          bytes: row.Size,
          modifiedAt: row.LastModified,
        })),
      nextCursor: result.NextContinuationToken || null,
    };
  } finally {
    if (!config.backupS3Client) service.destroy();
  }
}
export async function fetchCloudBackup(config, backupId) {
  const value = settings(config),
    file = localFile(config, backupId),
    service = client(config);
  try {
    const response = await service.send(
        new GetObjectCommand({
          Bucket: value.bucket,
          Key: value.prefix + backupId + ".akbackup",
        }),
      ),
      bytes = await objectBytes(response);
    if (
      !/^[a-f0-9]{64}$/.test(response.Metadata?.sha256 || "") ||
      digest(bytes) !== response.Metadata.sha256
    )
      throw new HttpError(
        409,
        "CLOUD_INTEGRITY",
        "The remote backup checksum is missing or does not match.",
      );
    await mkdir(config.backup.directory, { recursive: true, mode: 0o700 });
    let existing;
    try {
      existing = await readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing) {
      if (digest(existing) !== digest(bytes))
        throw new HttpError(
          409,
          "CLOUD_EXISTS",
          "A different local backup already has this identifier. It will not be overwritten.",
        );
    } else {
      const temporary = file + "." + randomBytes(8).toString("hex") + ".tmp";
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      try {
        await link(temporary, file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
    try {
      const { openBackup } = await import("./backups.js");
      await openBackup(config, backupId);
    } catch (error) {
      if (!existing) await unlink(file).catch(() => {});
      throw error;
    }
    return {
      backupId,
      path: file,
      bytes: bytes.length,
      sha256: digest(bytes),
      authenticated: true,
    };
  } finally {
    if (!config.backupS3Client) service.destroy();
  }
}
export function registerCloudBackups(api, store, config, requireAdmin) {
  api.get("/backup-cloud", requireAdmin, async (req, res) => {
    const policy = await store.settings.findOne({ _id: "backup-config" }),
      jobs = await store.backupSyncJobs
        .find({})
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
    res.json({
      configured: cloudReady(config),
      enabled: Boolean(policy?.offsiteEnabled),
      destination: cloudReady(config) ? destination(config) : null,
      jobs: jobs.map((row) => ({
        id: row._id,
        backupId: row.backupId,
        status: row.status,
        attempts: row.attempts,
        createdAt: row.createdAt,
        nextAt: row.nextAt,
        destination: row.destination,
        verifiedAt: row.result?.verifiedAt || null,
        bytes: row.result?.bytes || null,
        sha256: row.result?.sha256 || "",
        message: row.message || "",
      })),
    });
  });
  api.post("/backup-cloud/settings", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          enabled: z.boolean(),
          currentPassword: z.string().min(1).max(128),
        }),
        req.body,
      ),
      user = await store.staff.findOne({
        _id: req.staff._id,
        active: true,
        role: "admin",
      });
    if (
      !user ||
      !(await passwordMatches(input.currentPassword, user.passwordHash))
    )
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter your administrator password.",
      );
    if (input.enabled && !cloudReady(config))
      throw new HttpError(
        503,
        "CLOUD_CONFIG",
        "Configure the private backup bucket and credentials first.",
      );
    await store.settings.updateOne(
      { _id: "backup-config" },
      { $set: { offsiteEnabled: input.enabled } },
      { upsert: true },
    );
    await store.audit.insertOne({
      type: "backup.cloud_policy",
      by: req.staff.username,
      reason: input.enabled
        ? "Automatic encrypted off-site copies enabled"
        : "Automatic off-site copies disabled",
      at: new Date(),
    });
    res.json({ saved: true });
  });
  api.post("/backup-cloud/:id/copy", requireAdmin, async (req, res) => {
    const { openBackup } = await import("./backups.js");
    await openBackup(config, req.params.id);
    if (!cloudReady(config))
      throw new HttpError(
        503,
        "CLOUD_CONFIG",
        "Configure the private backup bucket first.",
      );
    const id = await queueCloudBackup(
      store,
      config,
      req.params.id,
      req.staff.username,
    );
    res.status(202).json({ jobId: id });
  });
  api.post("/backup-cloud/:id/retry", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({ reason: z.string().trim().min(3).max(160) }),
      req.body,
    );
    if (!cloudReady(config))
      throw new HttpError(
        503,
        "CLOUD_CONFIG",
        "Restore the original cloud configuration first.",
      );
    const row = await store.backupSyncJobs.findOneAndUpdate(
      {
        _id: req.params.id,
        status: "failed",
        destinationHash: fingerprint(config),
      },
      { $set: { status: "queued", attempts: 0, nextAt: new Date() } },
    );
    if (!row)
      throw new HttpError(
        409,
        "CLOUD_STATE",
        "Only a failed copy to the configured destination can be retried.",
      );
    await store.audit.insertOne({
      type: "backup.cloud_retried",
      backupId: row.backupId,
      by: req.staff.username,
      reason: input.reason,
      at: new Date(),
    });
    res.json({ queued: true });
  });
}
