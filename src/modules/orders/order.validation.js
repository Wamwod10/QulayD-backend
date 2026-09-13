import { z } from "zod";
const orderItem = z.object({
  productId: z.uuid(), quantity: z.number().positive(), unitPrice: z.number().min(0),
  discount: z.number().min(0).optional(), tax: z.number().min(0).optional(),
});
export const orderCreateSchema = z.object({
  branchId: z.uuid().nullable().optional(), warehouseId: z.uuid(), customerId: z.uuid().nullable().optional(),
  priceListId: z.uuid().nullable().optional(), agentId: z.uuid().nullable().optional(),
  channel: z.enum(["SALES", "POS", "DELIVERY", "MOBILE"]).optional(), currency: z.string().length(3).toUpperCase().optional(),
  discount: z.number().min(0).optional(), tax: z.number().min(0).optional(), note: z.string().max(2000).optional(),
  deliveryAddress: z.string().max(500).optional(), items: z.array(orderItem).min(1).max(500),
});
export const orderUpdateSchema = orderCreateSchema.omit({ warehouseId: true }).partial();
export const transitionSchema = z.object({ note: z.string().trim().max(1000).optional() });
