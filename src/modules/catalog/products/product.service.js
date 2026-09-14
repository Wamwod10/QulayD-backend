import { NotFoundError } from "../../../shared/errors/index.js";
import { paginationMeta, parsePagination } from "../../../shared/pagination/index.js";

export function createProductService(repository) {
  return {
    async list(companyId, query) {
      const page = parsePagination(query, { allowedSortFields: ["createdAt", "updatedAt", "name", "sku", "costPrice"] });
      const where = {};
      if (query.status) where.status = query.status;
      if (query.categoryId) where.categoryId = query.categoryId;
      if (query.warehouseId) where.stocks = { some: { warehouseId: query.warehouseId } };
      if (page.search) where.OR = [
        { name: { contains: page.search, mode: "insensitive" } },
        { sku: { contains: page.search } },
        { barcodes: { some: { barcode: { contains: page.search } } } },
        { variants: { some: { OR: [{ name: { contains: page.search, mode: "insensitive" } }, { sku: { contains: page.search } }] } } },
        { serials: { some: { OR: [{ serial: { contains: page.search, mode: "insensitive" } }, { imei: { contains: page.search } }] } } },
      ];
      const result = await repository.list(companyId, {
        where, skip: page.skip, take: page.take, orderBy: { [page.sortBy || "createdAt"]: page.sortOrder },
      });
      return { ...result, meta: paginationMeta({ ...page, total: result.total }) };
    },
    async find(companyId, id) {
      const product = await repository.find(companyId, id);
      if (!product) throw new NotFoundError("Product not found");
      return product;
    },
    create: (companyId, employeeId, input) => repository.create(companyId, employeeId, input),
    async update(companyId, id, input) {
      const result = await repository.update(companyId, id, input);
      if (!result) throw new NotFoundError("Product not found");
      return result;
    },
    async archive(companyId, id) {
      const result = await repository.archive(companyId, id);
      if (!result.count) throw new NotFoundError("Product not found");
    },
  };
}
