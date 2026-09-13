export async function writeAudit(prisma, request, { action, entity, entityId, before, after, metadata = {} }) {
  const json = (value) => value == null ? undefined : JSON.parse(JSON.stringify(value));
  try {
    await prisma.auditLog.create({ data: {
      companyId: request.auth?.companyId,
      employeeId: request.auth?.employeeId,
      action, entity, entityId,
      before: json(before), after: json(after), metadata: json(metadata),
      ipAddress: request.ip, userAgent: request.get("user-agent"), requestId: request.id,
    } });
  } catch (error) {
    request.log?.error?.({ error }, "Audit log write failed");
    throw error;
  }
}
