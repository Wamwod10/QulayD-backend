import { z } from "zod";
export const warehouseCreateSchema = z.object({
  branchId: z.uuid().nullable().optional(), name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(2).max(32).toUpperCase(), address: z.string().trim().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
