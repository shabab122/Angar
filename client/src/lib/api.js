export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(
  path,
  { method = "GET", data, headers = {}, image } = {},
) {
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/json",
        ...(data !== undefined || image
          ? { "Content-Type": image ? image.type : "application/json" }
          : {}),
        ...headers,
      },
      ...(image
        ? { body: image }
        : data === undefined
          ? {}
          : { body: JSON.stringify(data) }),
    });
  } catch {
    throw new ApiError(
      0,
      "NETWORK",
      "Connection lost. Please check your internet and try again.",
    );
  }
  if (response.status === 204) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result)
    throw new ApiError(
      response.status,
      result?.error?.code || "SERVER_ERROR",
      result?.error?.message || "Something went wrong. Please try again.",
    );
  return result;
}

export function readStorage(key, fallback, session = false) {
  try {
    return (
      JSON.parse((session ? sessionStorage : localStorage).getItem(key)) ??
      fallback
    );
  } catch {
    return fallback;
  }
}
export function saveStorage(key, value, session = false) {
  try {
    const storage = session ? sessionStorage : localStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be disabled while the rest of the app remains usable. */
  }
}
export function requestKey() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function money(value, language = "en") {
  return (
    "৳" +
    new Intl.NumberFormat(language === "bn" ? "bn-BD" : "en-BD", {
      maximumFractionDigits: 2,
    }).format(value || 0)
  );
}
export function dhakaTime(value, dateOnly = false, language = "en") {
  return new Intl.DateTimeFormat(language === "bn" ? "bn-BD" : "en-BD", {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    ...(dateOnly ? {} : { timeStyle: "short" }),
  }).format(new Date(value));
}
export const localDate = (value = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
export const statusNames = {
  placed: "Awaiting staff",
  queued: "Sent to kitchen",
  preparing: "Preparing",
  ready: "Ready to serve",
  served: "Served",
  cancelled: "Cancelled",
  paid: "Paid",
  finalized: "Awaiting payment",
  requested: "Request received",
  reviewing: "Under review",
  quote_sent: "Quote ready",
  awaiting_deposit: "Awaiting deposit",
  confirmed: "Confirmed",
  completed: "Completed",
  declined: "Declined",
};
export const statusBn = {
  placed: "স্টাফের অপেক্ষায়",
  queued: "কিচেনে পাঠানো হয়েছে",
  preparing: "প্রস্তুত হচ্ছে",
  ready: "পরিবেশনের জন্য প্রস্তুত",
  served: "পরিবেশিত",
  cancelled: "বাতিল",
  paid: "পরিশোধিত",
  finalized: "পেমেন্টের অপেক্ষায়",
};
