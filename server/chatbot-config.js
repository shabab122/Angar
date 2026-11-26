import { isIP } from "node:net";

export function chatbotConfig(env = process.env) {
  const enabled = env.CHATBOT_ENABLED || "true";
  if (!["true", "false"].includes(enabled))
    throw new Error("CHATBOT_ENABLED must be true or false.");
  const baseUrl = env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid OLLAMA_BASE_URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateHost =
    [
      "localhost",
      "127.0.0.1",
      "::1",
      "ollama",
      "host.docker.internal",
    ].includes(host) ||
    (isIP(host) === 4 &&
      (/^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)));
  if (
    !privateHost ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error(
      "OLLAMA_BASE_URL must be a local/private HTTP(S) origin without credentials, query or path.",
    );
  const model = env.OLLAMA_MODEL || "qwen3:4b";
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,100}$/.test(model) ||
    /cloud/i.test(model)
  )
    throw new Error(
      "OLLAMA_MODEL must name an installed local model, not a cloud model.",
    );
  const timeoutSeconds = Number(env.CHATBOT_TIMEOUT_SECONDS || 90);
  const maxConcurrent = Number(env.CHATBOT_MAX_CONCURRENT || 1);
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 5 ||
    timeoutSeconds > 180
  )
    throw new Error("CHATBOT_TIMEOUT_SECONDS must be between 5 and 180.");
  if (
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 4
  )
    throw new Error("CHATBOT_MAX_CONCURRENT must be between 1 and 4.");
  return {
    enabled: enabled === "true",
    baseUrl: url.origin,
    model,
    timeoutMs: timeoutSeconds * 1000,
    maxConcurrent,
  };
}
