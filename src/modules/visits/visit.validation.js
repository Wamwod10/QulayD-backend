import { z } from "zod";
export const visitCreateSchema = z.object({ employeeId: z.uuid().optional(), customerId: z.uuid(), note: z.string().max(1000).optional() });
export const visitLocationSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), note: z.string().max(1000).optional() });
