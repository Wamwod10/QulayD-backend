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
const login = await api.post("/api/v1/auth/login").send({ identifier: "owner", password: "Password1", deviceId: "e2e-login-device" });
assert.equal(login.status, 200, JSON.stringify(login.body));
let token = login.body.data.accessToken;
const refreshCookie = login.headers["set-cookie"];
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

const priceList = await auth(api.post("/api/v1/pricing")).send({ name: "E2E Retail", code: "E2E_RETAIL", currency: "UZS", isDefault: true, status: "ACTIVE" });
assert.equal(priceList.status, 201, JSON.stringify(priceList.body));
const priceListId = priceList.body.data.id;

const product = await auth(api.post("/api/v1/catalog/products")).set("Idempotency-Key", "e2e-product").send({
  name: "E2E Product", unitId, sku: "SKU-E2E-123456", barcodes: [{ barcode: "4780000000001", isPrimary: true }], costPrice: 3,
  primaryPriceListId: priceListId, prices: [{ priceListId, price: 5 }],
  openingStock: [{ warehouseId, onHand: 10 }],
});
assert.equal(product.status, 201, JSON.stringify(product.body));
assert.equal(product.body.data.sku, "SKU-E2E-123456");

const customer = await auth(api.post("/api/v1/customers")).send({ code: "E2E", name: "E2E Customer", creditLimit: 100 });
assert.equal(customer.status, 201, JSON.stringify(customer.body));

const order = await auth(api.post("/api/v1/orders")).send({
  warehouseId, customerId: customer.body.data.id, priceListId, items: [{ productId: product.body.data.id, quantity: 1, unitPrice: 5 }],
});
assert.equal(order.status, 201, JSON.stringify(order.body));
const orderDetail = await auth(api.get(`/api/v1/orders/${order.body.data.id}`));
const orderList = await auth(api.get("/api/v1/orders?limit=100"));
for (const response of [orderDetail, orderList]) assert.equal(response.status, 200, JSON.stringify(response.body));
assert.ok(orderList.body.data.some((item) => item.id === order.body.data.id));

const confirmedOrder = await auth(api.post(`/api/v1/orders/${order.body.data.id}/confirm`)).send({});
assert.equal(confirmedOrder.status, 200, JSON.stringify(confirmedOrder.body));
assert.equal(confirmedOrder.body.data.fulfillmentStatus, "RESERVED");
const reservations = await auth(api.get("/api/v1/inventory/reservations?limit=100"));
assert.equal(reservations.status, 200, JSON.stringify(reservations.body));
assert.ok(reservations.body.data.some((row) => row.orderId === order.body.data.id && row.status === "ACTIVE" && Number(row.quantity) === 1));

const pickingStarted = await auth(api.post(`/api/v1/orders/${order.body.data.id}/picking/start`)).send({});
assert.equal(pickingStarted.status, 200, JSON.stringify(pickingStarted.body));
const pickLists = await auth(api.get("/api/v1/fulfillment/pick-lists"));
assert.equal(pickLists.status, 200, JSON.stringify(pickLists.body));
const pickList = pickLists.body.data.find((row) => row.orderId === order.body.data.id);
assert.ok(pickList?.items?.length, JSON.stringify(pickLists.body));
const pickedLine = await auth(api.patch(`/api/v1/fulfillment/pick-lists/${pickList.id}/items/${pickList.items[0].id}`)).send({ pickedQuantity: 1, shortageQuantity: 0 });
assert.equal(pickedLine.status, 200, JSON.stringify(pickedLine.body));
for (const transition of ["picking/complete", "packing/complete", "ready"]) {
  const result = await auth(api.post(`/api/v1/orders/${order.body.data.id}/${transition}`)).send({});
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

const trip = await auth(api.post("/api/v1/delivery/trips")).send({ warehouseId, orderIds: [order.body.data.id], vehicle: "E2E Vehicle" });
assert.equal(trip.status, 201, JSON.stringify(trip.body));
const tripStarted = await auth(api.post(`/api/v1/delivery/trips/${trip.body.data.id}/start`)).send({});
assert.equal(tripStarted.status, 200, JSON.stringify(tripStarted.body));
const deliveryId = tripStarted.body.data.deliveries[0].id;
const arrived = await auth(api.post(`/api/v1/delivery/deliveries/${deliveryId}/arrive`)).send({ latitude: 41.2995, longitude: 69.2401 });
assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
const delivered = await auth(api.post(`/api/v1/delivery/deliveries/${deliveryId}/complete`)).send({ recipientName: "E2E Customer", latitude: 41.2995, longitude: 69.2401 });
assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
assert.ok(delivered.body.meta.invoiceId);

const orderPayment = await auth(api.post("/api/v1/payments")).send({
  customerId: customer.body.data.id, orderId: order.body.data.id, method: "BANK", amount: 5,
  allocations: [{ invoiceId: delivered.body.meta.invoiceId, amount: 5 }],
});
assert.equal(orderPayment.status, 201, JSON.stringify(orderPayment.body));
const confirmedOrderPayment = await auth(api.post(`/api/v1/payments/${orderPayment.body.data.id}/confirm`)).send({});
assert.equal(confirmedOrderPayment.status, 200, JSON.stringify(confirmedOrderPayment.body));
const tripCompleted = await auth(api.post(`/api/v1/delivery/trips/${trip.body.data.id}/complete`)).send({});
assert.equal(tripCompleted.status, 200, JSON.stringify(tripCompleted.body));

const shift = await auth(api.post("/api/v1/pos/shifts/open")).send({ cashboxId, openingBalance: 0 });
assert.equal(shift.status, 201, JSON.stringify(shift.body));
const sale = await auth(api.post("/api/v1/pos/sales")).set("Idempotency-Key", "e2e-sale").send({
  warehouseId, customerId: customer.body.data.id, shiftId: shift.body.data.id, priceListId,
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
assert.equal(Number(stocks.body.data.find((row) => row.productId === product.body.data.id).onHand), 7);
const dashboard = await auth(api.get("/api/v1/dashboard"));
const ledger = await auth(api.get("/api/v1/finance?limit=100"));
const reports = await Promise.all(["sales", "inventory", "debt", "delivery"].map((name) => auth(api.get(`/api/v1/reports/${name}`))));
for (const response of [dashboard, ledger, ...reports]) assert.equal(response.status, 200, JSON.stringify(response.body));
assert.ok(Number(dashboard.body.data.todayOrders) >= 1);
const debit = ledger.body.data.filter((row) => row.side === "DEBIT").reduce((sum, row) => sum + Number(row.amount), 0);
const credit = ledger.body.data.filter((row) => row.side === "CREDIT").reduce((sum, row) => sum + Number(row.amount), 0);
assert.equal(debit, credit);

const replay = await auth(api.post("/api/v1/pos/sales")).set("Idempotency-Key", "e2e-sale").send({
  warehouseId, customerId: customer.body.data.id, shiftId: shift.body.data.id, priceListId,
  items: [{ productId: product.body.data.id, quantity: 2, unitPrice: 5 }], payments: [{ method: "CASH", amount: 10 }],
});
assert.equal(replay.status, 201, JSON.stringify(replay.body));
assert.equal(replay.body.data.order.id, sale.body.data.order.id);

const logout = await auth(api.post("/api/v1/auth/logout")).send({});
assert.equal(logout.status, 200, JSON.stringify(logout.body));
const revoked = await auth(api.get("/api/v1/auth/me"));
assert.equal(revoked.status, 401, JSON.stringify(revoked.body));

console.log(JSON.stringify({ status: "passed", registerLoginRefresh: true, priceList: true, productOpeningStock: true, customer: true, orderReservation: true, fulfillment: true, delivery: true, payment: true, ledgerReports: true, dashboard: true, logoutRevoked: true }));
await disconnectDatabase();
