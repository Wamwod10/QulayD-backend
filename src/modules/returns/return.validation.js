import { z } from "zod";
export const returnCreateSchema = z.object({
  orderId: z.uuid(), reason: z.string().trim().min(3).max(1000),
  items: z.array(z.object({ orderItemId: z.uuid(), quantity: z.number().positive(), condition: z.enum(["RESTOCK", "DAMAGED", "DISPOSE"]).optional(),
    serialIds: z.array(z.uuid()).max(500).optional() })).min(1).max(500),
});
export const returnRefundSchema = z.object({ method: z.enum(["CASH", "CARD", "QR", "BANK", "OTHER"]), shiftId: z.uuid().nullable().optional(), note: z.string().max(500).optional() });
