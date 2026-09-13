import { z } from "zod";
export const unitCreateSchema = z.object({
  name: z.string().trim().min(1).max(80), shortName: z.string().trim().min(1).max(16),
  precision: z.number().int().min(0).max(6).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
