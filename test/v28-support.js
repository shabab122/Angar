import { ObjectId, MongoClient } from "mongodb";
import { post, ok, password, key } from "./support.js";
import { getBranchRuntime } from "../server/branches.js";
export const limits = {
  refundApproval: null,
  purchaseApproval: null,
  purchasePayment: null,
  expenseApproval: null,
};
export async function branch(t, f, id = "uttara") {
  ok(
    await post(f.staff.admin, "/api/branches", {
      id,
      name: "Branch " + id,
      address: "Dhaka " + id,
      copyMenu: true,
      tables: 2,
      currentPassword: password,
      requestKey: key(),
    }),
    201,
  );
  const child = await getBranchRuntime(f.store, f.config).get(id);
  t.after(async () => {
    const client = await new MongoClient(f.config.mongoUri).connect();
    try {
      await client.db(child.store.db.databaseName).dropDatabase();
    } finally {
      await client.close();
    }
  });
  return child;
}
export async function ingredient(
  store,
  {
    stock = 0,
    value = 0,
    tracked = false,
    unit = "g",
    complete = true,
    name = "Transfer rice",
  } = {},
) {
  const row = {
    _id: new ObjectId(),
    name,
    unit,
    stock,
    reorderLevel: 10,
    batchTracked: tracked,
    inventoryValueMinor: value,
    costComplete: complete,
    revision: 0,
    createdAt: new Date(),
  };
  await store.ingredients.insertOne(row);
  return row;
}
export async function createTransfer(
  client,
  to,
  source,
  target,
  quantity = 100,
) {
  return ok(
    await post(client, "/api/staff/stock-transfers", {
      toBranch: to,
      lines: [
        {
          sourceIngredientId: String(source._id),
          targetIngredientId: String(target._id),
          quantity,
        },
      ],
      reason: "Counted goods for second branch",
      requestKey: key(),
    }),
    201,
  ).transfer;
}
export async function action(client, row, type) {
  return ok(
    await post(client, "/api/staff/stock-transfers/" + row.id + "/action", {
      action: type,
      expectedRevision: row.revision,
      verified: true,
      reason: "Goods and approvals checked",
    }),
  ).transfer;
}
export async function receive(
  client,
  row,
  quantity,
  lotKey = "bulk",
  extra = {},
) {
  return post(client, "/api/staff/stock-transfers/" + row.id + "/receive", {
    expectedRevision: row.revision,
    requestKey: key(),
    verified: true,
    reason: "Actual destination goods counted",
    items: [{ lineIndex: 0, lotKey, quantity }],
    ...extra,
  });
}
