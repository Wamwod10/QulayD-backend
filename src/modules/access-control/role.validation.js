import { z } from "zod";
const roleBaseSchema = z.object({
  code: z.string().trim().min(2).max(50).regex(/^[A-Z][A-Z0-9_]*$/),
  name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).optional(),
  permissionCodes: z.array(z.string().trim().min(3).max(100)).max(100),
});
const uniquePermissions = (value, context) => {
  if (value.permissionCodes && new Set(value.permissionCodes).size !== value.permissionCodes.length) context.addIssue({ code: "custom", path: ["permissionCodes"], message: "Permission codes must be unique" });
};
export const roleCreateSchema = roleBaseSchema.superRefine(uniquePermissions);
export const roleUpdateSchema = roleBaseSchema.omit({ code: true }).partial().superRefine(uniquePermissions);
