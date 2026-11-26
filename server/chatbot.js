import { randomBytes } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { getGuest, hash, passwordMatches, sessionToken } from "./security.js";
import { actorKey } from "./customer.js";
import { assertStaffAction } from "./access.js";
import { transaction } from "./money.js";
import { assistantCatalog, cleanText } from "./chatbot-catalog.js";
import { assistantHealth, understandWithOllama } from "./chatbot-ollama.js";
import { assistantReply } from "./chatbot-replies.js";
import { basicPlan, replyLanguage } from "./chatbot-understanding.js";

const duration = 24 * 3600000;
const requestKey = z.string().regex(/^[a-f0-9]{32}$/);
const scope = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0);
const owned = (store, req, res, config) => {
  const ownerKey = actorKey(req, getGuest(req, res, config));
  const id = hash(store.db.databaseName + ":" + ownerKey);
  return { _id: id, ownerKey };
};
const liveConversation = (row) => (row?.expiresAt > new Date() ? row : null);
const view = (row) => ({
  revision: row?.revision || 0,
  turns: (row?.turns || []).map(({ fingerprint, ...turn }) => turn),
  busy: Boolean(row?.lease?.expiresAt > new Date()),
});
async function policy(store, config) {
  const saved = await store.settings.findOne({ _id: "customer-assistant" });
  return {
    enabled: Boolean(config.chatbot?.enabled && saved?.enabled !== false),
    revision: saved?.revision || 0,
  };
}
const connected = (req, res, next) => {
  if (req.socket.destroyed || res.destroyed) return res.end();
  next();
};

export function registerAssistant(api, store, config) {
  const ipLimit = rateLimit({
    windowMs: 60000,
    limit: 40,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: {
        code: "CHAT_RATE_LIMIT",
        message: "Please wait a minute before sending more questions.",
      },
    },
  });
  const actorLimit = rateLimit({
    windowMs: 60000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => req.assistantOwner._id,
    message: {
      error: {
        code: "CHAT_RATE_LIMIT",
        message: "Please wait a minute before sending more questions.",
      },
    },
  });
  api.get("/assistant/config", async (req, res) => {
    res.json({
      ...(await policy(store, config)),
      retentionHours: 24,
      maxMessageLength: 600,
      waitMs: config.chatbot?.timeoutMs || 90000,
    });
  });
  api.get("/assistant", connected, async (req, res) => {
    const owner = owned(store, req, res, config),
      settings = await policy(store, config);
    const [conversation, health] = await Promise.all([
      store.assistantConversations.findOne(owner),
      settings.enabled
        ? assistantHealth(config)
        : Promise.resolve({ state: "disabled" }),
    ]);
    if (res.destroyed) return;
    res.json({
      scope: owner._id,
      conversation: view(liveConversation(conversation)),
      ...settings,
      ai: health,
      waitMs: config.chatbot?.timeoutMs || 90000,
      retentionHours: 24,
    });
  });
  const ownerMiddleware = (req, res, next) => {
    req.assistantOwner = owned(store, req, res, config);
    next();
  };
  api.post(
    "/assistant/messages",
    connected,
    ipLimit,
    connected,
    ownerMiddleware,
    actorLimit,
    async (req, res) => {
      const input = body(
        z.strictObject({
          message: z
            .string()
            .trim()
            .min(1)
            .max(600)
            .refine(
              (value) =>
                !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
              "Send a plain text question.",
            ),
          language: z.enum(["en", "bn"]),
          requestKey,
          expectedRevision: revision,
          scope,
        }),
        req.body,
      );
      const owner = req.assistantOwner;
      if (input.scope !== owner._id)
        throw new HttpError(
          409,
          "CHAT_SCOPE_CHANGED",
          "Your account or branch changed. Reopen the assistant before sending.",
        );
      if (!(await policy(store, config)).enabled)
        throw new HttpError(
          409,
          "CHAT_DISABLED",
          "The restaurant has paused the assistant.",
        );
      const fingerprint = hash(
          JSON.stringify({ message: input.message, language: input.language }),
        ),
        now = new Date();
      try {
        await store.assistantConversations.updateOne(
          { _id: owner._id },
          {
            $setOnInsert: {
              ...owner,
              revision: 0,
              turns: [],
              expiresAt: new Date(Date.now() + duration),
            },
          },
          { upsert: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
      await store.assistantConversations.updateOne(
        { ...owner, expiresAt: { $lte: now } },
        {
          $set: {
            revision: 0,
            turns: [],
            expiresAt: new Date(Date.now() + duration),
          },
          $unset: { lease: "", context: "" },
        },
      );
      const row = await store.assistantConversations.findOne(owner);
      if (!row)
        throw new HttpError(
          409,
          "CHAT_UPDATED",
          "The chat expired. Reopen it before sending again.",
        );
      const replay = row.turns.find(
        (turn) => turn.requestKey === input.requestKey,
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "CHAT_KEY_REUSED",
            "This request key belongs to another question.",
          );
        return res.json({ conversation: view(row), replay: true });
      }
      if (row.revision !== input.expectedRevision)
        throw new HttpError(
          409,
          "CHAT_UPDATED",
          "This chat changed in another tab. Review the latest messages before sending.",
        );
      const token = randomBytes(16).toString("hex"),
        until = new Date(
          Date.now() + (config.chatbot?.timeoutMs || 90000) + 15000,
        );
      const locked = await store.assistantConversations.findOneAndUpdate(
        {
          ...owner,
          revision: row.revision,
          $or: [
            { lease: { $exists: false } },
            { "lease.expiresAt": { $lte: now } },
          ],
        },
        {
          $set: {
            lease: { token, expiresAt: until },
            expiresAt: new Date(Date.now() + duration),
          },
        },
        { returnDocument: "after" },
      );
      if (!locked)
        throw new HttpError(
          409,
          "CHAT_BUSY",
          "A question is already being answered. Please wait or reload the chat.",
        );
      const controller = new AbortController();
      const cancelled = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", cancelled);
      if (res.destroyed || req.socket.destroyed) controller.abort();
      try {
        if (controller.signal.aborted) return;
        const catalog = await assistantCatalog(store);
        let plan,
          mode = "ollama",
          reason = null;
        try {
          plan = await understandWithOllama(
            config,
            input.message,
            catalog,
            locked.context || null,
            locked.turns,
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted || error.code === "cancelled") return;
          mode = "basic";
          reason = [
            "busy",
            "offline",
            "timeout",
            "model-missing",
            "local-model-required",
            "disabled",
            "invalid-reply",
          ].includes(error.code)
            ? error.code
            : "offline";
          plan = basicPlan(
            input.message,
            catalog,
            locked.context || null,
            locked.turns.at(-1)?.reply?.dishes || [],
          );
        }
        if (controller.signal.aborted || res.destroyed) return;
        // A model can take time to load. Always render fresh branch facts, never a
        // stale menu snapshot or factual prose supplied by the model.
        const current = await assistantCatalog(store);
        if (req.customer) {
          const token = req.cookies.angar_customer;
          const session = sessionToken(token)
            ? await store.customerSessions.findOne({
                _id: hash(token),
                customerId: req.customer._id,
                expiresAt: { $gt: new Date() },
              })
            : null;
          const customer = session
            ? await store.customers.findOne(
                { _id: req.customer._id, active: true },
                { projection: { authVersion: 1 } },
              )
            : null;
          if (
            !customer ||
            (customer.authVersion || 0) !== (req.customer.authVersion || 0)
          )
            throw new HttpError(
              401,
              "CHAT_SCOPE_CHANGED",
              "Your sign-in changed. Reopen the assistant.",
            );
        }
        if (!(await policy(store, config)).enabled)
          throw new HttpError(
            409,
            "CHAT_DISABLED",
            "The restaurant has paused the assistant.",
          );
        const language = replyLanguage(input.message, input.language),
          reply = assistantReply(current, plan, language);
        const turn = {
          requestKey: input.requestKey,
          fingerprint,
          message: cleanText(input.message, 600),
          at: new Date(),
          mode,
          reason,
          reply,
        };
        const saved = await store.assistantConversations.findOneAndUpdate(
          { ...owner, revision: locked.revision, "lease.token": token },
          {
            $set: {
              context: plan,
              turns: [...locked.turns.slice(-9), turn],
              expiresAt: new Date(Date.now() + duration),
            },
            $inc: { revision: 1 },
            $unset: { lease: "" },
          },
          { returnDocument: "after" },
        );
        if (!saved)
          throw new HttpError(
            409,
            "CHAT_UPDATED",
            "The chat changed. Reload before sending again.",
          );
        res.json({ conversation: view(saved), replay: false });
      } finally {
        res.off("close", cancelled);
        controller.abort();
        await store.assistantConversations.updateOne(
          { ...owner, "lease.token": token },
          { $unset: { lease: "" } },
        );
      }
    },
  );
  api.post(
    "/assistant/clear",
    connected,
    ipLimit,
    connected,
    ownerMiddleware,
    async (req, res) => {
      const input = body(
          z.strictObject({ expectedRevision: revision, scope }),
          req.body,
        ),
        owner = req.assistantOwner;
      if (input.scope !== owner._id)
        throw new HttpError(
          409,
          "CHAT_SCOPE_CHANGED",
          "Your account or branch changed. Reopen the assistant.",
        );
      const current = liveConversation(
        await store.assistantConversations.findOne(owner),
      );
      if (!current) return res.json({ conversation: view(null) });
      if (
        current.revision !== input.expectedRevision ||
        current.lease?.expiresAt > new Date()
      )
        throw new HttpError(
          409,
          "CHAT_BUSY",
          "The chat changed or is busy. Reload before clearing.",
        );
      const removed = await store.assistantConversations.deleteOne({
        ...owner,
        revision: current.revision,
        $or: [
          { lease: { $exists: false } },
          { "lease.expiresAt": { $lte: new Date() } },
        ],
      });
      if (!removed.deletedCount)
        throw new HttpError(
          409,
          "CHAT_BUSY",
          "A question started in another tab. Wait before clearing.",
        );
      res.json({ conversation: view(null) });
    },
  );
}

export function registerStaffAssistant(api, store, config) {
  api.get("/assistant", async (req, res) => {
    const settings = await policy(store, config);
    res.json({
      ...settings,
      configured: Boolean(config.chatbot?.enabled),
      model: config.chatbot?.model || "",
      baseUrl: config.chatbot?.baseUrl || "",
      health: await assistantHealth(config, true),
      retentionHours: 24,
      maxConcurrent: config.chatbot?.maxConcurrent || 1,
    });
  });
  api.put("/assistant", async (req, res) => {
    const input = body(
      z.strictObject({
        enabled: z.boolean(),
        expectedRevision: revision,
        currentPassword: z.string().min(1).max(128),
        reason: z.string().trim().min(3).max(160),
      }),
      req.body,
    );
    const actor = await store.staff.findOne({
      _id: req.staff._id,
      active: true,
    });
    if (
      !actor ||
      !(await passwordMatches(input.currentPassword, actor.passwordHash))
    )
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter your administrator password.",
      );
    if (input.enabled && !config.chatbot?.enabled)
      throw new HttpError(
        409,
        "CHAT_OPERATOR_DISABLED",
        "The operator must enable CHATBOT_ENABLED before a branch can enable its assistant.",
      );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "assistant.manage", session);
      await store.settings.updateOne(
        { _id: "customer-assistant-lock" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      const old = await store.settings.findOne(
        { _id: "customer-assistant" },
        { session },
      );
      if ((old?.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "CHAT_UPDATED",
          "Assistant settings changed. Reload before saving.",
        );
      await store.settings.updateOne(
        { _id: "customer-assistant" },
        {
          $set: { enabled: input.enabled, updatedAt: new Date() },
          $inc: { revision: 1 },
        },
        { session, upsert: true },
      );
      await store.audit.insertOne(
        {
          type: "assistant.configured",
          enabled: input.enabled,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
}
