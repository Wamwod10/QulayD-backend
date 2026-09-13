const include = { permissions: { include: { permission: true } }, _count: { select: { employees: true } } };
export function createRoleRepository(prisma) {
  const permissionIds = async (tx, codes) => tx.permission.findMany({ where: { code: { in: codes } }, select: { id: true } });
  return {
    list(companyId) { return prisma.role.findMany({ where: { OR: [{ companyId }, { companyId: null }] }, include, orderBy: { name: "asc" } }); },
    create(companyId, input) { return prisma.$transaction(async (tx) => {
      const permissions = await permissionIds(tx, input.permissionCodes);
      if (permissions.length !== input.permissionCodes.length) return null;
      return tx.role.create({ data: { companyId, code: input.code, name: input.name, description: input.description,
        permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) } }, include });
    }); },
    update(companyId, id, input) { return prisma.$transaction(async (tx) => {
      const current = await tx.role.findFirst({ where: { id, companyId, isSystem: false }, include });
      if (!current) return null;
      const { permissionCodes, ...data } = input;
      if (permissionCodes) {
        const permissions = await permissionIds(tx, permissionCodes);
        if (permissions.length !== permissionCodes.length) return { invalidPermissions: true };
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (permissions.length) await tx.rolePermission.createMany({ data: permissions.map(({ id: permissionId }) => ({ roleId: id, permissionId })) });
      }
      return { before: current, data: await tx.role.update({ where: { id }, data, include }) };
    }); },
    delete(companyId, id) { return prisma.role.deleteMany({ where: { id, companyId, isSystem: false, employees: { none: {} } } }); },
    permissions() { return prisma.permission.findMany({ orderBy: [{ module: "asc" }, { action: "asc" }] }); },
  };
}
