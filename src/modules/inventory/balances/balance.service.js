import { ConflictError } from "../../../shared/errors/index.js";

const BASE_STOCK_KEY = "BASE";
const EPSILON = 0.0005;

export async function resolveAllowNegativeStock(prisma, companyId) {
  const settings = await prisma.settings.findUnique({ where: { companyId }, select: { data: true } });
  const data = settings?.data && typeof settings.data === "object" ? settings.data : {};
  const inventoryValue = data?.inventory?.allowNegativeStock;
  if (typeof inventoryValue === "boolean") return inventoryValue;
  // Backward compatibility for companies created before inventory.allowNegativeStock became canonical.
  return Boolean(data?.sales?.allowNegativeStock);
}

async function allocateLegacyVariantStock(prisma, {
  companyId, warehouseId, productId, variantId, quantity, reserved, allowNegative,
}) {
  if (!variantId || allowNegative) return;
  const rows = await prisma.warehouseStock.findMany({
    where: { companyId, warehouseId, productId },
    select: { stockKey: true, variantId: true, onHand: true, reserved: true },
  });
  const aggregate = rows.find((row) => row.stockKey === BASE_STOCK_KEY);
  if (!aggregate) return;

  const variantRow = rows.find((row) => row.stockKey === variantId);
  const currentOnHand = Number(variantRow?.onHand || 0);
  const currentReserved = Number(variantRow?.reserved || 0);
  const projectedOnHand = currentOnHand + Number(quantity || 0);
  const projectedReserved = currentReserved + Number(reserved || 0);
  const allocationNeeded = Math.max(0, -projectedOnHand, projectedReserved - projectedOnHand);
  if (allocationNeeded <= EPSILON) return;

  // Older QULAY data only had product-level stock. The difference between BASE and the
  // sum of variant rows is legacy/unallocated stock. Attribute only the amount needed
  // by the selected variant, without changing the physical BASE total.
  const variantRows = rows.filter((row) => row.stockKey !== BASE_STOCK_KEY);
  const assignedOnHand = variantRows.reduce((sum, row) => sum + Number(row.onHand || 0), 0);
  const assignedReserved = variantRows.reduce((sum, row) => sum + Number(row.reserved || 0), 0);
  const unallocatedOnHand = Math.max(0, Number(aggregate.onHand || 0) - assignedOnHand);
  const unallocatedReserved = Math.max(0, Number(aggregate.reserved || 0) - assignedReserved);
  const unallocatedAvailable = Math.max(0, unallocatedOnHand - unallocatedReserved);
  if (allocationNeeded - unallocatedAvailable > EPSILON) return;

  await prisma.warehouseStock.upsert({
    where: { warehouseId_productId_stockKey: { warehouseId, productId, stockKey: variantId } },
    create: { companyId, warehouseId, productId, variantId, stockKey: variantId, onHand: allocationNeeded, reserved: 0 },
    update: { onHand: { increment: allocationNeeded }, version: { increment: 1 } },
  });
}

async function mutateBalance(prisma, {
  companyId, warehouseId, productId, variantId = null, stockKey, quantity, reserved, allowNegative,
}) {
  const stock = await prisma.warehouseStock.upsert({
    where: { warehouseId_productId_stockKey: { warehouseId, productId, stockKey } },
    create: { companyId, warehouseId, productId, variantId, stockKey, onHand: quantity, reserved },
    update: { onHand: { increment: quantity }, reserved: { increment: reserved }, version: { increment: 1 } },
  });
  const onHand = Number(stock.onHand); const reservedValue = Number(stock.reserved);
  if ((!allowNegative && onHand < -EPSILON) || reservedValue < -EPSILON || (!allowNegative && reservedValue - onHand > EPSILON)) {
    throw new ConflictError("Insufficient available stock", { warehouseId, productId, variantId, onHand, reserved: reservedValue });
  }
  return stock;
}

export async function changeStock(prisma, {
  companyId, warehouseId, productId, employeeId, quantity = 0, reserved = 0,
  variantId, packageId, batchId, type, referenceType, referenceId, reason, unitCost, allowNegative = false,
}) {
  const normalizedQuantity = Number(quantity || 0); const normalizedReserved = Number(reserved || 0);
  if (variantId) {
    await allocateLegacyVariantStock(prisma, { companyId, warehouseId, productId, variantId,
      quantity: normalizedQuantity, reserved: normalizedReserved, allowNegative });
  }
  // BASE is the canonical product aggregate. Variant rows are an additional constraint/view, not a replacement,
  // so existing dashboard/report/inventory totals remain backwards compatible and never double count.
  const aggregate = await mutateBalance(prisma, { companyId, warehouseId, productId, stockKey: BASE_STOCK_KEY,
    quantity: normalizedQuantity, reserved: normalizedReserved, allowNegative });
  if (variantId) {
    await mutateBalance(prisma, { companyId, warehouseId, productId, variantId, stockKey: variantId,
      quantity: normalizedQuantity, reserved: normalizedReserved, allowNegative });
  }
  if (normalizedQuantity !== 0) await prisma.stockMovement.create({ data: {
    companyId, warehouseId, productId, variantId, packageId, batchId, employeeId, type, quantity: normalizedQuantity, unitCost,
    referenceType, referenceId, reason, balanceAfter: aggregate.onHand,
  } });
  return aggregate;
}
