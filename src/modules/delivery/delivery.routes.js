import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { changeStock } from "../inventory/balances/balance.service.js";
import { deliveryProofSchema, failedDeliverySchema, partialDeliverySchema } from "./deliveries/delivery.validation.js";
import { tripCreateSchema } from "./trips/trip.validation.js";
const params = z.object({ id: z.uuid() });
const tripInclude = { deliveries: { include: { customer: true, order: true } } };

async function consumeReservation(tx, companyId, employeeId, order, reservation, quantity) {
  if (quantity > Number(reservation.quantity)) throw new ConflictError("Delivered quantity exceeds reservation");
  await changeStock(tx, { companyId, warehouseId: reservation.warehouseId, productId: reservation.productId, employeeId,
    quantity: -quantity, reserved: -quantity, type: "SALE", referenceType: "Delivery", referenceId: order.id });
  const remains = Number(reservation.quantity) - quantity;
  await tx.stockReservation.update({ where: { id: reservation.id }, data: { quantity: remains, status: remains === 0 ? "CONSUMED" : "ACTIVE" } });
  await tx.orderItem.update({ where: { id: reservation.orderItemId }, data: { fulfilledQty: { increment: quantity } } });
}

export function createDeliveryRouter({ prisma }) {
  const router = Router(); router.use(requireModule("delivery"));
  router.get("/trips", requirePermission("delivery.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.deliveryTrip.findMany({ where: { companyId: request.tenant.companyId }, include: tripInclude, orderBy: { createdAt: "desc" }, take: 500 }) })));
  router.post("/trips", requirePermission("delivery.create"), validate({ body: tripCreateSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const orders = await tx.order.findMany({ where: { id: { in: input.orderIds }, companyId, status: "CONFIRMED", fulfillmentStatus: "FULFILLED" } });
      if (orders.length !== new Set(input.orderIds).size || orders.some(({ warehouseId }) => warehouseId !== input.warehouseId)) throw new ValidationError("Orders are not ready for this delivery trip");
      if (input.driverEmployeeId && !(await tx.employee.count({ where: { id: input.driverEmployeeId, companyId, status: "ACTIVE" } }))) throw new ValidationError("Driver is invalid");
      const trip = await tx.deliveryTrip.create({ data: { companyId, warehouseId: input.warehouseId, driverEmployeeId: input.driverEmployeeId,
        vehicle: input.vehicle, plannedKm: input.plannedKm, plannedMinutes: input.plannedMinutes,
        number: await nextDocumentNumber(tx, companyId, "DELIVERY_TRIP", "TRIP"), status: "APPROVED",
        deliveries: { create: orders.map((order, index) => ({ companyId, orderId: order.id, customerId: order.customerId, stopOrder: index + 1 })) } }, include: tripInclude });
      await tx.order.updateMany({ where: { id: { in: input.orderIds }, companyId }, data: { deliveryStatus: "PLANNED" } }); return trip;
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "DeliveryTrip", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/trips/:id/start", requirePermission("delivery.update"), validate({ params }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const data = await prisma.$transaction(async (tx) => {
      const trip = await tx.deliveryTrip.findFirst({ where: { id: request.params.id, companyId } }); if (!trip) throw new NotFoundError("Delivery trip not found");
      if (trip.status !== "APPROVED") throw new ConflictError("Trip cannot be started");
      await tx.delivery.updateMany({ where: { tripId: trip.id }, data: { status: "OUT_FOR_DELIVERY" } });
      const deliveries = await tx.delivery.findMany({ where: { tripId: trip.id }, select: { orderId: true } });
      await tx.order.updateMany({ where: { id: { in: deliveries.map(({ orderId }) => orderId) } }, data: { deliveryStatus: "OUT_FOR_DELIVERY" } });
      return tx.deliveryTrip.update({ where: { id: trip.id }, data: { status: "IN_PROGRESS", startedAt: new Date() }, include: tripInclude });
    }); await writeAudit(prisma, request, { action: "START", entity: "DeliveryTrip", entityId: data.id, after: data }); return sendSuccess(response, { data });
  }));
  router.post("/trips/:id/complete", requirePermission("delivery.update"), validate({ params }), asyncHandler(async (request, response) => {
    const current = await prisma.deliveryTrip.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId }, include: { deliveries: true } });
    if (!current) throw new NotFoundError("Delivery trip not found");
    if (current.status !== "IN_PROGRESS" || current.deliveries.some(({ status }) => !["DELIVERED", "PARTIALLY_DELIVERED", "FAILED", "CANCELLED"].includes(status))) throw new ConflictError("Trip has unfinished deliveries");
    const data = await prisma.deliveryTrip.update({ where: { id: current.id }, data: { status: "COMPLETED", completedAt: new Date() }, include: tripInclude });
    await writeAudit(prisma, request, { action: "COMPLETE", entity: "DeliveryTrip", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
  }));
  router.get("/deliveries", requirePermission("delivery.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.delivery.findMany({ where: { companyId: request.tenant.companyId }, include: { trip: true, order: true, customer: true }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  router.post("/deliveries/:id/arrive", requirePermission("delivery.update"), validate({ params, body: deliveryProofSchema }), asyncHandler(async (request, response) => {
    const current = await prisma.delivery.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } }); if (!current) throw new NotFoundError("Delivery not found");
    if (current.status !== "OUT_FOR_DELIVERY") throw new ConflictError("Delivery is not on the road");
    const data = await prisma.delivery.update({ where: { id: current.id }, data: { status: "ARRIVED", arrivedAt: new Date(), proof: request.validated.body } });
    return sendSuccess(response, { data });
  }));
  router.post("/deliveries/:id/complete", requirePermission("delivery.update"), validate({ params, body: deliveryProofSchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const data = await prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findFirst({ where: { id: request.params.id, companyId }, include: { order: { include: { reservations: true } } } });
      if (!delivery) throw new NotFoundError("Delivery not found"); if (!["ARRIVED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"].includes(delivery.status)) throw new ConflictError("Delivery cannot be completed");
      for (const reservation of delivery.order.reservations.filter(({ status }) => status === "ACTIVE")) await consumeReservation(tx, companyId, request.auth.employeeId, delivery.order, reservation, Number(reservation.quantity));
      await tx.order.update({ where: { id: delivery.orderId }, data: { status: "COMPLETED", fulfillmentStatus: "FULFILLED", deliveryStatus: "DELIVERED", completedAt: new Date() } });
      await tx.orderStatusHistory.create({ data: { orderId: delivery.orderId, employeeId: request.auth.employeeId, status: "COMPLETED", fulfillment: "FULFILLED", delivery: "DELIVERED", note: "Delivery completed" } });
      return tx.delivery.update({ where: { id: delivery.id }, data: { status: "DELIVERED", recipientName: request.validated.body.recipientName, proof: request.validated.body, deliveredAt: new Date() } });
    }, { isolationLevel: "Serializable" }); await writeAudit(prisma, request, { action: "COMPLETE", entity: "Delivery", entityId: data.id, after: data }); return sendSuccess(response, { data });
  }));
  router.post("/deliveries/:id/partial", requirePermission("delivery.update"), validate({ params, body: partialDeliverySchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const input = request.validated.body; const data = await prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findFirst({ where: { id: request.params.id, companyId }, include: { order: { include: { reservations: true } } } });
      if (!delivery) throw new NotFoundError("Delivery not found"); if (!["ARRIVED", "OUT_FOR_DELIVERY"].includes(delivery.status)) throw new ConflictError("Delivery cannot be partially completed");
      for (const row of input.deliveredItems) { const reservation = delivery.order.reservations.find((item) => item.orderItemId === row.orderItemId && item.status === "ACTIVE");
        if (!reservation) throw new ValidationError("Delivered item has no active reservation"); await consumeReservation(tx, companyId, request.auth.employeeId, delivery.order, reservation, row.quantity); }
      await tx.order.update({ where: { id: delivery.orderId }, data: { deliveryStatus: "PARTIALLY_DELIVERED" } });
      return tx.delivery.update({ where: { id: delivery.id }, data: { status: "PARTIALLY_DELIVERED", recipientName: input.recipientName, proof: input } });
    }, { isolationLevel: "Serializable" }); await writeAudit(prisma, request, { action: "PARTIAL", entity: "Delivery", entityId: data.id, after: data }); return sendSuccess(response, { data });
  }));
  router.post("/deliveries/:id/fail", requirePermission("delivery.update"), validate({ params, body: failedDeliverySchema }), asyncHandler(async (request, response) => {
    const current = await prisma.delivery.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } }); if (!current) throw new NotFoundError("Delivery not found");
    if (["DELIVERED", "CANCELLED"].includes(current.status)) throw new ConflictError("Delivery cannot be failed");
    const data = await prisma.delivery.update({ where: { id: current.id }, data: { status: "FAILED", failureReason: request.validated.body.reason, proof: request.validated.body.proof || {} } });
    await prisma.order.update({ where: { id: current.orderId }, data: { deliveryStatus: "FAILED" } }); await writeAudit(prisma, request, { action: "FAIL", entity: "Delivery", entityId: data.id, after: data }); return sendSuccess(response, { data });
  })); return router;
}
