import { z } from "zod";
export const customerCreateSchema = z.object({
  code: z.string().trim().min(1).max(40).toUpperCase(), name: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(32).optional(), email: z.email().optional(), address: z.string().trim().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  taxId: z.string().trim().max(40).optional(), creditLimit: z.number().min(0).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
});
