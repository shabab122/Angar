self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    return;
  }
  const target =
    typeof payload.url === "string" &&
    payload.url.startsWith("/") &&
    !payload.url.startsWith("//")
      ? payload.url
      : "/notifications";
  event.waitUntil(
    self.registration.showNotification(
      String(payload.title || "Angar Kitchen").slice(0, 100),
      {
        body: String(payload.body || "You have a restaurant update.").slice(
          0,
          300,
        ),
        tag: String(payload.tag || "angar-update"),
        data: { url: target },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    event.notification.data?.url || "/notifications",
    self.location.origin,
  );
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const client = clients.find(
          (client) => new URL(client.url).origin === target.origin,
        );
        if (client) {
          await client.navigate(target.href);
          return client.focus();
        }
        return self.clients.openWindow(target.href);
      }),
  );
});
