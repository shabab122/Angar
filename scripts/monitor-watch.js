import path from "node:path";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../server/config.js";
import { deliverMail, mailReady } from "../server/account-mail.js";
import { watchdogCycle } from "../server/watchdog.js";
const config = loadConfig(),
  url = new URL(process.env.MONITOR_URL || config.origin + "/readyz"),
  filename = path.resolve(
    process.env.MONITOR_STATE_FILE || "data/monitor/watchdog.json",
  );
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  (config.production && url.protocol !== "https:")
)
  throw new Error(
    "MONITOR_URL must be a direct HTTP(S) readiness URL without credentials, query or fragment.",
  );
if (!mailReady(config) || !config.monitoring.emails.length)
  throw new Error(
    "Configure SMTP and MONITOR_EMAIL_TO for the independent watchdog.",
  );
await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
const lock = filename + ".lock";
try {
  await mkdir(lock, { mode: 0o700 });
} catch {
  throw new Error(
    "Another watchdog may own this state file. Stop it before removing a stale .lock directory.",
  );
}
let stopped = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    stopped = true;
  });
try {
  let state = {};
  try {
    state = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Watchdog state is unreadable. Preserve it for review; no duplicate alerts were sent.",
      );
  }
  do {
    state = await watchdogCycle(state, {
      threshold: 2,
      probe: async () => {
        try {
          const response = await fetch(url, {
            redirect: "error",
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
          });
          if (!response.ok) return false;
          const reader = response.body.getReader();
          let size = 0,
            parts = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 4096) {
              await reader.cancel();
              return false;
            }
            parts.push(Buffer.from(value));
          }
          return (
            JSON.parse(Buffer.concat(parts).toString("utf8")).ready === true
          );
        } catch {
          return false;
        }
      },
      persist: async (value) => {
        const tmp = filename + ".tmp";
        await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
        await rename(tmp, filename);
      },
      send: (event) =>
        deliverMail(config, {
          to: config.monitoring.emails,
          subject: "Angar Kitchen service " + event,
          text:
            "The independently monitored readiness probe is " +
            event +
            ".\nTarget: " +
            url.origin +
            url.pathname +
            "\nCheck the server, database and background workers.",
        }),
    });
    console.log(
      "Readiness:",
      state.down ? "down" : "up",
      "failures:",
      state.failures,
      "alert:",
      state.alert?.status || "none",
    );
    if (!process.argv.includes("--once") && !stopped) await delay(30000);
  } while (!process.argv.includes("--once") && !stopped);
} finally {
  await rm(lock, { recursive: true });
}
