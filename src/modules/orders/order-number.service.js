import { nextDocumentNumber } from "../../shared/documents/index.js";
export const nextOrderNumber = (prisma, companyId) => nextDocumentNumber(prisma, companyId, "ORDER", "ORD");
