import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { env } from "../../config/env.js";
import { NotFoundError } from "../../shared/errors/index.js";

const root = path.resolve(env.UPLOAD_DIR);
export async function ensureUploadDirectory() { await fs.mkdir(root, { recursive: true }); }
export function uploadUrl(storageKey) {
  const relative = `/uploads/${storageKey}`;
  return env.UPLOAD_PUBLIC_BASE_URL ? `${env.UPLOAD_PUBLIC_BASE_URL.replace(/\/$/, "")}${relative}` : relative;
}
export async function processImage(prisma, companyId, employeeId, file, purpose) {
  await ensureUploadDirectory(); const storageKey = `${crypto.randomUUID()}.webp`; const target = path.join(root, storageKey);
  const pipeline = sharp(file.buffer, { failOn: "warning", limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 });
  const { size, width, height } = await pipeline.toFile(target); const checksum = crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex");
  const data = await prisma.upload.create({ data: { companyId, uploadedById: employeeId, purpose, originalName: file.originalname,
    storageKey, mimeType: "image/webp", size, width, height, checksum, status: "READY" } });
  return { ...data, url: uploadUrl(storageKey) };
}
export async function removeImage(prisma, companyId, id) {
  const upload = await prisma.upload.findFirst({ where: { id, companyId, deletedAt: null } }); if (!upload) throw new NotFoundError("Upload not found");
  await prisma.upload.update({ where: { id }, data: { status: "DELETED", deletedAt: new Date() } });
  await fs.unlink(path.join(root, path.basename(upload.storageKey))).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
