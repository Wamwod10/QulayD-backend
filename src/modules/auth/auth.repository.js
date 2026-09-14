import { ensureCompanyRoles } from "../access-control/access-control.bootstrap.js";

export function createAuthRepository(prisma) {
  const accessInclude = {
    company: true,
    branch: true, warehouse: true, employeeType: true,
    roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    modules: true,
  };
  return {
    findByIdentifier(identifier) {
      return prisma.employee.findFirst({
        where: { deletedAt: null, OR: [{ login: identifier }, { phone: identifier }, { email: identifier }] },
        include: accessInclude,
      });
    },
    findById(id) { return prisma.employee.findUnique({ where: { id }, include: accessInclude }); },
    createCompanyOwner(data) {
      return prisma.$transaction(async (tx) => {
        const company = await tx.company.create({ data: data.company });
        const roles = await ensureCompanyRoles(tx, company.id);
        const role = roles.find(({ code }) => code === "OWNER");
        const employee = await tx.employee.create({
          data: { ...data.employee, companyId: company.id, status: "ACTIVE", roles: { create: { roleId: role.id } } },
          include: accessInclude,
        });
        await tx.settings.create({ data: { companyId: company.id, data: data.settings } });
        const branch = await tx.branch.create({ data: { companyId: company.id, name: "Bosh filial", code: "MAIN" } });
        const warehouse = await tx.warehouse.create({ data: { companyId: company.id, branchId: branch.id, name: "Markaziy ombor", code: "MAIN" } });
        await tx.unit.create({ data: { companyId: company.id, name: "Dona", shortName: "dona" } });
        await tx.priceList.createMany({ data: [
          { companyId: company.id, name: "Sotuv narxi", code: "RETAIL", isDefault: true },
          { companyId: company.id, name: "Ulgurji narx", code: "WHOLESALE" },
        ] });
        const cashbox = await tx.cashbox.create({ data: { companyId: company.id, branchId: branch.id, warehouseId: warehouse.id, name: "Asosiy kassa", code: "MAIN" } });
        await tx.paymentMethodConfig.createMany({ data: [
          { companyId: company.id, code: "CASH", name: "Naqd", method: "CASH", shortcut: "F1" },
          { companyId: company.id, code: "CARD", name: "Bank karta", method: "CARD", shortcut: "F2" },
          { companyId: company.id, code: "QR", name: "QR", method: "QR", shortcut: "F3" },
          { companyId: company.id, code: "BANK", name: "Bank o'tkazmasi", method: "BANK" },
          { companyId: company.id, code: "CREDIT", name: "Nasiya", method: "CREDIT" },
        ] });
        const readyEmployee = await tx.employee.update({ where: { id: employee.id }, data: { branchId: branch.id, warehouseId: warehouse.id }, include: accessInclude });
        return { company, employee: readyEmployee, branch, warehouse, cashbox };
      });
    },
    updateEmployee(id, data) { return prisma.employee.update({ where: { id }, data, include: accessInclude }); },
    createSession(data) { return prisma.session.create({ data }); },
    findSession(id) { return prisma.session.findUnique({ where: { id } }); },
    rotateSession(id, data) { return prisma.session.update({ where: { id }, data }); },
    revokeSession(id, reason = "LOGOUT") {
      return prisma.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
    },
    revokeAllSessions(employeeId, reason) {
      return prisma.session.updateMany({ where: { employeeId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
    },
    listSessions(employeeId) { return prisma.session.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" }, select: {
      id: true, deviceId: true, deviceName: true, userAgent: true, ipAddress: true, expiresAt: true,
      lastUsedAt: true, revokedAt: true, revokeReason: true, createdAt: true,
    } }); },
    revokeOwnSession(employeeId, id, reason = "USER_REVOKED") {
      return prisma.session.updateMany({ where: { id, employeeId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
    },
    createResetToken(data) { return prisma.passwordResetToken.create({ data }); },
    findResetToken(tokenHash) { return prisma.passwordResetToken.findUnique({ where: { tokenHash } }); },
    useResetToken(id) { return prisma.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } }); },
  };
}
