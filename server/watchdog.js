// Runs independently of the web server and database. Persist intent before SMTP:
// a connection loss can mean the mail server accepted a message already.
export async function watchdogCycle(
  state,
  { probe, send, persist, threshold = 2 },
) {
  const healthy = await probe(),
    next = {
      ...state,
      checkedAt: new Date().toISOString(),
      failures: healthy ? 0 : (state.failures || 0) + 1,
    };
  const change =
    !healthy && next.failures >= threshold && !state.down
      ? "down"
      : healthy && state.down
        ? "recovered"
        : null;
  if (change) {
    next.down = change === "down";
    next.alert = { event: change, status: "sending", at: next.checkedAt };
  }
  await persist(next);
  if (change) {
    try {
      await send(change);
      next.alert.status = "sent";
    } catch {
      next.alert.status = "uncertain";
    }
    await persist(next);
  }
  return next;
}
