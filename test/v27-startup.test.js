import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ObjectId } from "mongodb";
import {
  fixture,
  post,
  ok,
  password,
  key,
  browser,
  origin,
} from "./support.js";
import { getBranchRuntime } from "../server/branches.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("production entry starts branch workers and cleanly closes an active live stream on shutdown", async (t) => {
  const f = await fixture(t);
  ok(
    await post(f.staff.admin, "/api/branches", {
      id: "uttara",
      name: "Uttara",
      address: "Uttara",
      tables: 1,
      copyMenu: true,
      currentPassword: password,
      requestKey: key(),
    }),
    201,
  );
  const child = await getBranchRuntime(f.store, f.config).get("uttara");
  const ingredientId = new ObjectId();
  await child.store.ingredients.insertOne({
    _id: ingredientId,
    name: "Startup low stock",
    unit: "g",
    stock: 0,
    reorderLevel: 10,
    revision: 0,
  });
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const processHandle = spawn(
      process.execPath,
      ["--env-file-if-exists=.env", "server/index.js"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MONGODB_DB: f.config.mongoDatabase,
          APP_ORIGIN: origin,
          HOST: "127.0.0.1",
          PORT: String(port),
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
    exit = once(processHandle, "exit");
  let stdout = "",
    stderr = "",
    reader;
  const abort = new AbortController();
  processHandle.stdout.on("data", (bytes) => (stdout += bytes));
  processHandle.stderr.on("data", (bytes) => (stderr += bytes));
  try {
    const url = "http://127.0.0.1:" + port;
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      try {
        healthy = (await fetch(url + "/healthz")).ok;
      } catch {}
      if (healthy) break;
      if (processHandle.exitCode !== null) break;
      await delay(100);
    }
    assert.equal(healthy, true, stdout + " " + stderr);
    const client = browser(url);
    assert.equal((await client("/menu?branch=uttara")).status, 200);
    ok(await client("/healthz"));
    const login = await post(client, "/api/staff/login", {
      username: "admin",
      password,
    });
    ok(login);
    const cookie = login.headers
      .getSetCookie()
      .map((raw) => raw.split(";")[0])
      .join("; ");
    const response = await fetch(url + "/api/staff/live", {
      headers: {
        Cookie:
          cookie +
          "; " +
          (
            await client("/api/branches/select", {
              method: "POST",
              data: { branchId: "uttara" },
            })
          ).headers
            .getSetCookie()
            .map((raw) => raw.split(";")[0])
            .join("; "),
      },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    await reader.read();
    let scanned = false;
    for (let i = 0; i < 80; i++) {
      scanned = Boolean(
        await child.store.staffAlerts.findOne({ active: true }),
      );
      if (scanned) break;
      await delay(100);
    }
    assert.equal(
      scanned,
      true,
      "The ready child branch worker did not scan its stock.",
    );
    processHandle.kill("SIGTERM");
    const result = await Promise.race([
      exit,
      delay(8000).then(() => {
        throw new Error("Production shutdown did not close its live stream.");
      }),
    ]);
    assert.equal(result[0], 0, stderr);
    assert.equal(stderr, "");
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    if (processHandle.exitCode === null) {
      processHandle.kill("SIGKILL");
      await exit;
    }
    await child.store.db.dropDatabase();
  }
});
