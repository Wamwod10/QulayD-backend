import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";

const EPSILON = 0.01;
const include = {
  customer: true,
  supplier: true,
  order: true,
  employee: { select: { id: true, name: true } },
  allocations: { include: { invoice: true } },
  debtAllocations: { include: { debt: true } },
  receipt: true,
};

const asNumber = (value) => Number(value || 0);
const invoiceOutstanding = (invoice) => Math.max(0, asNumber(invoice.total) - asNumber(invoice.credited) - asNumber(invoice.paid));

async function companySettings(tx, companyId) {
  return (await tx.settings.findUnique({ where: { companyId }, select: { data: true } }))?.data || {};
}

async function employeeWorkspaceModules(tx, companyId, employeeId) {
  if (!employeeId) return [];
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, companyId, deletedAt: null, status: "ACTIVE" },
    select: { modules: { where: { enabled: true }, select: { module: true } } },
  });
  return employee?.modules?.map(({ module }) => module) || [];
}

export async function resolvePaymentMethod(tx, companyId, input) {
  const config = input.methodCode
    ? await tx.paymentMethodConfig.findFirst({ where: { companyId, code: input.methodCode, status: "ACTIVE" } })
    : await tx.paymentMethodConfig.findFirst({ where: { companyId, method: input.method, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!config) throw new ValidationError("Selected payment method is disabled or does not belong to company");
  if (config.method === "CREDIT") throw new ValidationError("Credit is a sale term, not a payment settlement method");
  return config;
}

async function validateShift(tx, { companyId, employeeId, shiftId, payment, method }) {
  if (method !== "CASH") return { shift: null, assetAccount: "CASH_AND_BANK" };
  const outgoing = Boolean(payment.supplierId);
  if (shiftId) {
    const shift = await tx.shift.findFirst({
      where: { id: shiftId, companyId, employeeId, status: "OPEN" },
      include: { cashbox: true },
    });
    if (!shift) throw new ValidationError("Selected cash shift is not your open shift");
    if (payment.orderId) {
      const order = await tx.order.findFirst({ where: { id: payment.orderId, companyId }, select: { warehouseId: true, branchId: true } });
      if (order?.warehouseId && shift.cashbox.warehouseId && order.warehouseId !== shift.cashbox.warehouseId) throw new ValidationError("Cash shift belongs to a different warehouse");
      if (order?.branchId && shift.cashbox.branchId && order.branchId !== shift.cashbox.branchId) throw new ValidationError("Cash shift belongs to a different branch");
    }
    if (outgoing && asNumber(shift.expectedCash) + EPSILON < asNumber(payment.amount)) throw new ConflictError("Cashbox has insufficient cash");
    return { shift, assetAccount: "CASH_AND_BANK" };
  }
  if (outgoing) throw new ValidationError("An open cash shift is required for supplier cash payment");
  const workspaces = await employeeWorkspaceModules(tx, companyId, employeeId);
  if (!workspaces.some((module) => ["agent_workspace", "driver_workspace"].includes(module))) {
    throw new ValidationError("An open cash shift is required for cash payment");
  }
  return { shift: null, assetAccount: "CASH_IN_TRANSIT" };
}

async function buildAutomaticAllocations(tx, payment) {
  if (payment.allocations.length || payment.debtAllocations.length) return payment;
  let remaining = asNumber(payment.amount);
  if (payment.customerId) {
    const invoices = await tx.invoice.findMany({
      where: {
        companyId: payment.companyId,
        customerId: payment.customerId,
        status: { notIn: ["DRAFT", "VOID", "PAID"] },
      },
      orderBy: [{ dueAt: "asc" }, { issuedAt: "asc" }, { createdAt: "asc" }],
    });
    for (const invoice of invoices) {
      if (remaining <= EPSILON) break;
      const outstanding = invoiceOutstanding(invoice);
      if (outstanding <= EPSILON) continue;
      const amount = Math.min(remaining, outstanding);
      await tx.paymentAllocation.create({ data: { paymentId: payment.id, invoiceId: invoice.id, amount } });
      remaining -= amount;
    }
    if (remaining > EPSILON) {
      const standaloneDebts = await tx.debt.findMany({
        where: { companyId: payment.companyId, customerId: payment.customerId, invoiceId: null, outstanding: { gt: 0 } },
        orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      });
      for (const debt of standaloneDebts) {
        if (remaining <= EPSILON) break;
        const amount = Math.min(remaining, asNumber(debt.outstanding));
        await tx.debtPaymentAllocation.create({ data: { paymentId: payment.id, debtId: debt.id, amount } });
        remaining -= amount;
      }
    }
  } else if (payment.supplierId) {
    const debts = await tx.debt.findMany({
      where: { companyId: payment.companyId, supplierId: payment.supplierId, outstanding: { gt: 0 } },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    });
    for (const debt of debts) {
      if (remaining <= EPSILON) break;
      const amount = Math.min(remaining, asNumber(debt.outstanding));
      await tx.debtPaymentAllocation.create({ data: { paymentId: payment.id, debtId: debt.id, amount } });
      remaining -= amount;
    }
  }
  return tx.payment.findUnique({ where: { id: payment.id }, include });
}

async function applyCustomerInvoiceAllocation(tx, companyId, payment, allocation) {
  const invoice = await tx.invoice.findFirst({ where: { id: allocation.invoiceId, companyId, customerId: payment.customerId, status: { not: "VOID" } } });
  if (!invoice) throw new ValidationError("Payment allocation references an invalid invoice");
  const amount = asNumber(allocation.amount);
  const outstanding = invoiceOutstanding(invoice);
  if (amount > outstanding + EPSILON) throw new ConflictError("Payment allocation overpays invoice", { invoiceId: invoice.id });
  const nextPaid = asNumber(invoice.paid) + amount;
  const netTotal = Math.max(0, asNumber(invoice.total) - asNumber(invoice.credited));
  await tx.invoice.update({
    where: { id: invoice.id },
    data: { paid: nextPaid, status: nextPaid + EPSILON >= netTotal ? "PAID" : "PARTIALLY_PAID" },
  });
  const debts = await tx.debt.findMany({ where: { companyId, invoiceId: invoice.id, outstanding: { gt: 0 } }, orderBy: { createdAt: "asc" } });
  let remaining = amount;
  for (const debt of debts) {
    if (remaining <= EPSILON) break;
    const applied = Math.min(remaining, asNumber(debt.outstanding));
    const nextOutstanding = Math.max(0, asNumber(debt.outstanding) - applied);
    await tx.debt.update({ where: { id: debt.id }, data: { outstanding: nextOutstanding, settledAt: nextOutstanding <= EPSILON ? new Date() : null } });
    remaining -= applied;
  }
  if (payment.customerId) await tx.customer.update({ where: { id: payment.customerId }, data: { balance: { decrement: amount } } });
  return amount;
}

async function applyDebtAllocation(tx, companyId, payment, allocation) {
  const debt = await tx.debt.findFirst({
    where: {
      id: allocation.debtId,
      companyId,
      outstanding: { gt: 0 },
      ...(payment.customerId ? { customerId: payment.customerId } : {}),
      ...(payment.supplierId ? { supplierId: payment.supplierId } : {}),
    },
  });
  if (!debt) throw new ValidationError("Payment allocation references an invalid debt");
  const amount = asNumber(allocation.amount);
  if (amount > asNumber(debt.outstanding) + EPSILON) throw new ConflictError("Payment allocation overpays debt", { debtId: debt.id });
  const nextOutstanding = Math.max(0, asNumber(debt.outstanding) - amount);
  await tx.debt.update({ where: { id: debt.id }, data: { outstanding: nextOutstanding, settledAt: nextOutstanding <= EPSILON ? new Date() : null } });
  if (debt.customerId) await tx.customer.update({ where: { id: debt.customerId }, data: { balance: { decrement: amount } } });
  if (debt.supplierId) await tx.supplier.update({ where: { id: debt.supplierId }, data: { balance: { decrement: amount } } });
  return amount;
}

export async function confirmPaymentInTransaction(tx, companyId, confirmerEmployeeId, paymentId) {
  let payment = await tx.payment.findFirst({ where: { id: paymentId, companyId }, include });
  if (!payment) throw new NotFoundError("Payment not found");
  if (payment.status !== "PENDING") throw new ConflictError("Payment is already processed");
  payment = await buildAutomaticAllocations(tx, payment);

  let applied = 0;
  for (const allocation of payment.allocations) applied += await applyCustomerInvoiceAllocation(tx, companyId, payment, allocation);
  for (const allocation of payment.debtAllocations) applied += await applyDebtAllocation(tx, companyId, payment, allocation);
  if (applied > asNumber(payment.amount) + EPSILON) throw new ConflictError("Payment allocations exceed payment amount");
  const advance = Math.max(0, asNumber(payment.amount) - applied);

  const { shift, assetAccount } = await validateShift(tx, {
    companyId,
    employeeId: payment.employeeId || confirmerEmployeeId,
    shiftId: payment.shiftId,
    payment,
    method: payment.method,
  });
  if (payment.method === "CASH" && shift) {
    const outgoing = Boolean(payment.supplierId);
    await tx.cashTransaction.create({
      data: {
        companyId,
        cashboxId: shift.cashboxId,
        shiftId: shift.id,
        type: outgoing ? "EXPENSE" : "INCOME",
        amount: payment.amount,
        reference: payment.number,
        description: outgoing ? "Supplier payment" : "Customer payment",
      },
    });
    await tx.shift.update({ where: { id: shift.id }, data: { expectedCash: outgoing ? { decrement: payment.amount } : { increment: payment.amount } } });
    await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: outgoing ? { decrement: payment.amount } : { increment: payment.amount } } });
  }

  const ledgerRows = [];
  if (payment.supplierId) {
    if (applied > EPSILON) ledgerRows.push({ companyId, supplierId: payment.supplierId, side: "DEBIT", account: "PAYABLE", amount: applied, referenceType: "Payment", referenceId: payment.id, description: payment.number });
    if (advance > EPSILON) {
      await tx.supplier.update({ where: { id: payment.supplierId }, data: { advance: { increment: advance } } });
      ledgerRows.push({ companyId, supplierId: payment.supplierId, side: "DEBIT", account: "SUPPLIER_ADVANCE", amount: advance, referenceType: "Payment", referenceId: payment.id, description: payment.number });
    }
    ledgerRows.push({ companyId, supplierId: payment.supplierId, side: "CREDIT", account: assetAccount, amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number });
  } else if (payment.customerId) {
    ledgerRows.push({ companyId, customerId: payment.customerId, side: "DEBIT", account: assetAccount, amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number });
    if (applied > EPSILON) ledgerRows.push({ companyId, customerId: payment.customerId, side: "CREDIT", account: "RECEIVABLE", amount: applied, referenceType: "Payment", referenceId: payment.id, description: payment.number });
    if (advance > EPSILON) {
      await tx.customer.update({ where: { id: payment.customerId }, data: { advance: { increment: advance } } });
      ledgerRows.push({ companyId, customerId: payment.customerId, side: "CREDIT", account: "CUSTOMER_ADVANCE", amount: advance, referenceType: "Payment", referenceId: payment.id, description: payment.number });
    }
  } else {
    ledgerRows.push(
      { companyId, side: "DEBIT", account: assetAccount, amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number },
      { companyId, side: "CREDIT", account: "UNAPPLIED_RECEIPT", amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number },
    );
  }
  if (ledgerRows.length) await tx.ledgerEntry.createMany({ data: ledgerRows });

  await tx.payment.update({ where: { id: payment.id }, data: { status: "CONFIRMED", confirmedAt: new Date(), paidAt: new Date() } });
  await tx.receipt.create({
    data: {
      companyId,
      paymentId: payment.id,
      number: await nextDocumentNumber(tx, companyId, "RECEIPT", "RCP"),
      payload: { paymentNumber: payment.number, amount: asNumber(payment.amount), method: payment.method, methodCode: payment.methodCode, applied, advance, confirmedBy: confirmerEmployeeId },
    },
  });
  return tx.payment.findUnique({ where: { id: payment.id }, include });
}

export async function createPaymentInTransaction(tx, companyId, employeeId, input) {
  const allocationTotal = [...(input.allocations || []), ...(input.debtAllocations || [])].reduce((sum, row) => sum + asNumber(row.amount), 0);
  if (allocationTotal > input.amount + EPSILON) throw new ValidationError("Allocations exceed payment amount");
  const invoiceIds = [...new Set((input.allocations || []).map(({ invoiceId }) => invoiceId))];
  const debtIds = [...new Set((input.debtAllocations || []).map(({ debtId }) => debtId))];
  const [customer, supplier, order, methodConfig] = await Promise.all([
    input.customerId ? tx.customer.findFirst({ where: { id: input.customerId, companyId, deletedAt: null, status: "ACTIVE" } }) : null,
    input.supplierId ? tx.supplier.findFirst({ where: { id: input.supplierId, companyId, deletedAt: null, status: "ACTIVE" } }) : null,
    input.orderId ? tx.order.findFirst({ where: { id: input.orderId, companyId } }) : null,
    resolvePaymentMethod(tx, companyId, input),
  ]);
  if (input.customerId && !customer) throw new ValidationError("Customer is not active or does not belong to company");
  if (input.supplierId && !supplier) throw new ValidationError("Supplier is not active or does not belong to company");
  if (input.orderId && !order) throw new ValidationError("Order does not belong to company");
  if (order?.customerId && input.customerId && order.customerId !== input.customerId) throw new ValidationError("Payment customer does not match order customer");

  if (invoiceIds.length) {
    if (!input.customerId) throw new ValidationError("Customer is required for invoice allocation");
    const invoices = await tx.invoice.findMany({ where: { id: { in: invoiceIds }, companyId, customerId: input.customerId, status: { not: "VOID" } } });
    if (invoices.length !== invoiceIds.length) throw new ValidationError("Invalid invoice allocation");
  }
  if (debtIds.length) {
    const debts = await tx.debt.findMany({
      where: {
        id: { in: debtIds },
        companyId,
        outstanding: { gt: 0 },
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      },
    });
    if (debts.length !== debtIds.length) throw new ValidationError("Invalid debt allocation");
  }
  if (input.shiftId) {
    const shift = await tx.shift.findFirst({ where: { id: input.shiftId, companyId, employeeId, status: "OPEN" } });
    if (!shift) throw new ValidationError("Selected cash shift is not your open shift");
  }
  return tx.payment.create({
    data: {
      companyId,
      employeeId,
      customerId: input.customerId,
      supplierId: input.supplierId,
      orderId: input.orderId,
      shiftId: input.shiftId,
      method: methodConfig.method,
      methodCode: methodConfig.code,
      amount: input.amount,
      currency: input.currency || "UZS",
      externalRef: input.externalRef,
      note: input.note,
      number: await nextDocumentNumber(tx, companyId, "PAYMENT", "PAY"),
      allocations: { create: input.allocations || [] },
      debtAllocations: { create: input.debtAllocations || [] },
    },
    include,
  });
}

export async function settleCashTransitInTransaction(tx, companyId, receivingEmployeeId, paymentId, shiftId) {
  const payment = await tx.payment.findFirst({ where: { id: paymentId, companyId }, include });
  if (!payment) throw new NotFoundError("Payment not found");
  if (payment.status !== "CONFIRMED" || payment.method !== "CASH") throw new ConflictError("Only confirmed cash collection can be accepted into cashbox");
  if (payment.shiftId) throw new ConflictError("Cash collection is already attached to a cash shift");
  const transit = await tx.ledgerEntry.findFirst({ where: { companyId, referenceType: "Payment", referenceId: payment.id, account: "CASH_IN_TRANSIT", side: "DEBIT" } });
  if (!transit) throw new ConflictError("Payment is not recorded as cash in transit");
  const alreadySettled = await tx.ledgerEntry.findFirst({ where: { companyId, referenceType: "CashSettlement", referenceId: payment.id } });
  if (alreadySettled) throw new ConflictError("Cash collection is already settled");
  const shift = await tx.shift.findFirst({ where: { id: shiftId, companyId, employeeId: receivingEmployeeId, status: "OPEN" }, include: { cashbox: true } });
  if (!shift) throw new ValidationError("Kassaga qabul qilish uchun o‘zingizga tegishli ochiq smenani tanlang");
  if (payment.orderId) {
    const order = await tx.order.findFirst({ where: { id: payment.orderId, companyId }, select: { warehouseId: true, branchId: true } });
    if (order?.warehouseId && shift.cashbox.warehouseId && order.warehouseId !== shift.cashbox.warehouseId) throw new ValidationError("To‘lov boshqa ombor kassasiga tegishli");
    if (order?.branchId && shift.cashbox.branchId && order.branchId !== shift.cashbox.branchId) throw new ValidationError("To‘lov boshqa filial kassasiga tegishli");
  }
  await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId: shift.id, type: "INCOME", amount: payment.amount,
    reference: payment.number, description: `Xodimdan kassaga qabul qilindi · ${payment.employee?.name || "xodim"}` } });
  await tx.shift.update({ where: { id: shift.id }, data: { expectedCash: { increment: payment.amount } } });
  await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: { increment: payment.amount } } });
  await tx.ledgerEntry.createMany({ data: [
    { companyId, customerId: payment.customerId, side: "DEBIT", account: "CASH_AND_BANK", amount: payment.amount, referenceType: "CashSettlement", referenceId: payment.id, description: payment.number },
    { companyId, customerId: payment.customerId, side: "CREDIT", account: "CASH_IN_TRANSIT", amount: payment.amount, referenceType: "CashSettlement", referenceId: payment.id, description: payment.number },
  ] });
  await tx.payment.update({ where: { id: payment.id }, data: { shiftId: shift.id } });
  return tx.payment.findUnique({ where: { id: payment.id }, include });
}

export function createPaymentService(prisma) {
  return {
    async list(companyId, query) {
      const page = parsePagination(query, { allowedSortFields: ["createdAt", "paidAt", "amount", "number"] });
      const where = { companyId };
      for (const field of ["status", "method", "customerId", "supplierId", "orderId"]) if (query[field]) where[field] = query[field];
      if (page.search) where.OR = [{ number: { contains: page.search, mode: "insensitive" } }, { externalRef: { contains: page.search, mode: "insensitive" } }];
      const [data, total] = await prisma.$transaction([
        prisma.payment.findMany({ where, include, skip: page.skip, take: page.take, orderBy: { [page.sortBy || "createdAt"]: page.sortOrder } }),
        prisma.payment.count({ where }),
      ]);
      return { data, meta: paginationMeta({ ...page, total }) };
    },
    async create(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        const payment = await createPaymentInTransaction(tx, companyId, employeeId, input);
        const settings = await companySettings(tx, companyId);
        if (settings.finance?.requirePaymentConfirmation === false) return confirmPaymentInTransaction(tx, companyId, employeeId, payment.id);
        return payment;
      }, { isolationLevel: "Serializable" });
    },
    async confirm(companyId, employeeId, id) {
      return prisma.$transaction((tx) => confirmPaymentInTransaction(tx, companyId, employeeId, id), { isolationLevel: "Serializable" });
    },
    async settleCash(companyId, employeeId, id, shiftId) {
      return prisma.$transaction((tx) => settleCashTransitInTransaction(tx, companyId, employeeId, id, shiftId), { isolationLevel: "Serializable" });
    },
    async cancel(companyId, id) {
      const payment = await prisma.payment.findFirst({ where: { id, companyId } });
      if (!payment) throw new NotFoundError("Payment not found");
      if (payment.status !== "PENDING") throw new ConflictError("Confirmed payments require a refund workflow");
      return prisma.payment.update({ where: { id }, data: { status: "CANCELLED" }, include });
    },
  };
}
