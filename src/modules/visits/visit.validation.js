import { z } from "zod";

export const visitCreateSchema = z.object({
  employeeId: z.uuid().optional(),
  customerId: z.uuid(),
  note: z.string().trim().max(1000).optional(),
});

export const visitLocationSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  note: z.string().trim().max(1000).optional(),
}).superRefine((input, context) => {
  const hasLatitude = input.latitude !== undefined;
  const hasLongitude = input.longitude !== undefined;
  if (hasLatitude !== hasLongitude) context.addIssue({ code: "custom", message: "Latitude and longitude must be provided together" });
});
