let selected = "main";
try {
  selected =
    sessionStorage.getItem("angar.branch") ||
    localStorage.getItem("angar.lastBranch") ||
    "main";
} catch {}
if (!/^[a-z][a-z0-9-]{1,23}$/.test(selected)) selected = "main";
export const currentBranch = () => selected;
export const branchStorage = (key) =>
  selected === "main" ? key : key + ":" + selected;
export async function initializeBranch() {
  try {
    const response = await fetch("/api/branches", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error();
    const value = await response.json();
    if (/^[a-z][a-z0-9-]{1,23}$/.test(value.current)) selected = value.current;
    sessionStorage.setItem("angar.branch", selected);
    localStorage.setItem("angar.lastBranch", selected);
  } catch {
    /* Previously selected branch is enough to open its offline drafts. */
  }
}
export function branchChanged() {
  window.dispatchEvent(new Event("angar:branch-changed"));
}
export async function selectBranch(branchId) {
  const response = await fetch("/api/branches/select", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Angar-Branch": selected,
      },
      body: JSON.stringify({ branchId }),
      signal: AbortSignal.timeout(15000),
    }),
    result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message || "Could not change branch.");
  try {
    sessionStorage.setItem("angar.branch", branchId);
    localStorage.setItem("angar.lastBranch", branchId);
    localStorage.setItem("angar.branchChanged", String(Date.now()));
  } catch {}
  window.location.assign(
    window.location.pathname === "/staff" ? "/staff" : "/menu",
  );
}

export function branchUrl(value) {
  const url = new URL(value, window.location.origin);
  url.searchParams.set("branch", currentBranch());
  return url.pathname + url.search + url.hash;
}
