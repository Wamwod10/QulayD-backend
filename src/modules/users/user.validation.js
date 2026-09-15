import { z } from "zod";
import { MODULES } from "../../shared/constants/permissions.js";
const password = z.string().min(6, "Password must contain at least 6 characters").max(128);
const pin = z.string().regex(/^\d{6}$/, "PIN must contain exactly 6 digits");
const normalizePhone = (value) => `${value.trim().startsWith("+") ? "+" : ""}${value.replace(/\D/g, "")}`;
const employeeBaseSchema = z.object({
  name: z.string().trim().min(2).max(160), title: z.string().trim().max(120).optional(),
  login: z.string().trim().min(3).max(80).toLowerCase().optional(), phone: z.string().trim().min(7).max(32).transform(normalizePhone).optional(),
  email: z.email().toLowerCase().optional(), password, pin: pin.optional(),
  branchId: z.uuid().nullable().optional(), warehouseId: z.uuid().nullable().optional(), employeeTypeId: z.uuid().nullable().optional(),
  status: z.enum(["INVITED", "ACTIVE", "BLOCKED"]).optional(),
  roleIds: z.array(z.uuid()).min(1).max(20), modules: z.array(z.enum(MODULES)).max(MODULES.length).optional(),
});
export const employeeCreateSchema = employeeBaseSchema.extend({ pin })
  .refine((value) => value.login || value.phone || value.email, { message: "Login, phone or email is required" })
  .superRefine((value, context) => {
    if (new Set(value.roleIds).size !== value.roleIds.length) context.addIssue({ code: "custom", path: ["roleIds"], message: "Roles must be unique" });
    if (value.modules && new Set(value.modules).size !== value.modules.length) context.addIssue({ code: "custom", path: ["modules"], message: "Modules must be unique" });
  });
export const employeeUpdateSchema = employeeBaseSchema.omit({ password: true }).partial();
export const employeePasswordSchema = z.object({ password, mustChangePassword: z.boolean().optional() });
