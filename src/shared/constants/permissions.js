export const MODULES = Object.freeze([
  "dashboard", "sales", "pos", "inventory", "partners", "agents",
  "routes", "fulfillment", "delivery", "finance", "reports", "settings",
]);
export const ACTIONS = Object.freeze(["read", "create", "update", "delete", "approve", "export"]);
export const PERMISSIONS = Object.freeze(Object.fromEntries(
  MODULES.flatMap((module) => ACTIONS.map((action) => [
    `${module}.${action}`.toUpperCase().replace(".", "_"), `${module}.${action}`,
  ])),
));
