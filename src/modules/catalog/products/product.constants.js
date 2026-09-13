export const PRODUCT_INCLUDE = Object.freeze({
  category: true, unit: true, barcodes: { orderBy: { isPrimary: "desc" } },
  variants: true, prices: { where: { validTo: null }, include: { priceList: true } },
  stocks: { include: { warehouse: true } },
});
