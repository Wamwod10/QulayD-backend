import { ACTIONS, MODULES } from "../../shared/constants/permissions.js";

export async function ensurePermissionCatalog(prisma) {
  const definitions = MODULES.flatMap((module) => ACTIONS.map((action) => ({
    code: `${module}.${action}`, module, action, description: `${action} access for ${module}`,
  })));
  await prisma.permission.createMany({ data: definitions, skipDuplicates: true });
  return prisma.permission.findMany({ where: { code: { in: definitions.map(({ code }) => code) } } });
}

export async function ensureCompanyRoles(prisma, companyId) {
  const permissions = await ensurePermissionCatalog(prisma);
  const definitions = [
    { code: "OWNER", name: "Owner", permissions },
    { code: "ADMIN", name: "Administrator", permissions },
    { code: "EMPLOYEE", name: "Employee", permissions: permissions.filter(({ action }) => action === "read") },
  ];
  const roles = [];
  for (const definition of definitions) {
    const role = await prisma.role.upsert({
      where: { companyId_code: { companyId, code: definition.code } },
      create: { companyId, code: definition.code, name: definition.name, isSystem: true },
      update: { name: definition.name, isSystem: true },
    });
    await prisma.rolePermission.createMany({
      data: definition.permissions.map(({ id: permissionId }) => ({ roleId: role.id, permissionId })), skipDuplicates: true,
    });
    roles.push(role);
  }
  return roles;
}
