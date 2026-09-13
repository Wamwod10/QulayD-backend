export const INVOICE_INCLUDE = Object.freeze({ customer: true, order: true, items: true, allocations: { include: { payment: true } }, debts: true });
