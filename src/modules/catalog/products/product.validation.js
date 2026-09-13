import { z } from "zod";
const barcode = z.object({ barcode: z.string().trim().min(3).max(64), isPrimary: z.boolean().optional() });
const price = z.object({ priceListId: z.uuid(), price: z.number().min(0) });
const stock = z.object({ warehouseId: z.uuid(), onHand: z.number().min(0) });
const variant = z.object({
  name: z.string().trim().min(1).max(120), sku: z.string().regex(/^\d{5}$/),
  attributes: z.record(z.string(), z.unknown()).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
const productBaseSchema = z.object({
  name: z.string().trim().min(2).max(200), sku: z.string().regex(/^\d{5}$/).optional(),
  categoryId: z.uuid().nullable().optional(), unitId: z.uuid(), description: z.string().trim().max(2000).optional(),
  imageUrl: z.union([z.url(), z.string().regex(/^\/uploads\/[A-Za-z0-9.-]+$/)]).optional(), costPrice: z.number().min(0).optional(), minStock: z.number().min(0).optional(),
  trackStock: z.boolean().optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  barcodes: z.array(barcode).min(1).max(20), prices: z.array(price).max(50).optional(),
  openingStock: z.array(stock).max(100).optional(), variants: z.array(variant).max(100).optional(),
});
export const productCreateSchema = productBaseSchema.superRefine((value, ctx) => {
  const values = value.barcodes.map((entry) => entry.barcode);
  if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: ["barcodes"], message: "Barcodes must be unique" });
  for (const [field, rows, key] of [["prices", value.prices, "priceListId"], ["openingStock", value.openingStock, "warehouseId"], ["variants", value.variants, "sku"]]) {
    if (rows && new Set(rows.map((row) => row[key])).size !== rows.length) ctx.addIssue({ code: "custom", path: [field], message: `${field} references must be unique` });
  }
});
export const productUpdateSchema = productBaseSchema.omit({ openingStock: true }).partial();
