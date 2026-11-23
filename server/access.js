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
  ["branches.manage", "Create / edit restaurant branches", ["admin"]],
  ["reviews.manage", "Moderate guest reviews", ["admin"]],
);
export const permissionKeys = permissionCatalog.map(([key]) => key);
export const memberBranches = (user) =>
  Array.isArray(user?.branchIds) ? user.branchIds : ["main"];
export const isPlatformAdmin = (user) =>
  Boolean(
    user?.active !== false &&
    user?.role === "admin" &&
    memberBranches(user).includes("main"),
  );
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
export function assertManageStaff(actor, target, branch = "main") {
  if (
    !isPlatformAdmin(actor) &&
    (target.role === "admin" ||
      memberBranches(target).length !== 1 ||
      !memberBranches(target).includes(branch))
  )
    throw new HttpError(
      403,
      "STAFF_SCOPE",
      "A main-branch administrator manages administrators and accounts shared with other branches.",
    );
  const denied = actor.access?.denied || [];
  if (denied.some((key) => hasPermission(target, key)))
    throw new HttpError(
      403,
      "STAFF_PRIVILEGE",
      "This account has broader action access. Ask an unrestricted main-branch administrator to manage it.",
    );
  const actions = {
    refundApproval: "refund.approve",
    purchaseApproval: "purchase.approve",
    purchasePayment: "purchase.pay",
    expenseApproval: "expense.approve",
  };
  for (const [key, permission] of Object.entries(actions)) {
    const limit = actor.access?.limitsMinor?.[key],
      targetLimit = target.access?.limitsMinor?.[key];
    if (
      limit !== undefined &&
      limit !== null &&
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
  const current = await store.staff.findOneAndUpdate(
    { _id: actor._id, active: true },
    { $inc: { approvalRevision: 1 } },
    { session, returnDocument: "after" },
  );
  if (
    !current ||
    (current.authVersion || 0) !== (actor.authVersion || 0) ||
    !hasBranchAccess(current, store.branchId || "main")
  )
    throw new HttpError(
      401,
      "STAFF_REQUIRED",
      "Your access changed. Sign in again.",
    );
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
  if (
    ["/me", "/password", "/access-catalog"].includes(p) ||
    /^\/mfa(?:\/|$)/.test(p)
  )
    return p === "/access-catalog" ? "staff.manage" : null;
  if (/^\/(?:reviews|review-media)(?:\/|$)/.test(p)) return "reviews.manage";
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
