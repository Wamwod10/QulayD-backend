import { describe, expect, it, vi } from "vitest";
import { changeStock } from "../../src/modules/inventory/balances/balance.service.js";

describe("stock balance service", () => {
  it("writes an immutable movement after a stock change", async () => {
    const prisma = { warehouseStock: { upsert: vi.fn().mockResolvedValue({ onHand: 12, reserved: 2 }) }, stockMovement: { create: vi.fn().mockResolvedValue({}) } };
    await changeStock(prisma, { companyId: "c", warehouseId: "w", productId: "p", quantity: 5, type: "GOODS_RECEIPT" });
    expect(prisma.stockMovement.create).toHaveBeenCalledWith({ data: expect.objectContaining({ quantity: 5, balanceAfter: 12 }) });
  });
  it("rejects negative available inventory", async () => {
    const prisma = { warehouseStock: { upsert: vi.fn().mockResolvedValue({ onHand: 2, reserved: 3 }) }, stockMovement: { create: vi.fn() } };
    await expect(changeStock(prisma, { companyId: "c", warehouseId: "w", productId: "p", reserved: 3 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
