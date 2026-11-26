import { fixture, post, ok, key } from "./support.js";
import { emptyPlan } from "../server/chatbot-understanding.js";
export { post, ok, key };
export const aiPlan = (changes = {}) => ({
  ...emptyPlan(),
  intent: "recommend",
  ...changes,
});
export async function assistantFixture(t, options = {}) {
  const calls = [];
  const chatbot = {
    enabled: true,
    baseUrl:
      "http://127.0.0.1:" + (20000 + (parseInt(key().slice(0, 4), 16) % 30000)),
    model: "qwen3:4b",
    timeoutMs: 1000,
    maxConcurrent: 1,
    ...options.chatbot,
  };
  const f = await fixture(t, {
    chatbot,
    chatbotTransport: async (request) => {
      calls.push(request);
      if (options.transport) return options.transport(request);
      if (request.path === "/api/tags")
        return { models: [{ name: chatbot.model }] };
      if (request.path === "/api/show") return { capabilities: ["completion"] };
      const context = JSON.parse(request.body.messages.at(-1).content);
      const plan =
        typeof options.plan === "function"
          ? await options.plan(context, request, f)
          : options.plan || aiPlan();
      return {
        model: chatbot.model,
        done: true,
        message: { role: "assistant", content: JSON.stringify(plan) },
      };
    },
  });
  return { ...f, calls };
}
export async function ask(client, message, extra = {}) {
  const current = ok(await client("/api/assistant"));
  return post(client, "/api/assistant/messages", {
    message,
    language: "en",
    requestKey: key(),
    expectedRevision: current.conversation.revision,
    scope: current.scope,
    ...extra,
  });
}
export const answer = (response) => ok(response).conversation.turns.at(-1);
