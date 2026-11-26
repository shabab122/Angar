const BUILD = "02d6ab4b2c098f22";
const SHELL = "angar-shell-" + BUILD,
  PUBLIC = "angar-public-" + BUILD;
const PRECACHE = /*__PRECACHE__*/ ["/", "/offline.html"];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE))),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") void self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      const names = await caches.keys(),
        shells = names.filter((n) => n.startsWith("angar-shell-")),
        keep = new Set([SHELL, ...shells.filter((n) => n !== SHELL).slice(-1)]);
      for (const name of names) {
        if (
          (name.startsWith("angar-shell-") && !keep.has(name)) ||
          (name.startsWith("angar-public-") &&
            !keep.has(name.replace("angar-public-", "angar-shell-")))
        )
          await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  ),
);
const isAsset = (url) => url.pathname.startsWith("/assets/") && !url.search;
self.addEventListener("fetch", (event) => {
  const req = event.request,
    url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (["/api/menu", "/api/restaurant"].includes(url.pathname) && !url.search) {
    const branch = req.headers.get("X-Angar-Branch");
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(branch || "")) return;
    const key = new Request(
      self.location.origin + "/__offline/catalog/" + branch + url.pathname,
    );
    event.respondWith(
      (async () => {
        const cache = await caches.open(PUBLIC);
        try {
          const response = await fetch(req);
          if (response.ok && response.headers.get("X-Angar-Branch") === branch)
            await cache.put(key, response.clone());
          return response;
        } catch {
          const cached = await cache.match(key);
          if (!cached) throw new Error("No saved menu for this branch");
          const headers = new Headers(cached.headers);
          headers.set("X-Angar-Offline", "1");
          return new Response(await cached.arrayBuffer(), {
            status: 200,
            headers,
          });
        }
      })(),
    );
    return;
  }
  // Context, accounts, delivery positions, staff data, payments and every write bypass caches.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/healthz" ||
    url.pathname.startsWith("/t/") ||
    url.pathname.startsWith("/b/")
  )
    return;
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(SHELL),
          publicPage = [
            "/",
            "/menu",
            "/about",
            "/events",
            "/takeaway",
            "/reservations",
          ].includes(url.pathname);
        return (
          (await cache.match(publicPage ? "/" : "/offline.html")) ||
          Response.error()
        );
      }),
    );
    return;
  }
  if (isAsset(url))
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const response = await fetch(req);
        if (response.ok) {
          const cache = await caches.open(SHELL);
          await cache.put(req, response.clone());
        }
        return response;
      })(),
    );
});
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
