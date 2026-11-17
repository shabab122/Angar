import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";

try {
  const config = loadConfig();
  const store = await connectDatabase(config);
  config.dev = process.argv.includes("--dev");
  const vite = config.dev
    ? await (
        await import("vite")
      ).createServer({ server: { middlewareMode: true }, appType: "spa" })
    : null;
  const server = createApp(store, config, vite?.middlewares).listen(
    config.port,
    config.host,
    () => {
      console.log(
        `Angar Kitchen listening on http://${config.host}:${config.port}`,
      );
    },
  );
  server.on("error", async (error) => {
    console.error("Could not listen:", error.code || error.message);
    await store.client.close();
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close(async () => {
        await store.client.close();
        await vite?.close();
      });
    });
  }
} catch (error) {
  console.error("Could not start Angar Kitchen:", error.message);
  process.exitCode = 1;
}
