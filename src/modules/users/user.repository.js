const include = {
  branch: true, warehouse: true, modules: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
};

async function verifyRoles(tx, companyId, roleIds) {
  const count = await tx.role.count({ where: { id: { in: roleIds }, OR: [{ companyId }, { companyId: null }] } });
  return count === roleIds.length;
}

async function verifyAssignment(tx, companyId, data) {
  const [branch, warehouse, employeeType] = await Promise.all([
    data.branchId ? tx.branch.count({ where: { id: data.branchId, companyId, deletedAt: null } }) : 1,
    data.warehouseId ? tx.warehouse.count({ where: { id: data.warehouseId, companyId, deletedAt: null,
      ...(data.branchId ? { OR: [{ branchId: data.branchId }, { branchId: null }] } : {}) } }) : 1,
    data.employeeTypeId ? tx.employeeType.count({ where: { id: data.employeeTypeId, companyId } }) : 1,
  ]);
  return branch === 1 && warehouse === 1 && employeeType === 1;
}

export function createUserRepository(prisma) {
  return {
    async list(companyId, { where, skip, take, orderBy }) {
      const scope = { companyId, deletedAt: null, ...where };
      const [data, total] = await prisma.$transaction([
        prisma.employee.findMany({ where: scope, include, skip, take, orderBy }), prisma.employee.count({ where: scope }),
      ]);
      return { data, total };
    },
    find(companyId, id) { return prisma.employee.findFirst({ where: { companyId, id, deletedAt: null }, include }); },
    roleCodes(companyId, roleIds) { return prisma.role.findMany({ where: { id: { in: roleIds }, OR: [{ companyId }, { companyId: null }] }, select: { code: true } }); },
    create(companyId, data, roleIds, modules) {
      return prisma.$transaction(async (tx) => {
        if (!(await verifyRoles(tx, companyId, roleIds)) || !(await verifyAssignment(tx, companyId, data))) return null;
        return tx.employee.create({ data: {
          ...data, companyId, roles: { create: roleIds.map((roleId) => ({ roleId })) },
          modules: { create: modules.map((module) => ({ module, enabled: true })) },
        }, include });
      });
    },
    update(companyId, id, data, roleIds, modules) {
      return prisma.$transaction(async (tx) => {
        const before = await tx.employee.findFirst({ where: { id, companyId, deletedAt: null }, include });
        if (!before) return null;
        if (roleIds && !(await verifyRoles(tx, companyId, roleIds))) return { invalidRoles: true };
        if (!(await verifyAssignment(tx, companyId, { branchId: data.branchId === undefined ? before.branchId : data.branchId,
          warehouseId: data.warehouseId === undefined ? before.warehouseId : data.warehouseId,
          employeeTypeId: data.employeeTypeId === undefined ? before.employeeTypeId : data.employeeTypeId }))) return { invalidAssignment: true };
        if (roleIds) {
          await tx.employeeRole.deleteMany({ where: { employeeId: id } });
          await tx.employeeRole.createMany({ data: roleIds.map((roleId) => ({ employeeId: id, roleId })) });
        }
        if (modules) {
          await tx.employeeModule.deleteMany({ where: { employeeId: id } });
          if (modules.length) await tx.employeeModule.createMany({ data: modules.map((module) => ({ employeeId: id, module })) });
        }
        const employee = await tx.employee.update({ where: { id }, data, include });
        return { before, employee };
      });
    },
    resetPassword(companyId, id, passwordHash, mustChangePassword) {
      return prisma.employee.updateMany({ where: { id, companyId, deletedAt: null }, data: {
        passwordHash, mustChangePassword, tokenVersion: { increment: 1 },
      } });
    },
  };
}
