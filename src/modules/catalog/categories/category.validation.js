import { z } from "zod";
export const categoryCreateSchema = z.object({
  name: z.string().trim().min(2).max(160), code: z.string().trim().min(1).max(32).toUpperCase().optional(),
  parentId: z.uuid().nullable().optional(), description: z.string().trim().max(500).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
