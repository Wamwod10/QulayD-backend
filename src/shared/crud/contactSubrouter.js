import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { writeAudit } from "../../modules/audit/audit.service.js";
import { NotFoundError } from "../errors/index.js";
import { sendSuccess } from "../responses/index.js";
import { asyncHandler } from "../utils/index.js";

const params = z.object({ id: z.uuid(), contactId: z.uuid().optional() });
const contactSchema = z.object({
  name: z.string().trim().min(2).max(160), position: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(), email: z.email().optional(), isPrimary: z.boolean().optional(),
});

export function createContactSubrouter({ prisma, parentModel, parentField, entity }) {
  const router = Router({ mergeParams: true });
  const assertParent = async (companyId, id) => {
    const found = await prisma[parentModel].count({ where: { id, companyId, deletedAt: null } });
    if (!found) throw new NotFoundError(`${entity} not found`);
  };
  router.get("/", requirePermission("partners.read"), asyncHandler(async (request, response) => {
    await assertParent(request.tenant.companyId, request.params.id);
    return sendSuccess(response, { data: await prisma.contact.findMany({ where: { companyId: request.tenant.companyId, [parentField]: request.params.id }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }] }) });
  }));
  router.post("/", requirePermission("partners.create"), validate({ body: contactSchema }), asyncHandler(async (request, response) => {
    await assertParent(request.tenant.companyId, request.params.id);
    const data = await prisma.contact.create({ data: { ...request.validated.body, companyId: request.tenant.companyId, [parentField]: request.params.id } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "Contact", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  router.patch("/:contactId", requirePermission("partners.update"), validate({ params, body: contactSchema.partial() }), asyncHandler(async (request, response) => {
    const before = await prisma.contact.findFirst({ where: { id: request.params.contactId, companyId: request.tenant.companyId, [parentField]: request.params.id } });
    if (!before) throw new NotFoundError("Contact not found");
    const data = await prisma.contact.update({ where: { id: before.id }, data: request.validated.body });
    await writeAudit(prisma, request, { action: "UPDATE", entity: "Contact", entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  }));
  router.delete("/:contactId", requirePermission("partners.delete"), validate({ params }), asyncHandler(async (request, response) => {
    const before = await prisma.contact.findFirst({ where: { id: request.params.contactId, companyId: request.tenant.companyId, [parentField]: request.params.id } });
    if (!before) throw new NotFoundError("Contact not found");
    await prisma.contact.delete({ where: { id: before.id } });
    await writeAudit(prisma, request, { action: "DELETE", entity: "Contact", entityId: before.id, before });
    return sendSuccess(response, { data: { deleted: true } });
  }));
  return router;
}
