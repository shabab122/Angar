import { registerOrganization } from "./organization.js";
import {
  monitoringMiddleware,
  registerMonitoring,
  readiness,
} from "./monitoring.js";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { createBranchApp } from "./app.js";
import {
  registerBranchManagement,
  getBranchRuntime,
  BRANCH_COOKIE,
  branchSlug,
} from "./branches.js";
import { cookieOptions } from "./security.js";
import { HttpError, errorHandler } from "./http.js";
export function createApp(store, config, frontendMiddleware) {
  const app = express(),
    runtime = getBranchRuntime(store, config),
    applications = new Map();
  app.disable("x-powered-by");
  if (config.proxyHops) app.set("trust proxy", config.proxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: config.dev
        ? false
        : {
            directives: {
              upgradeInsecureRequests: config.production ? [] : null,
            },
          },
      strictTransportSecurity: config.production ? undefined : false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(cookieParser(config.cookieSecret));
  app.use(monitoringMiddleware(store, config));
  app.get("/readyz", async (req, res) => {
    try {
      const state = await readiness(store);
      res
        .set("Cache-Control", "no-store")
        .status(state.ready ? 200 : 503)
        .json(state);
    } catch {
      res.status(503).json({ ready: false });
    }
  });
  const global = express.Router();
  global.use(
    ["/branches", "/organization", "/monitoring"],
    (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.get("origin") !== config.origin
      )
        throw new HttpError(
          403,
          "ORIGIN",
          "Open this application from its configured origin.",
        );
      next();
    },
  );
  global.use(
    ["/branches", "/organization", "/monitoring"],
    express.json({ limit: "18kb" }),
  );
  registerBranchManagement(global, store, config);
  registerOrganization(global, store, config);
  registerMonitoring(global, store, config);
  app.use("/api", global);
  app.use(async (req, res, next) => {
    const cookie = req.signedCookies[BRANCH_COOKIE] || "main",
      header = req.get("x-angar-branch");
    const qr = /^\/b\/([a-z][a-z0-9-]{1,23})\/t\/([^/?]+)$/.exec(req.path);
    const callback =
      /^\/api\/payments\/sslcommerz\//.test(req.path) ||
      /^\/api\/courier\/webhook$/.test(req.path);
    if (req.query.branch !== undefined && typeof req.query.branch !== "string")
      throw new HttpError(
        400,
        "INVALID_BRANCH",
        "Choose a valid restaurant branch.",
      );
    const queryBranch =
      typeof req.query.branch === "string" ? req.query.branch : null;
    let slug = qr?.[1] || queryBranch || header || cookie;
    if (!branchSlug.safeParse(slug).success)
      throw new HttpError(
        400,
        "INVALID_BRANCH",
        "Choose a valid restaurant branch.",
      );
    if (
      req.path.startsWith("/api/") &&
      !callback &&
      ((header && header !== cookie) || (queryBranch && queryBranch !== cookie))
    )
      throw new HttpError(
        409,
        "BRANCH_CHANGED",
        "The selected branch changed in another tab. Refresh this page before continuing.",
      );
    let context;
    try {
      context = await runtime.get(slug);
    } catch (error) {
      if (
        !req.path.startsWith("/api/") &&
        !qr &&
        !queryBranch &&
        !header &&
        error.code === "BRANCH_UNAVAILABLE"
      ) {
        slug = "main";
        context = await runtime.get(slug);
        res.cookie(
          BRANCH_COOKIE,
          slug,
          cookieOptions(config, { signed: true, maxAge: 365 * 86400000 }),
        );
        for (const name of [
          "angar_table",
          "angar_customer",
          "angar_staff_pending",
        ])
          res.clearCookie(name, cookieOptions(config));
      } else throw error;
    }
    res.set("X-Angar-Branch", slug);
    res.set("Cache-Control", "no-store");
    res.vary("X-Angar-Branch");
    if (qr || (!callback && queryBranch && queryBranch !== cookie)) {
      res.cookie(
        BRANCH_COOKIE,
        slug,
        cookieOptions(config, { signed: true, maxAge: 365 * 86400000 }),
      );
      if (slug !== cookie)
        for (const name of [
          "angar_table",
          "angar_customer",
          "angar_staff_pending",
        ])
          res.clearCookie(name, cookieOptions(config));
    }
    if (req.path.startsWith("/api/") && queryBranch) {
      const target = new URL(req.url, "http://branch.invalid");
      target.searchParams.delete("branch");
      req.url = target.pathname + target.search;
    }
    if (qr) req.url = "/t/" + qr[2];
    if (!applications.has(slug))
      applications.set(
        slug,
        createBranchApp(context.store, context.config, frontendMiddleware),
      );
    applications.get(slug)(req, res, next);
  });
  app.use(errorHandler);
  app.branchRuntime = runtime;
  app.stopLive = () =>
    Promise.all([...applications.values()].map((child) => child.stopLive?.()));
  return app;
}
