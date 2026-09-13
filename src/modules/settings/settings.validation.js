import { z } from "zod";
export const settingsUpdateSchema = z.object({
  data: z.record(z.string(), z.unknown()), version: z.number().int().positive(),
});
