-- QULAY distribution workflow completion.
-- Additive, production-safe changes. No table/data reset or destructive row deletion.

-- Scoped price-list prices for variants and packages.
ALTER TABLE "ProductPrice"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "scopeKey" TEXT NOT NULL DEFAULT 'BASE';

DROP INDEX IF EXISTS "ProductPrice_priceListId_productId_validFrom_key";
CREATE UNIQUE INDEX "ProductPrice_priceListId_productId_scopeKey_validFrom_key"
  ON "ProductPrice"("priceListId", "productId", "scopeKey", "validFrom");
CREATE INDEX "ProductPrice_companyId_productId_scopeKey_validTo_idx"
  ON "ProductPrice"("companyId", "productId", "scopeKey", "validTo");
CREATE INDEX "ProductPrice_variantId_idx" ON "ProductPrice"("variantId");
CREATE INDEX "ProductPrice_packageId_idx" ON "ProductPrice"("packageId");
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve existing legacy variant/package prices inside the company's default price list.
INSERT INTO "ProductPrice" ("id", "companyId", "priceListId", "productId", "variantId", "scopeKey", "price", "validFrom", "createdAt", "updatedAt")
SELECT gen_random_uuid(), v."companyId", pl."id", v."productId", v."id", 'VARIANT:' || v."id"::text,
       v."price", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ProductVariant" v
JOIN "PriceList" pl ON pl."companyId" = v."companyId" AND pl."isDefault" = true AND pl."status" = 'ACTIVE'
WHERE v."price" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ProductPrice" pp
    WHERE pp."priceListId" = pl."id" AND pp."productId" = v."productId"
      AND pp."scopeKey" = 'VARIANT:' || v."id"::text AND pp."validTo" IS NULL
  );

INSERT INTO "ProductPrice" ("id", "companyId", "priceListId", "productId", "variantId", "packageId", "scopeKey", "price", "validFrom", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."companyId", pl."id", p."productId", p."variantId", p."id", 'PACKAGE:' || p."id"::text,
       p."price", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ProductPackage" p
JOIN "PriceList" pl ON pl."companyId" = p."companyId" AND pl."isDefault" = true AND pl."status" = 'ACTIVE'
WHERE p."price" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ProductPrice" pp
    WHERE pp."priceListId" = pl."id" AND pp."productId" = p."productId"
      AND pp."scopeKey" = 'PACKAGE:' || p."id"::text AND pp."validTo" IS NULL
  );

-- Real, line-level warehouse picking.
ALTER TABLE "PickList" ADD COLUMN "exception" TEXT;
CREATE TABLE "PickListItem" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "pickListId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "requiredQuantity" DECIMAL(18,3) NOT NULL,
  "pickedQuantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "shortageQuantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "requiredBaseQuantity" DECIMAL(18,3) NOT NULL,
  "pickedBaseQuantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "shortageBaseQuantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "serialIds" JSONB NOT NULL DEFAULT '[]',
  "batchAllocations" JSONB NOT NULL DEFAULT '[]',
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PickListItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PickListItem_pickListId_orderItemId_key" ON "PickListItem"("pickListId", "orderItemId");
CREATE INDEX "PickListItem_companyId_pickListId_idx" ON "PickListItem"("companyId", "pickListId");
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_pickListId_fkey"
  FOREIGN KEY ("pickListId") REFERENCES "PickList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing pick lists so old confirmed orders have real line records too.
INSERT INTO "PickListItem" (
  "id", "companyId", "pickListId", "orderItemId", "requiredQuantity", "pickedQuantity", "shortageQuantity",
  "requiredBaseQuantity", "pickedBaseQuantity", "shortageBaseQuantity", "serialIds", "batchAllocations", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), p."companyId", p."id", oi."id", oi."quantity",
       CASE WHEN p."status" = 'COMPLETED' THEN oi."quantity" ELSE 0 END,
       0,
       COALESCE(oi."baseQuantity", oi."quantity"),
       CASE WHEN p."status" = 'COMPLETED' THEN COALESCE(oi."baseQuantity", oi."quantity") ELSE 0 END,
       0,
       COALESCE(oi."serialIds", '[]'::jsonb), COALESCE(oi."batchAllocations", '[]'::jsonb),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "PickList" p
JOIN "OrderItem" oi ON oi."orderId" = p."orderId"
WHERE NOT EXISTS (
  SELECT 1 FROM "PickListItem" pi WHERE pi."pickListId" = p."id" AND pi."orderItemId" = oi."id"
);

-- Transfer lifecycle and audit-friendly package quantities.
ALTER TABLE "StockTransfer" ADD COLUMN "dispatchedAt" TIMESTAMP(3);
ALTER TABLE "StockTransferItem"
  ADD COLUMN "displayQuantity" DECIMAL(18,3),
  ADD COLUMN "conversionToBase" DECIMAL(18,6) NOT NULL DEFAULT 1;
UPDATE "StockTransferItem" sti
SET "conversionToBase" = COALESCE(pp."conversionToBase", 1),
    "displayQuantity" = CASE
      WHEN COALESCE(pp."conversionToBase", 1) > 0 THEN sti."quantity" / COALESCE(pp."conversionToBase", 1)
      ELSE sti."quantity"
    END
FROM "ProductPackage" pp
WHERE sti."packageId" = pp."id";
UPDATE "StockTransferItem" SET "displayQuantity" = "quantity" WHERE "displayQuantity" IS NULL;

ALTER TABLE "StockAdjustmentItem"
  ADD COLUMN "displayQuantity" DECIMAL(18,3),
  ADD COLUMN "conversionToBase" DECIMAL(18,6) NOT NULL DEFAULT 1;
UPDATE "StockAdjustmentItem" sai
SET "conversionToBase" = COALESCE(pp."conversionToBase", 1),
    "displayQuantity" = CASE
      WHEN COALESCE(pp."conversionToBase", 1) > 0 THEN ABS(sai."quantity") / COALESCE(pp."conversionToBase", 1)
      ELSE ABS(sai."quantity")
    END
FROM "ProductPackage" pp
WHERE sai."packageId" = pp."id";
UPDATE "StockAdjustmentItem" SET "displayQuantity" = ABS("quantity") WHERE "displayQuantity" IS NULL;

-- Variant-level inventory counts.
ALTER TABLE "InventoryCountItem"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "stockKey" TEXT NOT NULL DEFAULT 'BASE';
DROP INDEX IF EXISTS "InventoryCountItem_countId_productId_key";
CREATE UNIQUE INDEX "InventoryCountItem_countId_productId_stockKey_key"
  ON "InventoryCountItem"("countId", "productId", "stockKey");
CREATE INDEX "InventoryCountItem_variantId_idx" ON "InventoryCountItem"("variantId");
ALTER TABLE "InventoryCountItem" ADD CONSTRAINT "InventoryCountItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Delivery scheduling and finance consistency.
ALTER TABLE "DeliveryTrip" ADD COLUMN "plannedDate" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "credited" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Debt"
  ADD COLUMN "referenceType" TEXT,
  ADD COLUMN "referenceId" TEXT;
CREATE INDEX "Debt_companyId_referenceType_referenceId_idx"
  ON "Debt"("companyId", "referenceType", "referenceId");


-- Payment allocation / advances and custom payment-method traceability.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "advance" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "advance" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "methodCode" TEXT;
CREATE INDEX IF NOT EXISTS "Payment_companyId_methodCode_createdAt_idx" ON "Payment"("companyId", "methodCode", "createdAt");
