import { z } from "zod";
export const deliveryProofSchema = z.object({
  recipientName: z.string().trim().min(2).max(160).optional(), latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(), photoUrl: z.string().max(1000).optional(), note: z.string().max(1000).optional(),
});
export const partialDeliverySchema = deliveryProofSchema.extend({
  deliveredItems: z.array(z.object({ orderItemId: z.uuid(), quantity: z.number().positive() })).min(1).max(500),
});
export const failedDeliverySchema = z.object({ reason: z.string().trim().min(3).max(1000), proof: deliveryProofSchema.optional() });
