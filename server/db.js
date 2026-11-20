import { MongoClient } from "mongodb";

export async function connectDatabase(config) {
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 6000,
  });
  try {
    await client.connect();
    const db = client.db(config.mongoDatabase);
    const collections = {
      dishes: db.collection("dishes"),
      tables: db.collection("tables"),
      orders: db.collection("orders"),
      reviews: db.collection("reviews"),
      staff: db.collection("staff"),
      sessions: db.collection("staffSessions"),
      settings: db.collection("settings"),
      backupJobs: db.collection("backupJobs"),
      runtimeLeases: db.collection("runtimeLeases"),
      notificationPreferences: db.collection("notificationPreferences"),
      notificationJobs: db.collection("notificationJobs"),
      notificationsInbox: db.collection("notificationsInbox"),
      pushSubscriptions: db.collection("pushSubscriptions"),
      phoneChallenges: db.collection("phoneChallenges"),
      phoneSendLimits: db.collection("phoneSendLimits"),
      fulfillments: db.collection("fulfillments"),
      bills: db.collection("bills"),
      audit: db.collection("auditLog"),
      events: db.collection("events"),
      eventLocks: db.collection("eventLocks"),
      serviceRequests: db.collection("serviceRequests"),
      customers: db.collection("customers"),
      accountTokens: db.collection("accountTokens"),
      refunds: db.collection("refunds"),
      ingredients: db.collection("ingredients"),
      recipes: db.collection("recipes"),
      stockMovements: db.collection("stockMovements"),
      customerSessions: db.collection("customerSessions"),
      coupons: db.collection("coupons"),
      couponRedemptions: db.collection("couponRedemptions"),
      loyaltyLedger: db.collection("loyaltyLedger"),
      gatewayTransactions: db.collection("gatewayTransactions"),
      reservations: db.collection("reservations"),
      waitlist: db.collection("waitlist"),
    };
    const { dishes, tables, orders, reviews, staff, sessions } = collections;
    await Promise.all([
      dishes.createIndex({ position: 1 }),
      tables.createIndexes([
        { key: { number: 1 }, unique: true },
        { key: { qrToken: 1 }, unique: true },
      ]),
      orders.createIndexes([
        { key: { code: 1 }, unique: true },
        { key: { guestHash: 1, requestKey: 1 }, unique: true },
        { key: { guestHash: 1, createdAt: -1 } },
        { key: { tableId: 1, visitId: 1, status: 1 } },
        { key: { status: 1, updatedAt: -1 } },
        { key: { updatedAt: -1 } },
      ]),
      reviews.createIndexes([
        { key: { orderId: 1, dishId: 1 }, unique: true },
        { key: { status: 1, dishId: 1, createdAt: -1 } },
        { key: { status: 1, createdAt: -1 } },
      ]),
      staff.createIndex({ username: 1 }, { unique: true }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      collections.bills.createIndexes([
        { key: { visitId: 1 }, unique: true },
        { key: { receiptNo: 1 }, unique: true },
        { key: { status: 1, paidAt: -1 } },
      ]),
      collections.events.createIndexes([
        { key: { guestHash: 1, requestKey: 1 }, unique: true },
        { key: { guestHash: 1, createdAt: -1 } },
        { key: { status: 1, startsAt: 1, blockedUntil: 1 } },
      ]),
      collections.serviceRequests.createIndex(
        { tableId: 1, visitId: 1, type: 1 },
        {
          unique: true,
          partialFilterExpression: { status: "open" },
          name: "one_open_request_per_type",
        },
      ),
    ]);
    await Promise.all([
      collections.customers.createIndex({ email: 1 }, { unique: true }),
      collections.backupJobs.createIndex({ status: 1, createdAt: 1 }),
      collections.notificationPreferences.createIndex({ lastScannedAt: 1 }),
      collections.notificationJobs.createIndex({ status: 1, dueAt: 1 }),
      collections.notificationJobs.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      collections.notificationsInbox.createIndex({
        actorKey: 1,
        createdAt: -1,
      }),
      collections.notificationsInbox.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      collections.pushSubscriptions.createIndex({ actorKey: 1 }),
      collections.phoneChallenges.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      collections.phoneSendLimits.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      collections.fulfillments.createIndex({ code: 1 }, { unique: true }),
      collections.fulfillments.createIndex(
        { guestHash: 1, requestKey: 1 },
        { unique: true },
      ),
      collections.fulfillments.createIndex({ customerId: 1, createdAt: -1 }),
      collections.fulfillments.createIndex({ status: 1, createdAt: 1 }),
      collections.accountTokens.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      collections.accountTokens.createIndex({ customerId: 1, purpose: 1 }),
      collections.refunds.createIndex({ clientKey: 1 }, { unique: true }),
      collections.refunds.createIndex({ billId: 1, status: 1 }),
      collections.refunds.createIndex(
        { mode: 1, merchantKey: 1, providerReference: 1 },
        {
          unique: true,
          partialFilterExpression: { providerReference: { $type: "string" } },
        },
      ),
      collections.refunds.createIndex({ refundedAt: -1 }),
      collections.refunds.createIndex({ source: 1, sourceId: 1, status: 1 }),
      collections.ingredients.createIndex({ nameKey: 1 }, { unique: true }),
      collections.stockMovements.createIndex({ key: 1 }, { unique: true }),
      collections.stockMovements.createIndex({ ingredientId: 1, at: -1 }),
      collections.stockMovements.createIndex({ at: -1 }),
      collections.customerSessions.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      collections.customerSessions.createIndex({ customerId: 1 }),
      orders.createIndex({ customerId: 1, createdAt: -1, _id: -1 }),
      collections.couponRedemptions.createIndex({
        couponCode: 1,
        customerId: 1,
      }),
      collections.loyaltyLedger.createIndex({ key: 1 }, { unique: true }),
      collections.loyaltyLedger.createIndex({ customerId: 1, at: -1 }),
      collections.gatewayTransactions.createIndex(
        { clientKey: 1 },
        { unique: true },
      ),
      collections.gatewayTransactions.createIndex(
        { mode: 1, merchantKey: 1, bankTransactionId: 1 },
        {
          unique: true,
          name: "merchant_bank_payment_unique",
          partialFilterExpression: { bankTransactionId: { $type: "string" } },
        },
      ),
      collections.gatewayTransactions.createIndex({ billId: 1, createdAt: -1 }),
      collections.gatewayTransactions.createIndex({ status: 1, createdAt: -1 }),
      collections.reservations.createIndex({ code: 1 }, { unique: true }),
      collections.reservations.createIndex({ startsAt: 1, status: 1 }),
      collections.reservations.createIndex({
        tableId: 1,
        startsAt: 1,
        endsAt: 1,
        status: 1,
      }),
      collections.reservations.createIndex(
        { actorKey: 1, requestKey: 1 },
        { unique: true },
      ),
      collections.waitlist.createIndex(
        { actorKey: 1 },
        { unique: true, partialFilterExpression: { active: true } },
      ),
      collections.waitlist.createIndex({ active: 1, createdAt: 1 }),
    ]);
    return { client, db, ...collections };
  } catch (error) {
    await client.close();
    throw error;
  }
}
