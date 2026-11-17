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
      bills: db.collection("bills"),
      audit: db.collection("auditLog"),
      events: db.collection("events"),
      eventLocks: db.collection("eventLocks"),
      serviceRequests: db.collection("serviceRequests"),
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
    return { client, db, ...collections };
  } catch (error) {
    await client.close();
    throw error;
  }
}
