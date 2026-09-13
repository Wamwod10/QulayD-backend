import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { priceListCreateSchema } from "./pricing.validation.js";
export const createPricingRouter = ({ prisma }) => createTenantCrudRouter({
  prisma, model: "priceList", entity: "PriceList", module: "sales", permission: "sales",
  createSchema: priceListCreateSchema, searchFields: ["name", "code"], filterFields: ["status", "currency"],
  include: { prices: { where: { validTo: null }, include: { product: true } } }, softDelete: false,
  beforeCreate: async (payload) => {
    if (payload.isDefault) await prisma.priceList.updateMany({ where: { companyId: payload.companyId }, data: { isDefault: false } });
    return payload;
  },
  beforeUpdate: async (payload, request) => {
    if (payload.isDefault) await prisma.priceList.updateMany({ where: { companyId: request.tenant.companyId }, data: { isDefault: false } });
    return payload;
  },
});
