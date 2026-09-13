import { writeAudit } from "../audit/audit.service.js";
import { sendSuccess } from "../../shared/responses/index.js";
export const createUserController = (service, prisma) => ({
  list: async (request, response) => { const result = await service.list(request.tenant.companyId, request.validated.query); return sendSuccess(response, result); },
  find: async (request, response) => sendSuccess(response, { data: await service.find(request.tenant.companyId, request.params.id) }),
  create: async (request, response) => {
    const data = await service.create(request.tenant.companyId, request.validated.body, request.auth.user.roles);
    await writeAudit(prisma, request, { action: "CREATE", entity: "Employee", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  },
  update: async (request, response) => {
    const result = await service.update(request.tenant.companyId, request.params.id, request.validated.body, request.auth.user.roles);
    await writeAudit(prisma, request, { action: "UPDATE", entity: "Employee", entityId: result.data.id, before: result.before, after: result.data });
    return sendSuccess(response, { data: result.data });
  },
  resetPassword: async (request, response) => {
    await service.resetPassword(request.tenant.companyId, request.params.id, request.validated.body, request.auth.user.roles);
    await writeAudit(prisma, request, { action: "RESET_PASSWORD", entity: "Employee", entityId: request.params.id });
    return sendSuccess(response, { data: { reset: true } });
  },
});
