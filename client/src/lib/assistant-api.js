import { ApiError } from "./api";
import { currentBranch, branchChanged } from "./branch";

// Local model loading can exceed the ordinary 15-second application API limit.
// Keep this timeout and cancellation specific to chat.
export async function assistantApi(
  path,
  { data, signal, waitMs = 15000 } = {},
) {
  let response;
  try {
    const timeout = AbortSignal.timeout(Math.min(200000, waitMs));
    response = await fetch("/api/assistant" + path, {
      method: data ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: {
        Accept: "application/json",
        "X-Angar-Branch": currentBranch(),
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  } catch {
    if (signal?.aborted)
      throw new ApiError(0, "CANCELLED", "Chat request cancelled.");
    throw new ApiError(
      0,
      "NETWORK",
      "The answer could not be confirmed. Reload the chat or retry the same question.",
    );
  }
  const result = await response.json().catch(() => null);
  if (result?.error?.code === "BRANCH_CHANGED") branchChanged();
  if (!response.ok || !result)
    throw new ApiError(
      response.status,
      result?.error?.code || "SERVER_ERROR",
      result?.error?.message ||
        "The assistant could not respond. Please try again.",
    );
  return result;
}
