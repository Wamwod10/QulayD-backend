import { z } from "zod";
export const branchCreateSchema = z.object({
  name: z.string().trim().min(2).max(160), code: z.string().trim().min(2).max(32).toUpperCase(),
  address: z.string().trim().max(500).optional(), phone: z.string().trim().max(32).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
