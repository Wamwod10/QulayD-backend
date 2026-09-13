import { describe, expect, it } from "vitest";
import { productCreateSchema } from "../../src/modules/catalog/products/product.validation.js";
describe("product contract", () => {
  const product = { name: "Cola", unitId: "00000000-0000-4000-8000-000000000001", sku: "00001", barcodes: [{ barcode: "4780010000011" }] };
  it("accepts a five digit SKU and explicit barcode", () => expect(productCreateSchema.safeParse(product).success).toBe(true));
  it("rejects non-five-digit SKUs", () => expect(productCreateSchema.safeParse({ ...product, sku: "1001" }).success).toBe(false));
  it("rejects duplicate barcodes", () => expect(productCreateSchema.safeParse({ ...product, barcodes: [{ barcode: "123" }, { barcode: "123" }] }).success).toBe(false));
});
