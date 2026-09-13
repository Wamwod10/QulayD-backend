import { z } from "zod";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().trim().max(200).optional(),
});

export function parsePagination(query = {}, { allowedSortFields = [] } = {}) {
  const parsed = paginationSchema.parse(query);
  const sortBy = allowedSortFields.includes(parsed.sortBy) ? parsed.sortBy : undefined;

  return {
    page: parsed.page,
    limit: parsed.limit,
    skip: (parsed.page - 1) * parsed.limit,
    take: parsed.limit,
    search: parsed.search,
    sortBy,
    sortOrder: parsed.sortOrder,
  };
}

export function paginationMeta({ page, limit, total }) {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  return {
    page,
    limit,
    total: normalizedTotal,
    totalPages: normalizedTotal === 0 ? 0 : Math.ceil(normalizedTotal / limit),
    hasNextPage: page * limit < normalizedTotal,
    hasPreviousPage: page > 1,
  };
}

export { paginationSchema };
