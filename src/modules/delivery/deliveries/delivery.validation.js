import { z } from "zod";

export const deliveryProofSchema = z.object({
  recipientName: z.string().trim().min(2).max(160).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const partialDeliverySchema = deliveryProofSchema.extend({
  deliveredItems: z.array(z.object({ orderItemId: z.uuid(), quantity: z.number().positive() })).min(1).max(500),
});

export const failedDeliverySchema = z.object({
  reason: z.string().trim().min(3).max(1000).optional(),
  proof: deliveryProofSchema.optional(),
});

export const deliveryPaymentSchema = z.object({
  shiftId: z.uuid().nullable().optional(),
  method: z.enum(["CASH", "CARD", "QR", "BANK", "OTHER"]).optional(),
  methodCode: z.string().trim().min(1).max(32).optional(),
  amount: z.number().positive(),
  externalRef: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
}).refine((value) => Boolean(value.method || value.methodCode), { message: "Payment method is required" });
