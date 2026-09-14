export const EMPLOYEE_WORKSPACES = Object.freeze({
  agent_workspace: {
    label: "Agent ish joyi",
    modules: ["agents", "routes", "partners", "sales", "finance"],
    permissions: [
      "agents.read", "agents.create", "agents.update",
      "routes.read",
      "partners.read", "partners.create", "partners.update",
      "sales.read", "sales.create", "sales.update",
      "finance.read", "finance.create",
    ],
  },
  warehouse_workspace: {
    label: "Omborchi ish joyi",
    modules: ["inventory", "fulfillment"],
    permissions: [
      "inventory.read", "inventory.create", "inventory.update",
      "fulfillment.read", "fulfillment.update",
    ],
  },
  fulfillment_workspace: {
    label: "Yig‘uvchi / Qadoqlovchi ish joyi",
    modules: ["fulfillment", "inventory"],
    permissions: ["fulfillment.read", "fulfillment.update", "inventory.read"],
  },
  driver_workspace: {
    label: "Haydovchi ish joyi",
    modules: ["delivery", "routes"],
    permissions: ["delivery.read", "delivery.update", "routes.read"],
  },
  sales_operator_workspace: {
    label: "Sotuv operatori ish joyi",
    modules: ["sales", "partners", "inventory"],
    permissions: [
      "sales.read", "sales.create", "sales.update",
      "partners.read", "partners.create", "partners.update",
      "inventory.read",
    ],
  },
  cashier_workspace: {
    label: "Kassir / Inkassator ish joyi",
    modules: ["pos", "finance", "partners"],
    permissions: [
      "pos.read", "pos.create", "pos.update",
      "finance.read", "finance.create",
      "partners.read",
    ],
  },
});

export const WORKSPACE_MODULES = Object.freeze(Object.keys(EMPLOYEE_WORKSPACES));

export function workspaceAllowsModule(userModules = [], module) {
  return userModules.some((workspaceKey) => EMPLOYEE_WORKSPACES[workspaceKey]?.modules.includes(module));
}

export function workspaceAllowsPermission(userModules = [], permission) {
  return userModules.some((workspaceKey) => EMPLOYEE_WORKSPACES[workspaceKey]?.permissions.includes(permission));
}
