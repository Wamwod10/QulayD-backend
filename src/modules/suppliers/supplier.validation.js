import { z } from "zod";
export const supplierCreateSchema = z.object({
  code: z.string().trim().min(1).max(40).toUpperCase(), name: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(32).optional(), email: z.email().optional(), address: z.string().trim().max(500).optional(),
  taxId: z.string().trim().max(40).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
