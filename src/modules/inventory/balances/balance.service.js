import { ConflictError } from "../../../shared/errors/index.js";

export async function changeStock(prisma, {
  companyId, warehouseId, productId, employeeId, quantity = 0, reserved = 0,
  type, referenceType, referenceId, reason, unitCost, allowNegative = false,
}) {
  const stock = await prisma.warehouseStock.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    create: { companyId, warehouseId, productId, onHand: quantity, reserved },
    update: { onHand: { increment: quantity }, reserved: { increment: reserved }, version: { increment: 1 } },
  });
  const onHand = Number(stock.onHand); const reservedValue = Number(stock.reserved);
  if ((!allowNegative && onHand < 0) || reservedValue < 0 || (!allowNegative && reservedValue > onHand)) {
    throw new ConflictError("Insufficient available stock", { warehouseId, productId, onHand, reserved: reservedValue });
  }
  if (Number(quantity) !== 0) await prisma.stockMovement.create({ data: {
    companyId, warehouseId, productId, employeeId, type, quantity, unitCost,
    referenceType, referenceId, reason, balanceAfter: stock.onHand,
  } });
  return stock;
}
