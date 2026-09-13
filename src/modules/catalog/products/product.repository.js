import { PRODUCT_INCLUDE } from "./product.constants.js";
import { ValidationError } from "../../../shared/errors/index.js";

async function assertProductReferences(tx, companyId, input) {
  const priceListIds = [...new Set((input.prices || []).map(({ priceListId }) => priceListId))];
  const warehouseIds = [...new Set((input.openingStock || []).map(({ warehouseId }) => warehouseId))];
  const [unit, category, priceLists, warehouses] = await Promise.all([
    input.unitId ? tx.unit.count({ where: { id: input.unitId, companyId, status: "ACTIVE" } }) : 1,
    input.categoryId ? tx.category.count({ where: { id: input.categoryId, companyId, deletedAt: null } }) : 1,
    priceListIds.length ? tx.priceList.count({ where: { id: { in: priceListIds }, companyId, status: "ACTIVE" } }) : 0,
    warehouseIds.length ? tx.warehouse.count({ where: { id: { in: warehouseIds }, companyId, deletedAt: null, status: "ACTIVE" } }) : 0,
  ]);
  if (unit !== 1 || category !== 1 || priceLists !== priceListIds.length || warehouses !== warehouseIds.length) {
    throw new ValidationError("Invalid product resource reference");
  }
}

async function nextSku(tx, companyId) {
  const sequence = await tx.documentSequence.upsert({
    where: { companyId_type_year: { companyId, type: "SKU", year: 0 } },
    create: { companyId, type: "SKU", prefix: "", year: 0, value: 1 },
    update: { value: { increment: 1 } },
  });
  if (sequence.value > 99_999) throw new Error("SKU range exhausted");
  return String(sequence.value).padStart(5, "0");
}

export function createProductRepository(prisma) {
  return {
    async list(companyId, { where = {}, skip, take, orderBy }) {
      const scoped = { companyId, deletedAt: null, ...where };
      const [data, total] = await prisma.$transaction([
        prisma.product.findMany({ where: scoped, include: PRODUCT_INCLUDE, skip, take, orderBy }),
        prisma.product.count({ where: scoped }),
      ]);
      return { data, total };
    },
    find(companyId, id) {
      return prisma.product.findFirst({ where: { companyId, id, deletedAt: null }, include: PRODUCT_INCLUDE });
    },
    create(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        const { barcodes, prices = [], openingStock = [], variants = [], ...fields } = input;
        await assertProductReferences(tx, companyId, input);
        const sku = fields.sku || await nextSku(tx, companyId);
        const product = await tx.product.create({
          data: {
            ...fields, sku, companyId,
            barcodes: { create: barcodes.map((entry, index) => ({ ...entry, isPrimary: entry.isPrimary ?? index === 0, companyId })) },
            variants: { create: variants.map((entry) => ({ ...entry, companyId })) },
            prices: { create: prices.map((entry) => ({ ...entry, companyId })) },
            stocks: { create: openingStock.map((entry) => ({ ...entry, companyId, reserved: 0 })) },
          },
          include: PRODUCT_INCLUDE,
        });
        if (openingStock.length) await tx.stockMovement.createMany({ data: openingStock.map((entry) => ({
          companyId, employeeId, productId: product.id, warehouseId: entry.warehouseId,
          type: "OPENING", quantity: entry.onHand, balanceAfter: entry.onHand,
        })) });
        return product;
      }, { isolationLevel: "Serializable" });
    },
    update(companyId, id, input) {
      return prisma.$transaction(async (tx) => {
        const current = await tx.product.findFirst({ where: { id, companyId, deletedAt: null }, include: PRODUCT_INCLUDE });
        if (!current) return null;
        await assertProductReferences(tx, companyId, input);
        const { barcodes, prices, variants, ...fields } = input;
        if (barcodes) {
          await tx.productBarcode.deleteMany({ where: { productId: id } });
          await tx.productBarcode.createMany({ data: barcodes.map((entry, index) => ({
            ...entry, isPrimary: entry.isPrimary ?? index === 0, companyId, productId: id,
          })) });
        }
        if (prices) {
          await tx.productPrice.updateMany({ where: { productId: id, validTo: null }, data: { validTo: new Date() } });
          if (prices.length) await tx.productPrice.createMany({ data: prices.map((entry) => ({ ...entry, companyId, productId: id })) });
        }
        if (variants) {
          await tx.productVariant.deleteMany({ where: { productId: id } });
          if (variants.length) await tx.productVariant.createMany({ data: variants.map((entry) => ({ ...entry, companyId, productId: id })) });
        }
        const data = await tx.product.update({ where: { id }, data: fields, include: PRODUCT_INCLUDE });
        return { before: current, data };
      });
    },
    archive(companyId, id) {
      return prisma.product.updateMany({ where: { id, companyId, deletedAt: null }, data: { deletedAt: new Date(), status: "ARCHIVED" } });
    },
  };
}
