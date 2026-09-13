import { writeAudit } from "../audit/audit.service.js";
import { sendSuccess } from "../../shared/responses/index.js";
export const createRoleController = (service, prisma) => ({
  list: async (request, response) => sendSuccess(response, { data: await service.list(request.tenant.companyId) }),
  permissions: async (_request, response) => sendSuccess(response, { data: await service.permissions() }),
  create: async (request, response) => { const data = await service.create(request.tenant.companyId, request.validated.body);
    await writeAudit(prisma, request, { action: "CREATE", entity: "Role", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data }); },
  update: async (request, response) => { const result = await service.update(request.tenant.companyId, request.params.id, request.validated.body);
    await writeAudit(prisma, request, { action: "UPDATE", entity: "Role", entityId: result.data.id, before: result.before, after: result.data }); return sendSuccess(response, { data: result.data }); },
  delete: async (request, response) => { await service.delete(request.tenant.companyId, request.params.id);
    await writeAudit(prisma, request, { action: "DELETE", entity: "Role", entityId: request.params.id }); return sendSuccess(response, { data: { deleted: true } }); },
});
