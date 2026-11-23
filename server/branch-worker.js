import { getBranchRuntime } from "./branches.js";
import { startOperationsWorker } from "./operations-worker.js";
import { scanNotifications, runNotificationJobs } from "./notifications.js";
import { workerHeartbeat } from "./monitoring.js";
export function startBranchWorkers(store, config) {
  const runtime = getBranchRuntime(store, config),
    workers = new Map();
  let stopped = false,
    busy = false,
    pending = Promise.resolve();
  const tick = () => {
    if (stopped || busy) return;
    busy = true;
    pending = (async () => {
      for (const branch of await runtime.all()) {
        if (workers.has(branch._id)) continue;
        try {
          const context = await runtime.get(branch._id);
          if (stopped) break;
          workers.set(
            branch._id,
            startOperationsWorker(context.store, context.config, async () => {
              await scanNotifications(context.store, context.config);
              await runNotificationJobs(context.store, context.config);
            }),
          );
          workerHeartbeat(store, "branch-discovery-" + branch._id);
        } catch {
          workerHeartbeat(store, "branch-discovery-" + branch._id, true);
          console.error(
            "A branch worker needs operator attention. Check branch recovery status.",
          );
        }
      }
      workerHeartbeat(store, "branch-discovery");
    })()
      .catch(() => {
        workerHeartbeat(store, "branch-discovery", true);
        console.error("Branch worker discovery could not complete.");
      })
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
    await Promise.all([...workers.values()].map((stop) => stop()));
  };
}
