import { z } from "zod";

const password = z.string().min(6, "Password must contain at least 6 characters").max(128);
const normalizeIdentifier = (value) => {
  const trimmed = value.trim();
  if (/^[+\d ()-]+$/.test(trimmed)) return `${trimmed.startsWith("+") ? "+" : ""}${trimmed.replace(/\D/g, "")}`;
  return trimmed.toLowerCase();
};
const identifier = z.string().trim().min(3).max(160).transform(normalizeIdentifier);
const device = {
  deviceId: z.string().trim().min(3).max(200),
  deviceName: z.string().trim().max(200).optional(),
};

export const registerOwnerSchema = z.object({
  companyName: z.string().trim().min(2).max(160),
  name: z.string().trim().min(2).max(160),
  login: z.string().trim().min(3).max(80).toLowerCase().optional(),
  phone: z.string().trim().min(7).max(32).transform(normalizeIdentifier).optional(),
  email: z.email().toLowerCase().optional(),
  password,
  ...device,
}).refine((value) => value.login || value.phone || value.email, { message: "Login, phone or email is required" });

export const loginSchema = z.object({ identifier, password: z.string().min(1).max(128), ...device });
export const pinLoginSchema = z.object({ identifier, pin: z.string().regex(/^\d{6}$/), ...device });
export const refreshSchema = z.object({ refreshToken: z.string().min(20).optional() });
export const forgotPasswordSchema = z.object({ identifier });
export const resetPasswordSchema = z.object({ token: z.string().min(20), newPassword: password });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });

export const authSchemas = {
  registerOwner: { body: registerOwnerSchema }, login: { body: loginSchema }, pinLogin: { body: pinLoginSchema },
  refresh: { body: refreshSchema }, forgot: { body: forgotPasswordSchema }, reset: { body: resetPasswordSchema },
  change: { body: changePasswordSchema },
};
