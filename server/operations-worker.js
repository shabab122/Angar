import { expireCourierTracking } from "./courier.js";
import { runPrintJobs } from "./printing.js";
import { scanStaffAlerts, runStaffAlertDeliveries } from "./staff-alerts.js";
import { runBackupJobs } from "./backups.js";
import { runCloudBackupJobs } from "./backup-cloud.js";
export function startOperationsWorker(store, config, extra = async () => {}) {
  let stopped = false;
  const tasks = [
    () => expireCourierTracking(store),
    () => runBackupJobs(store, config),
    () => runCloudBackupJobs(store, config),
    () => runPrintJobs(store, config),
    async () => {
      await scanStaffAlerts(store, config);
      await runStaffAlertDeliveries(store, config);
    },
    extra,
  ].map((work) => ({
    work,
    running: false,
    pending: Promise.resolve(),
  }));
  const tick = () => {
    for (const task of tasks) {
      if (task.running || stopped) continue;
      task.running = true;
      task.pending = Promise.resolve()
        .then(task.work)
        .catch(() => {
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
