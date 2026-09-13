import assert from "node:assert/strict";
import fs from "node:fs/promises";
import pg from "pg";
import request from "supertest";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString });
await client.connect();
await client.query(await fs.readFile(new URL("../prisma/migrations/20260911000100_initial/migration.sql", import.meta.url), "utf8"));
await client.end();

const [{ createApp }, { getPrisma, disconnectDatabase }, { ensurePermissionCatalog }] = await Promise.all([
  import("../src/app.js"), import("../src/database/index.js"), import("../src/modules/access-control/access-control.bootstrap.js"),
]);
const prisma = getPrisma();
await ensurePermissionCatalog(prisma);
const api = request(createApp({ prisma }));

const registration = await api.post("/api/v1/auth/register-owner").send({
  companyName: "Qulay E2E", name: "Owner", login: "owner", password: "Password1", deviceId: "e2e-device",
});
assert.equal(registration.status, 201, JSON.stringify(registration.body));
const token = registration.body.data.accessToken;
const auth = (operation) => operation.set("Authorization", `Bearer ${token}`);

const warehouses = await auth(api.get("/api/v1/inventory/warehouses"));
const units = await auth(api.get("/api/v1/catalog/units"));
const cashboxes = await auth(api.get("/api/v1/pos/cashboxes"));
for (const response of [warehouses, units, cashboxes]) assert.equal(response.status, 200, JSON.stringify(response.body));
const warehouseId = warehouses.body.data[0].id; const unitId = units.body.data[0].id; const cashboxId = cashboxes.body.data[0].id;

const product = await auth(api.post("/api/v1/catalog/products")).set("Idempotency-Key", "e2e-product").send({
  name: "E2E Product", unitId, barcodes: [{ barcode: "4780000000001", isPrimary: true }], costPrice: 3,
  openingStock: [{ warehouseId, onHand: 10 }],
});
assert.equal(product.status, 201, JSON.stringify(product.body));
assert.match(product.body.data.sku, /^\d{5}$/);

const customer = await auth(api.post("/api/v1/customers")).send({ code: "E2E", name: "E2E Customer", creditLimit: 100 });
assert.equal(customer.status, 201, JSON.stringify(customer.body));
const shift = await auth(api.post("/api/v1/pos/shifts/open")).send({ cashboxId, openingBalance: 0 });
assert.equal(shift.status, 201, JSON.stringify(shift.body));

const sale = await auth(api.post("/api/v1/pos/sales")).set("Idempotency-Key", "e2e-sale").send({
  warehouseId, customerId: customer.body.data.id, shiftId: shift.body.data.id,
  items: [{ productId: product.body.data.id, quantity: 2, unitPrice: 5 }], payments: [{ method: "CASH", amount: 10 }],
});
assert.equal(sale.status, 201, JSON.stringify(sale.body));
const receipt = await auth(api.get(`/api/v1/pos/receipts/${sale.body.data.receipt.id}`));
assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

const stocks = await auth(api.get(`/api/v1/inventory/stocks?warehouseId=${warehouseId}`));
assert.equal(stocks.status, 200, JSON.stringify(stocks.body));
assert.equal(Number(stocks.body.data.find((row) => row.productId === product.body.data.id).onHand), 8);
const ledger = await auth(api.get("/api/v1/finance?limit=100"));
assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
const debit = ledger.body.data.filter((row) => row.side === "DEBIT").reduce((sum, row) => sum + Number(row.amount), 0);
const credit = ledger.body.data.filter((row) => row.side === "CREDIT").reduce((sum, row) => sum + Number(row.amount), 0);
assert.equal(debit, credit);

const replay = await auth(api.post("/api/v1/pos/sales")).set("Idempotency-Key", "e2e-sale").send({
  warehouseId, customerId: customer.body.data.id, shiftId: shift.body.data.id,
  items: [{ productId: product.body.data.id, quantity: 2, unitPrice: 5 }], payments: [{ method: "CASH", amount: 10 }],
});
assert.equal(replay.status, 201); assert.equal(replay.body.data.order.id, sale.body.data.order.id);

console.log(JSON.stringify({ status: "passed", sku: product.body.data.sku, stockAfterSale: 8, ledgerBalanced: true, idempotencyReplay: true }));
await disconnectDatabase();
