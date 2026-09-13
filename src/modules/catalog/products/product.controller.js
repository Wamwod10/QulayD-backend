import { writeAudit } from "../../audit/audit.service.js";
import { sendSuccess } from "../../../shared/responses/index.js";
export function createProductController(service, prisma) {
  return {
    list: async (request, response) => {
      const result = await service.list(request.tenant.companyId, request.validated.query);
      return sendSuccess(response, { data: result.data, meta: result.meta });
    },
    find: async (request, response) => sendSuccess(response, { data: await service.find(request.tenant.companyId, request.params.id) }),
    create: async (request, response) => {
      const data = await service.create(request.tenant.companyId, request.auth.employeeId, request.validated.body);
      await writeAudit(prisma, request, { action: "CREATE", entity: "Product", entityId: data.id, after: data });
      return sendSuccess(response, { statusCode: 201, data });
    },
    update: async (request, response) => {
      const result = await service.update(request.tenant.companyId, request.params.id, request.validated.body);
      await writeAudit(prisma, request, { action: "UPDATE", entity: "Product", entityId: result.data.id, before: result.before, after: result.data });
      return sendSuccess(response, { data: result.data });
    },
    archive: async (request, response) => {
      await service.archive(request.tenant.companyId, request.params.id);
      await writeAudit(prisma, request, { action: "DELETE", entity: "Product", entityId: request.params.id });
      return sendSuccess(response, { data: { archived: true } });
    },
  };
}
