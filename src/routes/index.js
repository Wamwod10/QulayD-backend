import { Router } from "express";

import { checkDatabaseConnection } from "../database/index.js";
import { getPrisma } from "../database/index.js";
import { createAccessControlRouter } from "../modules/access-control/index.js";
import { createAgentRouter } from "../modules/agents/index.js";
import { createApprovalRouter } from "../modules/approvals/index.js";
import { createAuditRouter } from "../modules/audit/index.js";
import { createAuthRouter } from "../modules/auth/index.js";
import { createBranchRouter } from "../modules/branches/index.js";
import { createCatalogRouter } from "../modules/catalog/index.js";
import { createCompanyRouter } from "../modules/companies/index.js";
import { createCustomerRouter } from "../modules/customers/index.js";
import { createDashboardRouter } from "../modules/dashboard/index.js";
import { createDeliveryRouter } from "../modules/delivery/index.js";
import { createFulfillmentRouter } from "../modules/fulfillment/index.js";
import { createHealthRouter } from "../modules/health/index.js";
import { createInventoryRouter } from "../modules/inventory/index.js";
import { createInvoiceRouter } from "../modules/invoicing/index.js";
import { createLedgerRouter } from "../modules/ledger/index.js";
import { createNotificationRouter } from "../modules/notifications/index.js";
import { createOrderRouter } from "../modules/orders/index.js";
import { createPaymentRouter } from "../modules/payments/index.js";
import { createPosRouter } from "../modules/pos/index.js";
import { createPricingRouter } from "../modules/pricing/index.js";
import { createReportRouter } from "../modules/reports/index.js";
import { createReturnRouter } from "../modules/returns/index.js";
import { createRouteRouter } from "../modules/routes/index.js";
import { createSearchRouter } from "../modules/search/index.js";
import { createSettingsRouter } from "../modules/settings/index.js";
import { createSupplierRouter } from "../modules/suppliers/index.js";
import { createUploadRouter } from "../modules/uploads/index.js";
import { createUserRouter } from "../modules/users/index.js";
import { createVisitRouter } from "../modules/visits/index.js";
import { createWorkforceRouter } from "../modules/workforce/index.js";
import { createAuthenticate, createIdempotencyMiddleware, tenantContext } from "../middlewares/index.js";
import { sendSuccess } from "../shared/responses/successResponse.js";
import { NotFoundError } from "../shared/errors/index.js";

const PROTECTED_ROOTS = new Set(["dashboard", "companies", "branches", "access", "employees", "catalog", "inventory",
  "pricing", "customers", "suppliers", "orders", "pos", "payments", "invoices", "finance", "reports", "fulfillment",
  "delivery", "returns", "agents", "routes", "visits", "search", "notifications", "audit", "settings", "uploads", "workforce", "approvals"]);

export function createApiRouter({
  databaseHealthCheck = checkDatabaseConnection,
  prisma = getPrisma(),
} = {}) {
  const router = Router();

  router.get("/", (_request, response) => sendSuccess(response, {
    data: {
      service: "qulay-backend",
      apiVersion: "v1",
      documentation: "/docs",
    },
  }));

  router.use(createHealthRouter({ databaseHealthCheck }));
  const dependencies = { prisma };
  const authenticate = createAuthenticate(prisma);
  router.use("/auth", createAuthRouter({ prisma, authenticate }));
  router.use((request, _response, next) => {
    const root = request.path.split("/").filter(Boolean)[0];
    return PROTECTED_ROOTS.has(root) ? next() : next(new NotFoundError(`Route ${request.method} ${request.originalUrl} was not found`));
  });
  router.use(authenticate, tenantContext, createIdempotencyMiddleware(prisma));
  router.use("/dashboard", createDashboardRouter(dependencies));
  router.use("/companies", createCompanyRouter(dependencies));
  router.use("/branches", createBranchRouter(dependencies));
  router.use("/access", createAccessControlRouter(dependencies));
  router.use("/employees", createUserRouter(dependencies));
  router.use("/catalog", createCatalogRouter(dependencies));
  router.use("/inventory", createInventoryRouter(dependencies));
  router.use("/pricing", createPricingRouter(dependencies));
  router.use("/customers", createCustomerRouter(dependencies));
  router.use("/suppliers", createSupplierRouter(dependencies));
  router.use("/orders", createOrderRouter(dependencies));
  router.use("/pos", createPosRouter(dependencies));
  router.use("/payments", createPaymentRouter(dependencies));
  router.use("/invoices", createInvoiceRouter(dependencies));
  router.use("/finance", createLedgerRouter(dependencies));
  router.use("/reports", createReportRouter(dependencies));
  router.use("/fulfillment", createFulfillmentRouter(dependencies));
  router.use("/delivery", createDeliveryRouter(dependencies));
  router.use("/returns", createReturnRouter(dependencies));
  router.use("/agents", createAgentRouter(dependencies));
  router.use("/routes", createRouteRouter(dependencies));
  router.use("/visits", createVisitRouter(dependencies));
  router.use("/search", createSearchRouter(dependencies));
  router.use("/notifications", createNotificationRouter(dependencies));
  router.use("/audit", createAuditRouter(dependencies));
  router.use("/settings", createSettingsRouter(dependencies));
  router.use("/uploads", createUploadRouter(dependencies));
  router.use("/workforce", createWorkforceRouter(dependencies));
  router.use("/approvals", createApprovalRouter(dependencies));

  return router;
}

export default createApiRouter;
