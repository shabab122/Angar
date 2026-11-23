import { expireCourierTracking, pollNativeCourier } from "./courier.js";
import { runPrintJobs } from "./printing.js";
import { scanStaffAlerts, runStaffAlertDeliveries } from "./staff-alerts.js";
import { runBackupJobs } from "./backups.js";
import { runCloudBackupJobs } from "./backup-cloud.js";
import { workerHeartbeat, registerWorker } from "./monitoring.js";
export function startOperationsWorker(store, config, extra = async () => {}) {
  let stopped = false;
  const tasks = [
    async () => {
      await expireCourierTracking(store);
      await pollNativeCourier(store, config);
    },
    () => runBackupJobs(store, config),
    () => runCloudBackupJobs(store, config),
    () => runPrintJobs(store, config),
    async () => {
      await scanStaffAlerts(store, config);
      await runStaffAlertDeliveries(store, config);
    },
    extra,
  ].map((work, index) => ({
    name: [
      "courier",
      "backups",
      "offsite-backups",
      "printing",
      "staff-alerts",
      "notifications",
    ][index],
    work,
    running: false,
    pending: Promise.resolve(),
  }));
  const tick = () => {
    for (const task of tasks) {
      if (task.running || stopped) continue;
      task.running = true;
      registerWorker(store, task.name);
      task.pending = Promise.resolve()
        .then(task.work)
        .then(() => workerHeartbeat(store, task.name))
        .catch(() => {
          workerHeartbeat(store, task.name, true);
          console.error(
            "A background operation could not complete; inspect its staff status panel.",
          );
        })
        .finally(() => {
          task.running = false;
        });
    }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.all(tasks.map((task) => task.pending));
  };
}
