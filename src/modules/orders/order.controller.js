import { writeAudit } from "../audit/audit.service.js";
import { sendSuccess } from "../../shared/responses/index.js";
export function createOrderController(service, prisma) {
  const transition = (action, auditAction) => async (request, response) => {
    const data = await service[action](request.tenant.companyId, request.params.id, request.auth.employeeId, request.validated.body.note);
    await writeAudit(prisma, request, { action: auditAction, entity: "Order", entityId: data.id, after: data });
    return sendSuccess(response, { data });
  };
  return {
    list: async (request, response) => { const result = await service.list(request.tenant.companyId, request.validated.query); return sendSuccess(response, result); },
    find: async (request, response) => sendSuccess(response, { data: await service.find(request.tenant.companyId, request.params.id) }),
    create: async (request, response) => { const data = await service.create(request.tenant.companyId, request.auth.employeeId, request.validated.body);
      await writeAudit(prisma, request, { action: "CREATE", entity: "Order", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data }); },
    update: async (request, response) => { const before = await service.find(request.tenant.companyId, request.params.id);
      const data = await service.update(request.tenant.companyId, request.params.id, request.auth.employeeId, request.validated.body);
      await writeAudit(prisma, request, { action: "UPDATE", entity: "Order", entityId: data.id, before, after: data }); return sendSuccess(response, { data }); },
    confirm: transition("confirm", "CONFIRM"), startPicking: transition("startPicking", "START_PICKING"),
    completePicking: transition("completePicking", "COMPLETE_PICKING"), pack: transition("pack", "PACK"),
    ready: transition("ready", "READY"), complete: transition("complete", "COMPLETE"), cancel: transition("cancel", "CANCEL"),
  };
}
