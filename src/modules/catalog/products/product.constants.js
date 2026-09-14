export const PRODUCT_INCLUDE = Object.freeze({
  category: true, unit: true, supplier: true, images: { orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }] },
  barcodes: { orderBy: { isPrimary: "desc" } }, variants: { include: { barcodes: true }, orderBy: { createdAt: "asc" } },
  packages: { include: { barcodes: true }, orderBy: { createdAt: "asc" } },
  batches: { where: { quantity: { gt: 0 } }, orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }] },
  serials: { where: { status: { in: ["AVAILABLE", "RESERVED"] } }, orderBy: { createdAt: "asc" } },
  prices: { where: { validTo: null }, include: { priceList: true } }, stocks: { include: { warehouse: true } },
});
