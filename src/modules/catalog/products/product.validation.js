import { z } from "zod";

const imageUrl = z.union([z.url(), z.string().regex(/^\/uploads\/[A-Za-z0-9.-]+$/)]);
const barcodeValue = z.string().trim().min(3).max(64);
const skuValue = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._\/-]+$/, "SKU may contain letters, numbers, dot, underscore, slash and hyphen");
const barcode = z.object({ barcode: barcodeValue, isPrimary: z.boolean().optional() });
const price = z.object({
  priceListId: z.uuid(), price: z.number().min(0),
  variantId: z.uuid().nullable().optional(), packageId: z.uuid().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.variantId && value.packageId) ctx.addIssue({ code: "custom", message: "Price can target either a variant or a package, not both" });
});
const stock = z.object({ warehouseId: z.uuid(), onHand: z.number().min(0) });
const variant = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(1).max(120), sku: skuValue,
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  imageUrl: imageUrl.optional(), costPrice: z.number().min(0).nullable().optional(), price: z.number().min(0).nullable().optional(),
  barcodes: z.array(barcodeValue).max(20).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
const productPackage = z.object({
  id: z.uuid().optional(), parentPackageId: z.uuid().nullable().optional(), variantId: z.uuid().nullable().optional(), variantSku: skuValue.nullable().optional(),
  name: z.string().trim().min(1).max(80), conversionQuantity: z.number().positive(), conversionToBase: z.number().positive(),
  barcode: barcodeValue.optional(), costPrice: z.number().min(0).nullable().optional(), price: z.number().min(0).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
const productImage = z.object({ id: z.uuid().optional(), url: imageUrl, alt: z.string().max(200).optional(), isPrimary: z.boolean().optional() });

function validateCollections(value, ctx) {
  const barcodeValues = [
    ...(value.barcodes || []).map((entry) => entry.barcode),
    ...(value.variants || []).flatMap((entry) => entry.barcodes || []),
    ...(value.packages || []).map((entry) => entry.barcode).filter(Boolean),
  ];
  if (new Set(barcodeValues).size !== barcodeValues.length) ctx.addIssue({ code: "custom", path: ["barcodes"], message: "Barcodes must be unique" });
  if ((value.barcodes || []).filter((entry) => entry.isPrimary).length > 1) ctx.addIssue({ code: "custom", path: ["barcodes"], message: "Only one primary barcode is allowed" });
  if ((value.images || []).filter((entry) => entry.isPrimary).length > 1) ctx.addIssue({ code: "custom", path: ["images"], message: "Only one primary image is allowed" });
  if (value.prices) {
    const priceKeys = value.prices.map((row) => `${row.priceListId}:${row.packageId ? `PACKAGE:${row.packageId}` : row.variantId ? `VARIANT:${row.variantId}` : "BASE"}`);
    if (new Set(priceKeys).size !== priceKeys.length) ctx.addIssue({ code: "custom", path: ["prices"], message: "Price list + product scope must be unique" });
  }
  for (const [field, rows, key] of [["openingStock", value.openingStock, "warehouseId"], ["variants", value.variants, "sku"]]) {
    if (rows && new Set(rows.map((row) => row[key])).size !== rows.length) ctx.addIssue({ code: "custom", path: [field], message: `${field} references must be unique` });
  }
  const hasOpeningStock = (value.openingStock || []).some((row) => Number(row.onHand) > 0);
  if ((value.trackSerial || value.trackLot || value.trackExpiry) && hasOpeningStock) {
    ctx.addIssue({ code: "custom", path: ["openingStock"], message: "Tracked products must receive opening stock through Goods Receipt so serial/lot/expiry data is captured" });
  }
  if ((value.variants || []).some((row) => row.status !== "INACTIVE") && hasOpeningStock) {
    ctx.addIssue({ code: "custom", path: ["openingStock"], message: "Variant products must receive opening stock through Goods Receipt/Stock Adjustment so stock is assigned to a variant" });
  }
}

const productBaseSchema = z.object({
  name: z.string().trim().min(2).max(200), sku: skuValue.optional(),
  categoryId: z.uuid().nullable().optional(), unitId: z.uuid(), supplierId: z.uuid().nullable().optional(),
  description: z.string().trim().max(2000).optional(), manufacturer: z.string().trim().max(160).optional(),
  model: z.string().trim().max(160).optional(), note: z.string().trim().max(2000).optional(), warehouseLocation: z.string().trim().max(120).optional(),
  imageUrl: imageUrl.optional(), images: z.array(productImage).max(10).optional(), costPrice: z.number().min(0).optional(), minStock: z.number().min(0).optional(),
  trackStock: z.boolean().optional(), trackExpiry: z.boolean().optional(), trackLot: z.boolean().optional(), trackSerial: z.boolean().optional(), isMarked: z.boolean().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(), barcodes: z.array(barcode).max(20).default([]), prices: z.array(price).max(2000).optional(), replacePrices: z.boolean().optional(),
  openingStock: z.array(stock).max(100).optional(), variants: z.array(variant).max(250).optional(), packages: z.array(productPackage).max(50).optional(),
});

export const productCreateSchema = productBaseSchema.superRefine(validateCollections);
export const productUpdateSchema = productBaseSchema.omit({ openingStock: true }).partial().superRefine(validateCollections);
