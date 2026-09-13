import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import request from "supertest";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(scriptDirectory, "../prisma/migrations");
const client = new pg.Client({ connectionString });
await client.connect();
for (const entry of (await fs.readdir(migrationsDirectory, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const migration = path.join(migrationsDirectory, entry.name, "migration.sql");
  try { await client.query(await fs.readFile(migration, "utf8")); } catch (error) {
    if (error.code !== "42701" && error.code !== "42P07" && error.code !== "42710") throw error;
  }
}
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
assert.match(registration.headers["set-cookie"]?.[0] || "", /HttpOnly/);
let token = registration.body.data.accessToken;
let refreshCookie = registration.headers["set-cookie"];
const auth = (operation) => operation.set("Authorization", `Bearer ${token}`);

const me = await auth(api.get("/api/v1/auth/me"));
assert.equal(me.status, 200, JSON.stringify(me.body));
assert.equal(me.body.data.login, "owner");
const refreshed = await api.post("/api/v1/auth/refresh").set("Cookie", refreshCookie).send({});
assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
token = refreshed.body.data.accessToken;

const company = await auth(api.get("/api/v1/companies/current"));
const branches = await auth(api.get("/api/v1/branches"));
for (const response of [company, branches]) assert.equal(response.status, 200, JSON.stringify(response.body));
const branch = await auth(api.post("/api/v1/branches")).send({ name: "E2E Branch", code: "E2E" });
assert.equal(branch.status, 201, JSON.stringify(branch.body));

const warehouses = await auth(api.get("/api/v1/inventory/warehouses"));
const units = await auth(api.get("/api/v1/catalog/units"));
const cashboxes = await auth(api.get("/api/v1/pos/cashboxes"));
for (const response of [warehouses, units, cashboxes]) assert.equal(response.status, 200, JSON.stringify(response.body));
const warehouseId = warehouses.body.data[0].id;
const unitId = units.body.data[0].id;
const cashboxId = cashboxes.body.data[0].id;

const product = await auth(api.post("/api/v1/catalog/products")).set("Idempotency-Key", "e2e-product").send({
  name: "E2E Product", unitId, barcodes: [{ barcode: "4780000000001", isPrimary: true }], costPrice: 3,
  openingStock: [{ warehouseId, onHand: 10 }],
});
assert.equal(product.status, 201, JSON.stringify(product.body));
assert.match(product.body.data.sku, /^\d{5}$/);

const customer = await auth(api.post("/api/v1/customers")).send({ code: "E2E", name: "E2E Customer", creditLimit: 100 });
assert.equal(customer.status, 201, JSON.stringify(customer.body));

const order = await auth(api.post("/api/v1/orders")).send({
  warehouseId, customerId: customer.body.data.id, items: [{ productId: product.body.data.id, quantity: 1, unitPrice: 5 }],
});
assert.equal(order.status, 201, JSON.stringify(order.body));
const orderDetail = await auth(api.get(`/api/v1/orders/${order.body.data.id}`));
const orderList = await auth(api.get("/api/v1/orders?limit=100"));
for (const response of [orderDetail, orderList]) assert.equal(response.status, 200, JSON.stringify(response.body));
assert.ok(orderList.body.data.some((item) => item.id === order.body.data.id));

const shift = await auth(api.post("/api/v1/pos/shifts/open")).send({ cashboxId, openingBalance: 0 });
assert.equal(shift.status, 201, JSON.stringify(shift.body));
const sale = await auth(api.post("/api/v1/pos/sales")).set("Idempotency-Key", "e2e-sale").send({
  warehouseId, customerId: customer.body.data.id, shiftId: shift.body.data.id,
  items: [{ productId: product.body.data.id, quantity: 2, unitPrice: 5 }], payments: [{ method: "CASH", amount: 10 }],
});
assert.equal(sale.status, 201, JSON.stringify(sale.body));
const receipt = await auth(api.get(`/api/v1/pos/receipts/${sale.body.data.receipt.id}`));
assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

const invoice = await auth(api.post("/api/v1/invoices")).send({
  customerId: customer.body.data.id, items: [{ description: "E2E service", quantity: 1, unitPrice: 7 }],
});
assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
const issuedInvoice = await auth(api.post(`/api/v1/invoices/${invoice.body.data.id}/issue`).send({}));
assert.equal(issuedInvoice.status, 200, JSON.stringify(issuedInvoice.body));
const payment = await auth(api.post("/api/v1/payments")).send({
  customerId: customer.body.data.id, shiftId: shift.body.data.id, method: "CASH", amount: 7,
  allocations: [{ invoiceId: invoice.body.data.id, amount: 7 }],
});
assert.equal(payment.status, 201, JSON.stringify(payment.body));
const confirmedPayment = await auth(api.post(`/api/v1/payments/${payment.body.data.id}/confirm`).send({}));
assert.equal(confirmedPayment.status, 200, JSON.stringify(confirmedPayment.body));

const stocks = await auth(api.get(`/api/v1/inventory/stocks?warehouseId=${warehouseId}`));
assert.equal(stocks.status, 200, JSON.stringify(stocks.body));
assert.equal(Number(stocks.body.data.find((row) => row.productId === product.body.data.id).onHand), 8);
const dashboard = await auth(api.get("/api/v1/dashboard"));
const ledger = await auth(api.get("/api/v1/finance?limit=100"));
for (const response of [dashboard, ledger]) assert.equal(response.status, 200, JSON.stringify(response.body));
assert.ok(Number(dashboard.body.data.todayOrders) >= 1);
const debit = ledger.body.data.filter((row) => row.side === "DEBIT").reduce((sum, row) => sum + Number(row.amount), 0);
const credit = ledger.body.data.filter((row) => row.side === "CREDIT").reduce((sum, row) => sum + Number(row.amount), 0);
assert.equal(debit, credit);

const replay = await auth(api.post("/api/v1/pos/sales")).set("Idempotency-Key", "e2e-sale").send({
  warehouseId, customerId: customer.body.data.id, shiftId: shift.body.data.id,
  items: [{ productId: product.body.data.id, quantity: 2, unitPrice: 5 }], payments: [{ method: "CASH", amount: 10 }],
});
assert.equal(replay.status, 201, JSON.stringify(replay.body));
assert.equal(replay.body.data.order.id, sale.body.data.order.id);

const logout = await auth(api.post("/api/v1/auth/logout")).send({});
assert.equal(logout.status, 200, JSON.stringify(logout.body));
const revoked = await auth(api.get("/api/v1/auth/me"));
assert.equal(revoked.status, 401, JSON.stringify(revoked.body));

console.log(JSON.stringify({ status: "passed", refresh: true, product: true, customer: true, order: true, payment: true, dashboard: true, logoutRevoked: true }));
await disconnectDatabase();
