import { z } from "zod";
export const priceListCreateSchema = z.object({
  name: z.string().trim().min(2).max(160), code: z.string().trim().min(2).max(32).toUpperCase(),
  currency: z.string().trim().length(3).toUpperCase().optional(), isDefault: z.boolean().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
