import { z } from "zod";
const saleItem = z.object({ productId: z.uuid(), quantity: z.number().positive(), unitPrice: z.number().min(0), discount: z.number().min(0).optional() });
const payment = z.object({ method: z.enum(["CASH", "CARD", "QR", "BANK", "CREDIT", "OTHER"]), amount: z.number().positive(), externalRef: z.string().max(200).optional() });
export const posSaleSchema = z.object({
  warehouseId: z.uuid(), customerId: z.uuid().nullable().optional(), shiftId: z.uuid().nullable().optional(),
  currency: z.string().length(3).toUpperCase().optional(), items: z.array(saleItem).min(1).max(500),
  payments: z.array(payment).min(1).max(10), note: z.string().max(1000).optional(),
});
export const openShiftSchema = z.object({ cashboxId: z.uuid(), openingBalance: z.number().min(0), note: z.string().max(500).optional() });
export const closeShiftSchema = z.object({ closingBalance: z.number().min(0), note: z.string().max(500).optional() });
export const cashActionSchema = z.object({ type: z.enum(["CASH_IN", "CASH_OUT", "INCOME", "EXPENSE"]), amount: z.number().positive(), description: z.string().trim().min(2).max(500) });
export const cashboxSchema = z.object({
  branchId: z.uuid().nullable().optional(), warehouseId: z.uuid().nullable().optional(),
  name: z.string().trim().min(2).max(120), code: z.string().trim().min(2).max(32).toUpperCase(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
export const paymentMethodSchema = z.object({
  code: z.string().trim().min(2).max(32).toUpperCase(), name: z.string().trim().min(2).max(120),
  method: z.enum(["CASH", "CARD", "QR", "BANK", "CREDIT", "OTHER"]), shortcut: z.string().trim().max(20).optional(),
  commissionRate: z.number().min(0).max(100).optional(), metadata: z.record(z.string(), z.unknown()).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
export const heldCartSchema = z.object({
  customerId: z.uuid().nullable().optional(), name: z.string().trim().max(120).optional(), note: z.string().max(500).optional(),
  expiresAt: z.coerce.date().optional(), items: z.array(z.object({ productId: z.uuid(), quantity: z.number().positive(), unitPrice: z.number().min(0), discount: z.number().min(0).optional() })).min(1).max(500),
});
