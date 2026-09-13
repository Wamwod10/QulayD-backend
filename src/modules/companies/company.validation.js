import { z } from "zod";
export const companyUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(), legalName: z.string().trim().max(200).nullable().optional(),
  taxId: z.string().trim().max(40).nullable().optional(), phone: z.string().trim().max(32).nullable().optional(),
  email: z.email().nullable().optional(), address: z.string().trim().max(500).nullable().optional(),
});
