import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { changeStock } from "../inventory/balances/balance.service.js";
import { issueInvoiceInTransaction } from "../invoicing/invoice.service.js";
import { confirmPaymentInTransaction, createPaymentInTransaction } from "../payments/payment.service.js";
import { deliveryPaymentSchema, deliveryProofSchema, failedDeliverySchema, partialDeliverySchema } from "./deliveries/delivery.validation.js";
import { tripCreateSchema } from "./trips/trip.validation.js";

const params = z.object({ id: z.uuid() });
const EPSILON = 0.01;
const tripInclude = {
  driver: { select: { id: true, name: true, phone: true, title: true } },
  deliveries: { include: { customer: true, order: true } },
};
const orderDeliveryInclude = {
  customer: true,
  reservations: true,
  invoices: true,
  payments: { where: { status: { in: ["PENDING", "CONFIRMED"] } } },
  items: { include: { product: true, variant: true, package: true } },
  pickLists: {
    where: { status: "COMPLETED" },
    orderBy: { pickedAt: "desc" },
    take: 1,
    include: { items: true },
  },
};

function roundQty(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000; }
function roundMoney(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }
function isPrivileged(request) { return (request.auth?.user?.roles || []).some((role) => ["OWNER", "ADMIN"].includes(role)); }
function invoiceOutstanding(invoice) { return Math.max(0, Number(invoice.total || 0) - Number(invoice.credited || 0) - Number(invoice.paid || 0)); }

async function companySettings(tx, companyId) {
  return (await tx.settings.findUnique({ where: { companyId }, select: { data: true } }))?.data || {};
}

function assertProof(settings, proof) {
  const policy = settings?.delivery || {};
  if (policy.requireRecipientName === true && !proof.recipientName?.trim()) throw new ValidationError("Qabul qiluvchi ismi majburiy");
  if (policy.requirePhoto === true && !proof.photoUrl?.trim()) throw new ValidationError("Yetkazilganini tasdiqlovchi foto majburiy");
  if (policy.requireGps === true && (proof.latitude == null || proof.longitude == null)) throw new ValidationError("Yetkazish GPS joylashuvi majburiy");
}

function assertFailureReason(settings, reason) {
  if (settings?.delivery?.requireFailureReason !== false && !reason?.trim()) throw new ValidationError("Yetkazilmagan sababni kiriting");
}

function assertDeliveryActor(request, delivery) {
  if (isPrivileged(request)) return;
  if (!delivery.trip?.driverEmployeeId || delivery.trip.driverEmployeeId !== request.auth.employeeId) {
    throw new AuthorizationError("Bu yetkazib berish boshqa haydovchiga biriktirilgan");
  }
}

function remainingPickedAllocations(pickLine, orderItem) {
  const picked = Array.isArray(pickLine?.batchAllocations) ? pickLine.batchAllocations : [];
  const consumed = Array.isArray(orderItem?.batchAllocations) ? orderItem.batchAllocations : [];
  const consumedByBatch = new Map();
  for (const row of consumed) {
    if (!row?.batchId) continue;
    consumedByBatch.set(row.batchId, roundQty((consumedByBatch.get(row.batchId) || 0) + Number(row.quantity || 0)));
  }
  return picked.map((row) => ({
    batchId: row.batchId,
    quantity: roundQty(Math.max(0, Number(row.quantity || 0) - Number(consumedByBatch.get(row.batchId) || 0))),
  })).filter((row) => row.batchId && row.quantity > 0);
}

function mergeBatchAllocations(existing, added) {
  const grouped = new Map();
  for (const row of [...(Array.isArray(existing) ? existing : []), ...added]) {
    if (!row?.batchId) continue;
    grouped.set(row.batchId, roundQty((grouped.get(row.batchId) || 0) + Number(row.quantity || 0)));
  }
  return [...grouped.entries()].map(([batchId, quantity]) => ({ batchId, quantity }));
}

async function consumePickedBatches(tx, { companyId, order, orderItem, reservation, pickLine, baseQuantity, serials }) {
  const product = orderItem.product;
  if (!product.trackLot && !product.trackExpiry) return [];
  const requiredByBatch = new Map();

  if (product.trackSerial) {
    for (const serial of serials) {
      if (!serial.batchId) throw new ConflictError("Tanlangan serial / IMEI lot/batch bilan bog‘lanmagan", { orderItemId: orderItem.id, serialId: serial.id });
      requiredByBatch.set(serial.batchId, roundQty((requiredByBatch.get(serial.batchId) || 0) + 1));
    }
  } else {
    let remaining = Number(baseQuantity);
    for (const allocation of remainingPickedAllocations(pickLine, orderItem)) {
      if (remaining <= 1e-9) break;
      const used = Math.min(remaining, Number(allocation.quantity));
      if (used > 0) requiredByBatch.set(allocation.batchId, roundQty(used));
      remaining = roundQty(remaining - used);
    }
    if (remaining > 1e-9) throw new ConflictError("Yig‘ilgan lot/batch miqdori yetkazish uchun yetarli emas", { orderItemId: orderItem.id, remaining });
  }

  const allocations = [];
  for (const [batchId, quantity] of requiredByBatch) {
    const where = {
      id: batchId,
      companyId,
      warehouseId: reservation.warehouseId,
      productId: reservation.productId,
      variantId: reservation.variantId || null,
    };
    if (product.trackExpiry) where.expiresAt = { gt: new Date() };
    const batch = await tx.productBatch.findFirst({ where });
    if (!batch || Number(batch.quantity) + 1e-9 < quantity || Number(batch.reserved) + 1e-9 < quantity) {
      throw new ConflictError("Yig‘ilgan lot/batch qoldig‘i o‘zgargan", {
        orderItemId: orderItem.id,
        batchId,
        required: quantity,
        quantity: Number(batch?.quantity || 0),
        reserved: Number(batch?.reserved || 0),
      });
    }
    await tx.productBatch.update({
      where: { id: batch.id },
      data: { quantity: { decrement: quantity }, reserved: { decrement: quantity } },
    });
    allocations.push({ batchId, quantity });
  }
  return allocations;
}

async function consumeReservation(tx, { companyId, employeeId, order, reservation, displayQuantity, pickLine }) {
  const orderItem = order.items.find((item) => item.id === reservation.orderItemId);
  if (!orderItem) throw new ConflictError("Yetkazish rezervi buyurtma qatoriga bog‘lanmagan", { reservationId: reservation.id });
  if (!pickLine) throw new ConflictError("Buyurtma qatori uchun yakunlangan yig‘ish ma’lumoti topilmadi", { orderItemId: orderItem.id });
  const conversion = Number(orderItem.conversionToBase || 1);
  const baseQuantity = roundQty(Number(displayQuantity) * conversion);
  if (baseQuantity <= 0 || baseQuantity > Number(reservation.quantity) + 1e-9) throw new ConflictError("Yetkazilgan miqdor rezervdan oshib ketdi");
  if (baseQuantity > Number(pickLine.pickedBaseQuantity) - Number(orderItem.fulfilledQty || 0) * conversion + 1e-9) {
    throw new ConflictError("Yetkazilayotgan miqdor real yig‘ilgan miqdordan oshib ketdi", { orderItemId: orderItem.id });
  }

  const product = orderItem.product;
  let serials = [];
  if (product.trackSerial) {
    if (!Number.isInteger(baseQuantity)) throw new ValidationError("Serial/IMEI mahsulot butun base birlikda yetkaziladi");
    const pickedIds = Array.isArray(pickLine.serialIds) ? pickLine.serialIds : [];
    const available = pickedIds.length ? await tx.productSerial.findMany({
      where: {
        id: { in: pickedIds }, companyId, productId: reservation.productId, warehouseId: reservation.warehouseId,
        variantId: reservation.variantId || null, soldOrderId: order.id, status: "RESERVED",
      },
      select: { id: true, batchId: true },
    }) : [];
    const byId = new Map(available.map((serial) => [serial.id, serial]));
    serials = pickedIds.map((id) => byId.get(id)).filter(Boolean).slice(0, baseQuantity);
    if (serials.length !== baseQuantity) throw new ConflictError("Yig‘ilgan serial / IMEI birliklari yetkazish uchun yetarli emas", { orderItemId: orderItem.id });
    const changed = await tx.productSerial.updateMany({
      where: { id: { in: serials.map((serial) => serial.id) }, companyId, soldOrderId: order.id, status: "RESERVED" },
      data: { status: "SOLD" },
    });
    if (changed.count !== baseQuantity) throw new ConflictError("Serial / IMEI holati parallel jarayonda o‘zgargan");
  }

  const batchAllocations = await consumePickedBatches(tx, { companyId, order, orderItem, reservation, pickLine, baseQuantity, serials });
  await changeStock(tx, {
    companyId,
    warehouseId: reservation.warehouseId,
    productId: reservation.productId,
    variantId: reservation.variantId,
    packageId: reservation.packageId,
    employeeId,
    quantity: -baseQuantity,
    reserved: -baseQuantity,
    allowNegative: false,
    type: "SALE",
    referenceType: "Delivery",
    referenceId: order.id,
  });
  const remains = roundQty(Number(reservation.quantity) - baseQuantity);
  await tx.stockReservation.update({ where: { id: reservation.id }, data: { quantity: remains, status: remains <= 1e-9 ? "CONSUMED" : "ACTIVE" } });
  await tx.orderItem.update({
    where: { id: orderItem.id },
    data: {
      fulfilledQty: { increment: Number(displayQuantity) },
      ...(batchAllocations.length ? { batchAllocations: mergeBatchAllocations(orderItem.batchAllocations, batchAllocations) } : {}),
    },
  });
  return { orderItemId: orderItem.id, quantity: Number(displayQuantity), baseQuantity, batchAllocations, serialIds: serials.map(({ id }) => id) };
}

function calculateInvoicePart(order, deliveredRows, finalEvent) {
  const itemById = new Map(order.items.map((item) => [item.id, item]));
  const rows = deliveredRows.map((row) => {
    const item = itemById.get(row.orderItemId);
    if (!item) throw new ConflictError("Invoice uchun buyurtma qatori topilmadi", { orderItemId: row.orderItemId });
    const quantity = Number(row.quantity);
    return {
      orderItem: item,
      quantity,
      gross: roundMoney(quantity * Number(item.unitPrice)),
    };
  });
  const subtotal = roundMoney(rows.reduce((sum, row) => sum + row.gross, 0));
  const previous = (order.invoices || []).filter((invoice) => invoice.status !== "VOID");
  const previousDiscount = roundMoney(previous.reduce((sum, invoice) => sum + Number(invoice.discount || 0), 0));
  const previousTax = roundMoney(previous.reduce((sum, invoice) => sum + Number(invoice.tax || 0), 0));
  const ratio = Number(order.subtotal) > EPSILON ? Math.min(1, subtotal / Number(order.subtotal)) : 0;
  const discount = finalEvent
    ? roundMoney(Math.max(0, Number(order.discount || 0) - previousDiscount))
    : roundMoney(Number(order.discount || 0) * ratio);
  const tax = finalEvent
    ? roundMoney(Math.max(0, Number(order.tax || 0) - previousTax))
    : roundMoney(Number(order.tax || 0) * ratio);
  const total = roundMoney(Math.max(0, subtotal - discount + tax));

  let taxAllocated = 0;
  const invoiceItems = rows.map((row, index) => {
    const rowTax = index === rows.length - 1
      ? roundMoney(tax - taxAllocated)
      : roundMoney(subtotal > EPSILON ? tax * (row.gross / subtotal) : 0);
    taxAllocated = roundMoney(taxAllocated + rowTax);
    return {
      description: [row.orderItem.productName || row.orderItem.product?.name || "Mahsulot", row.orderItem.variantName, row.orderItem.packageName].filter(Boolean).join(" · "),
      productId: row.orderItem.productId,
      variantName: row.orderItem.variantName,
      packageName: row.orderItem.packageName,
      baseQuantity: roundQty(row.quantity * Number(row.orderItem.conversionToBase || 1)),
      quantity: row.quantity,
      unitPrice: Number(row.orderItem.unitPrice),
      tax: rowTax,
      total: roundMoney(row.gross + rowTax),
    };
  });
  return { subtotal, discount, tax, total, invoiceItems };
}

async function createDeliveryInvoice(tx, companyId, order, deliveredRows, finalEvent) {
  if (!deliveredRows.length) return null;
  const amounts = calculateInvoicePart(order, deliveredRows, finalEvent);
  const termDays = Math.max(0, Number(order.customer?.metadata?.paymentTermDays || 0));
  const dueAt = termDays ? new Date(Date.now() + termDays * 86400000) : null;
  const invoice = await tx.invoice.create({
    data: {
      companyId,
      orderId: order.id,
      customerId: order.customerId,
      number: await nextDocumentNumber(tx, companyId, "INVOICE", "INV"),
      currency: order.currency || "UZS",
      subtotal: amounts.subtotal,
      discount: amounts.discount,
      tax: amounts.tax,
      total: amounts.total,
      dueAt,
      items: { create: amounts.invoiceItems },
    },
  });
  return issueInvoiceInTransaction(tx, companyId, invoice.id);
}

async function assertFinancePolicy(tx, companyId, order, settings, issuedInvoice) {
  const finance = settings?.finance || {};
  if (!order.customerId) throw new ValidationError("Yetkazib berish uchun mijoz tanlangan bo‘lishi kerak");
  if (finance.allowCreditSales === false && invoiceOutstanding(issuedInvoice) > EPSILON) {
    throw new ConflictError("Nasiya savdo o‘chirilgan. Yetkazishni yakunlashdan oldin to‘lovni qabul qiling", {
      outstanding: invoiceOutstanding(issuedInvoice),
      invoiceId: issuedInvoice.id,
    });
  }
  const customer = await tx.customer.findFirst({ where: { id: order.customerId, companyId }, select: { balance: true, creditLimit: true } });
  if (finance.enforceCreditLimit === true && Number(customer?.balance || 0) - Number(customer?.creditLimit || 0) > EPSILON) {
    throw new ConflictError("Mijoz kredit limiti oshib ketdi", { balance: Number(customer?.balance || 0), creditLimit: Number(customer?.creditLimit || 0) });
  }
}

async function assertNoBlockedOverdue(tx, companyId, order, settings) {
  if (settings?.finance?.blockOverdueOrders !== true || !order.customerId) return;
  const overdue = await tx.debt.findFirst({ where: { companyId, customerId: order.customerId, outstanding: { gt: 0 }, dueAt: { lt: new Date() } }, select: { id: true, outstanding: true, dueAt: true } });
  if (overdue) throw new ConflictError("Mijozda muddati o‘tgan qarz bor. Yetkazishni yakunlash bloklandi", { debtId: overdue.id, outstanding: Number(overdue.outstanding), dueAt: overdue.dueAt });
}

async function syncOrderPaymentStatus(tx, orderId) {
  const invoices = await tx.invoice.findMany({ where: { orderId, status: { not: "VOID" } }, select: { total: true, paid: true, credited: true } });
  if (!invoices.length) return "DRAFT";
  const outstanding = invoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0);
  const settled = invoices.reduce((sum, invoice) => sum + Number(invoice.paid || 0) + Number(invoice.credited || 0), 0);
  const status = outstanding <= EPSILON ? "PAID" : settled > EPSILON ? "PARTIALLY_PAID" : "ISSUED";
  await tx.order.update({ where: { id: orderId }, data: { paymentStatus: status } });
  return status;
}

async function loadDelivery(tx, companyId, id) {
  return tx.delivery.findFirst({
    where: { id, companyId },
    include: {
      trip: true,
      order: { include: orderDeliveryInclude },
      customer: true,
    },
  });
}

async function applyDelivery(tx, request, delivery, requestedRows, proof) {
  const companyId = request.tenant.companyId;
  const settings = await companySettings(tx, companyId);
  assertProof(settings, proof);
  await assertNoBlockedOverdue(tx, companyId, delivery.order, settings);

  const pickList = delivery.order.pickLists?.[0];
  if (!pickList) throw new ConflictError("Yetkazishdan oldin picking yakunlangan bo‘lishi kerak");
  const pickByOrderItem = new Map(pickList.items.map((line) => [line.orderItemId, line]));
  const deliveredRows = [];

  for (const row of requestedRows) {
    const orderItem = delivery.order.items.find((item) => item.id === row.orderItemId);
    const reservation = delivery.order.reservations.find((item) => item.orderItemId === row.orderItemId && item.status === "ACTIVE");
    if (!orderItem || !reservation) throw new ValidationError("Yetkazilayotgan qator uchun faol rezerv topilmadi", { orderItemId: row.orderItemId });
    const remainingDisplay = roundQty(Math.max(0, Number(orderItem.quantity) - Number(orderItem.fulfilledQty || 0)));
    const quantity = roundQty(Number(row.quantity));
    if (quantity <= 0 || quantity > remainingDisplay + 1e-9) throw new ConflictError("Yetkazilgan miqdor qolgan buyurtma miqdoridan oshib ketdi", { orderItemId: row.orderItemId, remaining: remainingDisplay });
    deliveredRows.push(await consumeReservation(tx, {
      companyId,
      employeeId: request.auth.employeeId,
      order: delivery.order,
      reservation,
      displayQuantity: quantity,
      pickLine: pickByOrderItem.get(orderItem.id),
    }));
  }

  const deliveredByItem = new Map(deliveredRows.map((row) => [row.orderItemId, Number(row.quantity)]));
  const finalEvent = delivery.order.items.every((item) => Number(item.fulfilledQty || 0) + Number(deliveredByItem.get(item.id) || 0) + 1e-9 >= Number(item.quantity));
  const invoice = await createDeliveryInvoice(tx, companyId, delivery.order, deliveredRows, finalEvent);
  await assertFinancePolicy(tx, companyId, delivery.order, settings, invoice);
  const paymentStatus = await syncOrderPaymentStatus(tx, delivery.order.id);

  if (finalEvent) {
    await tx.order.update({ where: { id: delivery.order.id }, data: {
      status: "COMPLETED",
      fulfillmentStatus: "FULFILLED",
      deliveryStatus: "DELIVERED",
      paymentStatus,
      completedAt: new Date(),
    } });
    await tx.orderStatusHistory.create({ data: {
      orderId: delivery.order.id,
      employeeId: request.auth.employeeId,
      status: "COMPLETED",
      fulfillment: "FULFILLED",
      delivery: "DELIVERED",
      note: "Delivery completed",
    } });
  } else {
    await tx.order.update({ where: { id: delivery.order.id }, data: { deliveryStatus: "PARTIALLY_DELIVERED", paymentStatus } });
    await tx.orderStatusHistory.create({ data: {
      orderId: delivery.order.id,
      employeeId: request.auth.employeeId,
      status: "CONFIRMED",
      fulfillment: "FULFILLED",
      delivery: "PARTIALLY_DELIVERED",
      note: "Partial delivery completed",
    } });
  }

  return { finalEvent, invoice, deliveredRows };
}

export function createDeliveryRouter({ prisma }) {
  const router = Router();
  router.use(requireModule("delivery"));

  router.get("/trips", requirePermission("delivery.read"), asyncHandler(async (request, response) => {
    const where = { companyId: request.tenant.companyId };
    if (!isPrivileged(request)) where.driverEmployeeId = request.auth.employeeId;
    const data = await prisma.deliveryTrip.findMany({ where, include: tripInclude, orderBy: [{ plannedDate: "desc" }, { createdAt: "desc" }], take: 500 });
    return sendSuccess(response, { data });
  }));

  router.post("/trips", requirePermission("delivery.create"), validate({ body: tripCreateSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const uniqueOrderIds = [...new Set(input.orderIds)];
      const orders = await tx.order.findMany({
        where: { id: { in: uniqueOrderIds }, companyId, status: "CONFIRMED", fulfillmentStatus: "FULFILLED", deliveryStatus: { not: "DELIVERED" } },
      });
      if (orders.length !== uniqueOrderIds.length || orders.some((order) => order.warehouseId !== input.warehouseId || !order.customerId)) {
        throw new ValidationError("Buyurtmalar reysga tayyor emas yoki mijoz biriktirilmagan");
      }
      const activeDeliveries = await tx.delivery.findMany({
        where: {
          companyId,
          orderId: { in: uniqueOrderIds },
          status: { in: ["PLANNED", "OUT_FOR_DELIVERY", "ARRIVED"] },
          trip: { status: { in: ["APPROVED", "IN_PROGRESS"] } },
        },
        select: { orderId: true },
      });
      if (activeDeliveries.length) throw new ConflictError("Ayrim buyurtmalar allaqachon faol reysga biriktirilgan", { orderIds: [...new Set(activeDeliveries.map(({ orderId }) => orderId))] });

      if (input.driverEmployeeId) {
        const driver = await tx.employee.findFirst({
          where: {
            id: input.driverEmployeeId,
            companyId,
            status: "ACTIVE",
            deletedAt: null,
            OR: [
              { modules: { some: { module: "driver_workspace", enabled: true } } },
              { roles: { some: { role: { code: { in: ["OWNER", "ADMIN"] } } } } },
            ],
          },
          select: { id: true },
        });
        if (!driver) throw new ValidationError("Haydovchi faol Driver workspace xodimi bo‘lishi kerak");
      }

      const trip = await tx.deliveryTrip.create({
        data: {
          companyId,
          warehouseId: input.warehouseId,
          driverEmployeeId: input.driverEmployeeId || null,
          vehicle: input.vehicle,
          plannedDate: input.plannedDate || null,
          plannedKm: input.plannedKm,
          plannedMinutes: input.plannedMinutes,
          number: await nextDocumentNumber(tx, companyId, "DELIVERY_TRIP", "TRIP"),
          status: "APPROVED",
          deliveries: { create: orders.map((order, index) => ({ companyId, orderId: order.id, customerId: order.customerId, stopOrder: index + 1 })) },
        },
        include: tripInclude,
      });
      await tx.order.updateMany({ where: { id: { in: uniqueOrderIds }, companyId }, data: { deliveryStatus: "PLANNED" } });
      return trip;
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "CREATE", entity: "DeliveryTrip", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));

  router.post("/trips/:id/start", requirePermission("delivery.update"), validate({ params }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const trip = await tx.deliveryTrip.findFirst({ where: { id: request.params.id, companyId } });
      if (!trip) throw new NotFoundError("Delivery trip not found");
      if (trip.status !== "APPROVED") throw new ConflictError("Trip cannot be started");
      if (!isPrivileged(request) && trip.driverEmployeeId !== request.auth.employeeId) throw new AuthorizationError("Bu reys boshqa haydovchiga biriktirilgan");
      await tx.delivery.updateMany({ where: { tripId: trip.id, status: "PLANNED" }, data: { status: "OUT_FOR_DELIVERY" } });
      const deliveries = await tx.delivery.findMany({ where: { tripId: trip.id, status: "OUT_FOR_DELIVERY" }, select: { orderId: true } });
      if (!deliveries.length) throw new ConflictError("Reysda yo‘lga chiqadigan topshiriq yo‘q");
      await tx.order.updateMany({ where: { id: { in: deliveries.map(({ orderId }) => orderId) } }, data: { deliveryStatus: "OUT_FOR_DELIVERY" } });
      return tx.deliveryTrip.update({ where: { id: trip.id }, data: { status: "IN_PROGRESS", startedAt: new Date() }, include: tripInclude });
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "START", entity: "DeliveryTrip", entityId: data.id, after: data });
    return sendSuccess(response, { data });
  }));

  router.post("/trips/:id/complete", requirePermission("delivery.update"), validate({ params }), asyncHandler(async (request, response) => {
    const current = await prisma.deliveryTrip.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId }, include: { deliveries: true } });
    if (!current) throw new NotFoundError("Delivery trip not found");
    if (!isPrivileged(request) && current.driverEmployeeId !== request.auth.employeeId) throw new AuthorizationError("Bu reys boshqa haydovchiga biriktirilgan");
    if (current.status !== "IN_PROGRESS" || current.deliveries.some(({ status }) => !["DELIVERED", "PARTIALLY_DELIVERED", "FAILED", "CANCELLED"].includes(status))) {
      throw new ConflictError("Reysda yakunlanmagan topshiriqlar bor");
    }
    const data = await prisma.deliveryTrip.update({ where: { id: current.id }, data: { status: "COMPLETED", completedAt: new Date() }, include: tripInclude });
    await writeAudit(prisma, request, { action: "COMPLETE", entity: "DeliveryTrip", entityId: data.id, before: current, after: data });
    return sendSuccess(response, { data });
  }));

  router.get("/deliveries", requirePermission("delivery.read"), asyncHandler(async (request, response) => {
    const where = { companyId: request.tenant.companyId };
    if (!isPrivileged(request)) where.trip = { driverEmployeeId: request.auth.employeeId };
    const data = await prisma.delivery.findMany({ where, include: { trip: { include: { driver: { select: { id: true, name: true, phone: true } } } }, order: true, customer: true }, orderBy: { createdAt: "desc" }, take: 500 });
    return sendSuccess(response, { data });
  }));

  router.post("/deliveries/:id/arrive", requirePermission("delivery.update"), validate({ params, body: deliveryProofSchema }), asyncHandler(async (request, response) => {
    const current = await prisma.delivery.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId }, include: { trip: true } });
    if (!current) throw new NotFoundError("Delivery not found");
    assertDeliveryActor(request, current);
    if (current.status !== "OUT_FOR_DELIVERY") throw new ConflictError("Delivery is not on the road");
    const data = await prisma.delivery.update({ where: { id: current.id }, data: { status: "ARRIVED", arrivedAt: new Date(), proof: request.validated.body } });
    await prisma.order.update({ where: { id: current.orderId }, data: { deliveryStatus: "ARRIVED" } });
    await writeAudit(prisma, request, { action: "ARRIVE", entity: "Delivery", entityId: data.id, before: current, after: data });
    return sendSuccess(response, { data });
  }));

  router.post("/deliveries/:id/collect-payment", requirePermission("delivery.update"), validate({ params, body: deliveryPaymentSchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const delivery = await loadDelivery(tx, companyId, request.params.id);
      if (!delivery) throw new NotFoundError("Delivery not found");
      assertDeliveryActor(request, delivery);
      if (!["OUT_FOR_DELIVERY", "ARRIVED", "PARTIALLY_DELIVERED"].includes(delivery.status)) throw new ConflictError("Bu holatda to‘lov qabul qilib bo‘lmaydi");
      if (!delivery.order.customerId) throw new ValidationError("To‘lov uchun buyurtmada mijoz bo‘lishi kerak");
      const alreadyCollected = delivery.order.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      if (alreadyCollected + Number(request.validated.body.amount) > Number(delivery.order.total) + EPSILON) {
        throw new ConflictError("Buyurtma summasidan ortiq to‘lov qabul qilib bo‘lmaydi", { orderTotal: Number(delivery.order.total), alreadyCollected });
      }
      const payment = await createPaymentInTransaction(tx, companyId, request.auth.employeeId, {
        ...request.validated.body,
        customerId: delivery.order.customerId,
        orderId: delivery.order.id,
        currency: delivery.order.currency || "UZS",
        note: request.validated.body.note || `Delivery ${delivery.id}`,
      });
      const settings = await companySettings(tx, companyId);
      return settings?.finance?.requirePaymentConfirmation === false
        ? confirmPaymentInTransaction(tx, companyId, request.auth.employeeId, payment.id)
        : payment;
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "COLLECT_PAYMENT", entity: "Delivery", entityId: request.params.id, after: { paymentId: data.id, status: data.status, amount: data.amount } });
    return sendSuccess(response, { statusCode: 201, data });
  }));

  router.post("/deliveries/:id/complete", requirePermission("delivery.update"), validate({ params, body: deliveryProofSchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await loadDelivery(tx, companyId, request.params.id);
      if (!delivery) throw new NotFoundError("Delivery not found");
      assertDeliveryActor(request, delivery);
      if (!["ARRIVED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"].includes(delivery.status)) throw new ConflictError("Delivery cannot be completed");
      const rows = delivery.order.items.map((item) => ({ orderItemId: item.id, quantity: roundQty(Math.max(0, Number(item.quantity) - Number(item.fulfilledQty || 0))) })).filter(({ quantity }) => quantity > 0);
      if (!rows.length) throw new ConflictError("Buyurtmada yetkaziladigan qoldiq qolmagan");
      const applied = await applyDelivery(tx, request, delivery, rows, request.validated.body);
      const data = await tx.delivery.update({ where: { id: delivery.id }, data: {
        status: "DELIVERED",
        recipientName: request.validated.body.recipientName,
        proof: request.validated.body,
        deliveredAt: new Date(),
      } });
      return { data, invoice: applied.invoice };
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "COMPLETE", entity: "Delivery", entityId: result.data.id, after: result.data });
    return sendSuccess(response, { data: result.data, meta: { invoiceId: result.invoice?.id || null } });
  }));

  router.post("/deliveries/:id/partial", requirePermission("delivery.update"), validate({ params, body: partialDeliverySchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const input = request.validated.body;
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await loadDelivery(tx, companyId, request.params.id);
      if (!delivery) throw new NotFoundError("Delivery not found");
      assertDeliveryActor(request, delivery);
      if (!["ARRIVED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"].includes(delivery.status)) throw new ConflictError("Delivery cannot be partially completed");
      const settings = await companySettings(tx, companyId);
      if (settings?.delivery?.allowPartialDelivery === false) throw new ConflictError("Qisman yetkazish kompaniya sozlamalarida o‘chirilgan");
      const uniqueIds = new Set(input.deliveredItems.map(({ orderItemId }) => orderItemId));
      if (uniqueIds.size !== input.deliveredItems.length) throw new ValidationError("Bir buyurtma qatori qisman yetkazishda takrorlanmasin");
      const applied = await applyDelivery(tx, request, delivery, input.deliveredItems, input);
      const data = await tx.delivery.update({ where: { id: delivery.id }, data: {
        status: applied.finalEvent ? "DELIVERED" : "PARTIALLY_DELIVERED",
        recipientName: input.recipientName,
        proof: input,
        ...(applied.finalEvent ? { deliveredAt: new Date() } : {}),
      } });
      return { data, invoice: applied.invoice, finalEvent: applied.finalEvent };
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "PARTIAL", entity: "Delivery", entityId: result.data.id, after: result.data });
    return sendSuccess(response, { data: result.data, meta: { finalEvent: result.finalEvent, invoiceId: result.invoice?.id || null } });
  }));

  router.post("/deliveries/:id/fail", requirePermission("delivery.update"), validate({ params, body: failedDeliverySchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const current = await prisma.delivery.findFirst({ where: { id: request.params.id, companyId }, include: { trip: true } });
    if (!current) throw new NotFoundError("Delivery not found");
    assertDeliveryActor(request, current);
    if (["DELIVERED", "CANCELLED"].includes(current.status)) throw new ConflictError("Delivery cannot be failed");
    const settings = await companySettings(prisma, companyId);
    assertFailureReason(settings, request.validated.body.reason);
    const data = await prisma.delivery.update({ where: { id: current.id }, data: { status: "FAILED", failureReason: request.validated.body.reason || "Yetkazib berilmadi", proof: request.validated.body.proof || {} } });
    await prisma.order.update({ where: { id: current.orderId }, data: { deliveryStatus: "FAILED" } });
    await writeAudit(prisma, request, { action: "FAIL", entity: "Delivery", entityId: data.id, before: current, after: data });
    return sendSuccess(response, { data });
  }));

  return router;
}
