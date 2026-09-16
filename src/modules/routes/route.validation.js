import { z } from "zod";

const stops = z.array(z.object({ customerId: z.uuid(), stopOrder: z.number().int().positive() })).min(1).max(500)
  .superRefine((rows, context) => {
    for (const field of ["customerId", "stopOrder"]) if (new Set(rows.map((row) => row[field])).size !== rows.length) {
      context.addIssue({ code: "custom", message: `Duplicate ${field} in route stops` });
    }
  });

const routeTemplateBaseSchema = z.object({
  territoryId: z.uuid().nullable().optional(),
  agentId: z.uuid().nullable().optional(),
  name: z.string().trim().min(2).max(160),
  dayOfWeek: z.number().int().min(1).max(7).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  stops,
});

export const routeTemplateSchema = routeTemplateBaseSchema;
export const routeTemplateUpdateSchema = routeTemplateBaseSchema.partial();

export const routePlanSchema = z.object({
  templateId: z.uuid().nullable().optional(),
  agentId: z.uuid().nullable().optional(),
  name: z.string().trim().min(2).max(160).optional(),
  planDate: z.coerce.date(),
  stops: stops.optional(),
}).superRefine((input, context) => {
  if (!input.templateId && !input.stops?.length) {
    context.addIssue({ code: "custom", path: ["stops"], message: "Template or route stops are required" });
  }
  if (!input.templateId && !input.agentId) {
    context.addIssue({ code: "custom", path: ["agentId"], message: "Agent is required for a custom route plan" });
  }
});

export const territorySchema = z.object({
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(2).max(32).toUpperCase(),
  geometry: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
