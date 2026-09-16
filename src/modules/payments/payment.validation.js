import { z } from "zod";

export const paymentCreateSchema = z.object({
  customerId: z.uuid().nullable().optional(),
  supplierId: z.uuid().nullable().optional(),
  orderId: z.uuid().nullable().optional(),
  shiftId: z.uuid().nullable().optional(),
  method: z.enum(["CASH", "CARD", "QR", "BANK", "OTHER"]).optional(),
  methodCode: z.string().trim().min(1).max(32).optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).toUpperCase().optional(),
  externalRef: z.string().trim().max(200).optional(),
  note: z.string().max(1000).optional(),
  allocations: z.array(z.object({ invoiceId: z.uuid(), amount: z.number().positive() })).max(100).optional(),
  debtAllocations: z.array(z.object({ debtId: z.uuid(), amount: z.number().positive() })).max(100).optional(),
}).refine((value) => !(value.customerId && value.supplierId), { message: "Payment cannot target customer and supplier together" })
  .refine((value) => Boolean(value.method || value.methodCode), { message: "Payment method is required" });
