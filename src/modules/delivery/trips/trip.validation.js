import { z } from "zod";
export const tripCreateSchema = z.object({
  warehouseId: z.uuid(), driverEmployeeId: z.uuid().nullable().optional(), vehicle: z.string().trim().max(100).optional(),
  plannedKm: z.number().min(0).optional(), plannedMinutes: z.number().int().min(0).optional(),
  orderIds: z.array(z.uuid()).min(1).max(200),
});
