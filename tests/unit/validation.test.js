import { describe, expect, it } from "vitest";
import { productCreateSchema } from "../../src/modules/catalog/products/product.validation.js";
describe("product contract", () => {
  const priceListId = "00000000-0000-4000-8000-000000000002";
  const product = {
    name: "Cola",
    unitId: "00000000-0000-4000-8000-000000000001",
    sku: "00001",
    barcodes: [{ barcode: "4780010000011" }],
    primaryPriceListId: priceListId,
    prices: [{ priceListId, price: 10_000 }],
  };
  it("accepts 1-64 character business SKUs and an explicit barcode", () => {
    for (const sku of ["1", "00001", "SKU-123456", "PHONE/15.PRO_MAX"]) {
      expect(productCreateSchema.safeParse({ ...product, sku }).success).toBe(true);
    }
  });
  it("rejects empty, invalid and longer-than-64-character SKUs", () => {
    for (const sku of ["", "SKU 123", "SKU@123", "A".repeat(65)]) {
      expect(productCreateSchema.safeParse({ ...product, sku }).success).toBe(false);
    }
  });
  it("rejects duplicate barcodes", () => expect(productCreateSchema.safeParse({ ...product, barcodes: [{ barcode: "123" }, { barcode: "123" }] }).success).toBe(false));
});
