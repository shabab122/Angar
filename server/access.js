import { HttpError } from "./http.js";

export const permissionCatalog = [
  ["orders.view", "View order desk", ["admin", "kitchen", "waiter", "cashier"]],
  ["orders.send", "Accept / decline / cancel table orders", ["admin"]],
  ["orders.prepare", "Prepare kitchen orders", ["admin", "kitchen"]],
  ["orders.serve", "Mark table orders served", ["waiter"]],
  ["orders.manual", "Enter waiter orders", ["admin", "waiter"]],
  ["orders.review", "Approve guest order changes", ["admin"]],
  ["tables.view", "View table visits", ["admin", "waiter", "cashier"]],
  ["tables.manage", "Manage table visits", ["admin", "waiter"]],
  ["billing.view", "View counter bills", ["admin", "cashier"]],
  [
    "billing.manage",
    "Finalize / split / record bill payments",
    ["admin", "cashier"],
  ],
  ["refund.request", "Request guest refunds", ["admin", "cashier"]],
  ["refund.approve", "Approve / reject guest refunds", ["admin"]],
  [
    "refund.execute",
    "Record / reconcile approved guest refunds",
    ["admin", "cashier"],
  ],
  ["inventory.view", "View ingredients / batches", ["admin", "kitchen"]],
  [
    "inventory.configure",
    "Configure ingredients / recipes / lot condition",
    ["admin"],
  ],
  ["inventory.receive", "Receive / correct manual inventory", ["admin"]],
  ["inventory.waste", "Record physical waste", ["admin", "kitchen"]],
  ["stocktake.count", "Count / submit / recount stock", ["admin", "kitchen"]],
  ["stocktake.approve", "Review stocktake differences", ["admin"]],
  ["purchase.view", "View suppliers / purchase history", ["admin", "cashier"]],
  ["supplier.manage", "Edit supplier contacts", ["admin"]],
  ["purchase.create", "Create purchase drafts", ["admin"]],
  ["purchase.approve", "Confirm / cancel purchase orders", ["admin"]],
  ["purchase.receive", "Receive supplier deliveries", ["admin"]],
  ["purchase.pay", "Record actual supplier payments", ["admin", "cashier"]],
  ["supplier.return", "Request / approve / confirm returned goods", ["admin"]],
  ["supplier.refund", "Record supplier refunds received", ["admin", "cashier"]],
  [
    "finance.view",
    "View valuation / operating reports / expenses",
    ["admin", "cashier"],
  ],
  ["finance.valuation", "Record supported opening valuation", ["admin"]],
  ["expense.request", "Request operating expenses", ["admin", "cashier"]],
  ["expense.approve", "Review operating expenses", ["admin"]],
  ["expense.pay", "Record actual expense payments", ["admin", "cashier"]],
  ["events.view", "View private-event bookings", ["admin"]],
  ["events.manage", "Review / quote / record event actions", ["admin"]],
  ["events.configure", "Edit event spaces / packages / pricing", ["admin"]],
  [
    "reservations.manage",
    "Manage reservations / waiting list",
    ["admin", "waiter"],
  ],
  ["menu.manage", "Edit dishes and prices", ["admin"]],
  [
    "availability.manage",
    "Toggle kitchen food availability",
    ["admin", "kitchen"],
  ],
  ["reports.view", "View / export sales reports", ["admin", "cashier"]],
  ["audit.view", "View / export staff activity", ["admin"]],
  ["staff.manage", "Manage eligible staff accounts", ["admin"]],
  ["backups.manage", "Manage encrypted backups / off-site copies", ["admin"]],
  [
    "settings.manage",
    "Edit restaurant / invoice / gateway settings",
    ["admin"],
  ],
  ["notifications.manage", "Review customer notification delivery", ["admin"]],
  [
    "courier.manage",
    "Book / assign / reconcile deliveries",
    ["admin", "waiter"],
  ],
  ["courier.confirm", "Confirm delivery handover", ["admin", "waiter"]],
  ["printing.kitchen", "View / print kitchen tickets", ["admin", "kitchen"]],
  ["printing.receipt", "View / print counter receipts", ["admin", "cashier"]],
  ["printing.configure", "Configure automatic printer sending", ["admin"]],
  [
    "alerts.view",
    "View own station operations alerts",
    ["admin", "kitchen", "cashier"],
  ],
  ["alerts.configure", "Configure staff alert delivery", ["admin"]],
  [
    "cash.manage",
    "Manage shared drawer and shift counts",
    ["admin", "cashier"],
  ],
  ["floor.manage", "Handle floor service requests", ["admin", "waiter"]],
];
permissionCatalog.push(
  [
    "assistant.manage",
    "Configure the customer AI assistant and view local model health",
    ["admin"],
  ],
  [
    "purchase.suggest",
    "Configure stock replenishment suggestions and draft automation",
    ["admin"],
  ],
  [
    "attendance.self",
    "View own duties and clock attendance",
    ["admin", "kitchen", "waiter", "cashier"],
  ],
  [
    "attendance.manage",
    "Manage branch duty roster and review actual attendance",
    ["admin"],
  ],
  [
    "payroll.manage",
    "Configure salary rates, calculate and approve branch payroll",
    ["admin"],
  ],
  ["branches.manage", "Create / edit restaurant branches", ["admin"]],
  ["reviews.manage", "Moderate guest reviews", ["admin"]],
  ["branches.dashboard", "View consolidated branch performance", ["admin"]],
  [
    "transfers.view",
    "View transfers involving this branch",
    ["admin", "kitchen"],
  ],
  [
    "transfers.request",
    "Request stock transfers and view destination ingredient catalogue",
    ["admin", "kitchen"],
  ],
  ["transfers.approve", "Approve outgoing stock transfers", ["admin"]],
  [
    "transfers.dispatch",
    "Count and dispatch approved stock transfers",
    ["admin", "kitchen"],
  ],
  [
    "transfers.receive",
    "Count and receive incoming stock transfers",
    ["admin", "kitchen"],
  ],
  ["monitoring.view", "View technical incidents and service status", ["admin"]],
  [
    "monitoring.manage",
    "Configure and acknowledge technical incident alerts",
    ["admin"],
  ],
);
export const permissionKeys = permissionCatalog.map(([key]) => key);
export const memberBranches = (user) =>
  Array.isArray(user?.branchIds) ? user.branchIds : ["main"];
export const identityStaff = (user) =>
  user?.identity ? { ...user, ...user.identity, identity: undefined } : user;
export const isPlatformAdmin = (user) => {
  const raw = identityStaff(user);
  return Boolean(
    raw?.active !== false &&
    raw?.role === "admin" &&
    memberBranches(raw).includes("main"),
  );
};
export function effectiveStaff(user, branch = "main") {
  if (!user) return user;
  const raw = identityStaff(user),
    profile = raw.branchAccess?.[branch];
  return {
    ...raw,
    role: profile?.role || raw.role,
    access: profile?.access || raw.access,
    branchId: branch,
    identity: {
      role: raw.role,
      access: raw.access,
      branchIds: raw.branchIds,
      branchAccess: raw.branchAccess,
      active: raw.active,
    },
  };
}
export const hasBranchAccess = (user, branch = "main") =>
  Boolean(
    user &&
    user.active !== false &&
    (isPlatformAdmin(user) || memberBranches(user).includes(branch)),
  );
export const hasPermission = (user, key) =>
  Boolean(
    permissionCatalog.find(
      ([name, , roles]) => name === key && roles.includes(user?.role),
    ) && !user?.access?.denied?.includes(key),
  );
export const capabilities = (user) =>
  Object.fromEntries(
    permissionKeys.map((key) => [key, hasPermission(user, key)]),
  );
const limitPermissions = {
  refundApproval: "refund.approve",
  purchaseApproval: "purchase.approve",
  purchasePayment: "purchase.pay",
  expenseApproval: "expense.approve",
};
function assertDelegation(actor, target) {
  if (actor.role !== "admin" && actor.role !== target.role)
    throw new HttpError(
      403,
      "STAFF_PRIVILEGE",
      "An administrator with sufficient access in this branch must grant a different branch role.",
    );
  const denied = actor.access?.denied || [];
  if (denied.some((key) => hasPermission(target, key)))
    throw new HttpError(
      403,
      "STAFF_PRIVILEGE",
      "This account has broader action access. Ask an unrestricted main-branch administrator to manage it.",
    );
  for (const [key, permission] of Object.entries(limitPermissions)) {
    const limit = actor.access?.limitsMinor?.[key],
      targetLimit = target.access?.limitsMinor?.[key];
    if (
      limit != null &&
      hasPermission(target, permission) &&
      (targetLimit == null || targetLimit > limit)
    )
      throw new HttpError(
        403,
        "STAFF_PRIVILEGE",
        "This account has a higher amount approval limit. Ask an authorized main-branch administrator to manage it.",
      );
  }
}
export function assertManageStaff(actor, target, branch = "main") {
  const rawTarget = identityStaff(target),
    rawActor = identityStaff(actor),
    currentTarget = effectiveStaff(rawTarget, branch);
  if (
    !isPlatformAdmin(rawActor) &&
    (rawTarget.role === "admin" ||
      currentTarget.role === "admin" ||
      memberBranches(rawTarget).length !== 1 ||
      !memberBranches(rawTarget).includes(branch))
  )
    throw new HttpError(
      403,
      "STAFF_SCOPE",
      "A main-branch administrator manages administrators and accounts shared with other branches.",
    );
  assertDelegation(effectiveStaff(rawActor, branch), currentTarget);
  if (isPlatformAdmin(rawActor)) {
    assertDelegation(rawActor, rawTarget);
    for (const slug of new Set([
      ...memberBranches(rawTarget),
      ...Object.keys(rawTarget.branchAccess || {}),
    ]))
      assertDelegation(
        effectiveStaff(rawActor, slug),
        effectiveStaff(rawTarget, slug),
      );
  }
}
export async function assertStaffAction(store, actor, permission, session) {
  const raw = await store.staff.findOneAndUpdate(
    { _id: actor._id, active: true },
    { $inc: { actionRevision: 1 } },
    { session, returnDocument: "after" },
  );
  if (
    !raw ||
    (raw.authVersion || 0) !== (actor.authVersion || 0) ||
    !hasBranchAccess(raw, store.branchId || "main")
  )
    throw new HttpError(
      401,
      "STAFF_REQUIRED",
      "Your access changed. Sign in again.",
    );
  const current = effectiveStaff(raw, store.branchId || "main");
  if (!hasPermission(current, permission))
    throw new HttpError(
      403,
      "PERMISSION_DENIED",
      "Your current branch role cannot perform this action.",
    );
  return current;
}
export function mergeInheritedAccess(actor, role, existing = {}) {
  const inherited = inheritedAccess(actor, role),
    limitsMinor = { ...existing.limitsMinor };
  for (const [key, value] of Object.entries(inherited.limitsMinor)) {
    if (value !== null && value !== undefined)
      limitsMinor[key] =
        limitsMinor[key] == null ? value : Math.min(limitsMinor[key], value);
  }
  return {
    denied: [...new Set([...(existing.denied || []), ...inherited.denied])],
    limitsMinor,
  };
}
export async function assertMainStaffManager(store, replacement, session) {
  const usable = (user) =>
    isPlatformAdmin(user) &&
    hasPermission(user, "staff.manage") &&
    hasPermission(effectiveStaff(user, "main"), "staff.manage");
  if (usable(replacement)) return;
  const others = await store.staff
    .find(
      {
        _id: { $ne: replacement._id },
        active: true,
        role: "admin",
        $or: [{ branchIds: "main" }, { branchIds: { $exists: false } }],
      },
      { session },
    )
    .toArray();
  if (!others.some(usable))
    throw new HttpError(
      409,
      "LAST_ADMIN",
      "Keep an active main-branch administrator with effective staff management access.",
    );
}
export const inheritedAccess = (actor, role) => ({
  denied: permissionCatalog
    .filter(([, , roles]) => roles.includes(role))
    .map(([key]) => key)
    .filter((key) => actor.access?.denied?.includes(key)),
  limitsMinor: { ...(actor.access?.limitsMinor || {}) },
});
export async function assertApprovalLimit(
  store,
  actor,
  key,
  amountMinor,
  session,
) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new HttpError(
      400,
      "APPROVAL_AMOUNT",
      "A stored exact-money total is required for this approval.",
    );
  const raw = await store.staff.findOneAndUpdate(
    { _id: actor._id, active: true },
    { $inc: { approvalRevision: 1 } },
    { session, returnDocument: "after" },
  );
  if (
    !raw ||
    (raw.authVersion || 0) !== (actor.authVersion || 0) ||
    !hasBranchAccess(raw, store.branchId || "main")
  )
    throw new HttpError(
      401,
      "STAFF_REQUIRED",
      "Your access changed. Sign in again.",
    );
  const current = effectiveStaff(raw, store.branchId || "main");
  const permission = {
    refundApproval: "refund.approve",
    purchaseApproval: "purchase.approve",
    purchasePayment: "purchase.pay",
    expenseApproval: "expense.approve",
  }[key];
  if (!hasPermission(current, permission))
    throw new HttpError(
      403,
      "PERMISSION_DENIED",
      "Your current account cannot approve this action.",
    );
  const limit = current.access?.limitsMinor?.[key];
  if (limit !== undefined && limit !== null && amountMinor > limit)
    throw new HttpError(
      403,
      "APPROVAL_LIMIT",
      "This amount exceeds your per-action approval limit. Ask an authorized administrator to review it.",
    );
}
export function routePermission(req) {
  const p = req.path,
    m = req.method,
    b = req.body || {};
  if (/^\/assistant(?:\/|$)/.test(p)) return "assistant.manage";
  if (/^\/purchase-suggestions(?:\/|$)/.test(p)) return "purchase.suggest";
  if (/^\/payroll(?:\/|$)/.test(p)) return "payroll.manage";
  if (/^\/attendance(?:\/|$)/.test(p))
    return p === "/attendance/me" || /\/clock-(in|out)$/.test(p)
      ? "attendance.self"
      : "attendance.manage";
  if (
    ["/me", "/password", "/access-catalog"].includes(p) ||
    /^\/mfa(?:\/|$)/.test(p)
  )
    return p === "/access-catalog" ? "staff.manage" : null;
  if (/^\/(?:reviews|review-media)(?:\/|$)/.test(p)) return "reviews.manage";
  if (/^\/stock-transfers(?:\/|$)/.test(p)) {
    if (p === "/stock-transfers/options") return "transfers.request";
    if (m === "GET") return "transfers.view";
    if (/\/receive$/.test(p)) return "transfers.receive";
    if (/\/recovery$/.test(p)) return "transfers.approve";
    if (/\/action$/.test(p))
      return b.action === "dispatch"
        ? "transfers.dispatch"
        : "transfers.approve";
    return "transfers.request";
  }
  if (/^\/team(?:\/|$)/.test(p)) return "staff.manage";
  if (/^\/orders(?:\/|$)/.test(p)) {
    if (m === "GET") return "orders.view";
    if (p === "/orders") return "orders.manual";
    if (/\/changes\//.test(p)) return "orders.review";
    if (/\/cancel$/.test(p)) return "orders.send";
    return ["send", "reject"].includes(b.action)
      ? "orders.send"
      : ["start", "ready"].includes(b.action)
        ? "orders.prepare"
        : b.action === "serve"
          ? "orders.serve"
          : "orders.view";
  }
  if (/^\/tables(?:\/|$)/.test(p))
    return m === "GET" ? "tables.view" : "tables.manage";
  if (/^\/(?:bills|billing)(?:\/|$)/.test(p)) {
    if (/\/refunds$/.test(p) && m === "POST") return "refund.request";
    return m === "GET" ? "billing.view" : "billing.manage";
  }
  if (/^\/refunds(?:\/|$)/.test(p) || /^\/refund-sources(?:\/|$)/.test(p))
    return m === "GET"
      ? "refund.request"
      : /\/decision$/.test(p)
        ? "refund.approve"
        : /\/(?:execute|reconcile)$/.test(p)
          ? "refund.execute"
          : "refund.request";
  if (/^\/inventory(?:\/|$)/.test(p)) {
    if (m === "GET") return "inventory.view";
    if (/\/stock$/.test(p))
      return b.kind === "waste" ? "inventory.waste" : "inventory.receive";
    return "inventory.configure";
  }
  if (/^\/stocktakes(?:\/|$)/.test(p))
    return /\/decision$/.test(p) ? "stocktake.approve" : "stocktake.count";
  if (/^\/suppliers(?:\/|$)/.test(p))
    return m === "GET" ? "purchase.view" : "supplier.manage";
  if (/^\/purchases(?:\/|$)/.test(p)) {
    if (m === "GET") return "purchase.view";
    if (p === "/purchases" || m === "PATCH") return "purchase.create";
    if (/\/supplier-refunds$/.test(p)) return "supplier.refund";
    if (/\/payments$/.test(p)) return "purchase.pay";
    if (/\/receive$/.test(p)) return "purchase.receive";
    return "purchase.approve";
  }
  if (/^\/supplier-returns(?:\/|$)/.test(p))
    return m === "GET" ? "purchase.view" : "supplier.return";
  if (/^\/finance(?:\/|$)/.test(p))
    return m === "GET" ? "finance.view" : "finance.valuation";
  if (/^\/expenses(?:\/|$)/.test(p))
    return m === "GET"
      ? "finance.view"
      : /\/decision$/.test(p)
        ? "expense.approve"
        : /\/payments$/.test(p)
          ? "expense.pay"
          : "expense.request";
  if (/^\/event-config(?:\/|$)/.test(p)) return "events.configure";
  if (/^\/events(?:\/|$)/.test(p))
    return m === "GET" ? "events.view" : "events.manage";
  if (/^\/(?:reservations|waitlist)(?:\/|$)/.test(p))
    return "reservations.manage";
  if (p === "/manual-orders") return "orders.manual";
  if (/^\/cash-drawer(?:\/|$)/.test(p)) return "cash.manage";
  if (/^\/service-requests(?:\/|$)/.test(p)) return "floor.manage";
  if (/^\/availability(?:\/|$)/.test(p)) return "availability.manage";
  if (/^\/menu(?:\/|$)/.test(p))
    return /\/availability$/.test(p) ? "availability.manage" : "menu.manage";
  if (/^\/reports(?:\/|\.|$)/.test(p)) return "reports.view";
  if (/^\/audit(?:\/|$)/.test(p)) return "audit.view";
  if (/^\/backup(?:s|-cloud)(?:\/|$)/.test(p)) return "backups.manage";
  if (/^\/notifications(?:\/|$)/.test(p)) return "notifications.manage";
  if (/^\/online-payments(?:\/|$)/.test(p)) return "billing.manage";
  if (
    /^\/(?:settings|invoices|invoice-settings|gateway|coupons)(?:\/|$)/.test(p)
  )
    return "settings.manage";
  if (/^\/operations-alerts(?:\/|$)/.test(p))
    return /\/(?:settings|deliveries)(?:\/|$)/.test(p)
      ? "alerts.configure"
      : "alerts.view";
  if (/^\/printing(?:\/|$)/.test(p)) {
    if (/\/routing$/.test(p)) return "printing.configure";
    if (/\/settings$/.test(p)) return "printing.configure";
    if (/\/receipts\//.test(p)) return "printing.receipt";
    return null;
  }
  if (/^\/couriers?(?:\/|$)/.test(p))
    return /\/confirm-delivery$/.test(p) ? "courier.confirm" : "courier.manage";
  if (/^\/fulfillments?(?:\/|$)/.test(p)) {
    if (p === "/fulfillment/settings") return "settings.manage";
    if (m === "GET") return "orders.view";
    if (b.action === "accept" || b.action === "cancel") return "orders.send";
    if (["prepare", "ready"].includes(b.action)) return "orders.prepare";
    if (["dispatch", "deliver", "collect"].includes(b.action))
      return "courier.confirm";
    return "orders.view";
  }
  return null;
}
export function enforcePermissions(req, res, next) {
  const required = routePermission(req);
  if (required && !hasPermission(req.staff, required))
    throw new HttpError(
      403,
      req.staff.access?.denied?.includes(required)
        ? "PERMISSION_DENIED"
        : "FORBIDDEN",
      "Your account does not have permission for this action.",
    );
  next();
}
