export const listBalances = (prisma, companyId, where, pagination) => prisma.$transaction([
  prisma.warehouseStock.findMany({ where: { companyId, stockKey: "BASE", ...where }, include: { product: { include: { unit: true, category: true, barcodes: true } }, warehouse: true }, ...pagination }),
  prisma.warehouseStock.count({ where: { companyId, stockKey: "BASE", ...where } }),
]);
