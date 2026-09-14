-- Universal Product System + POS extension.
-- Additive / production-safe migration. No reset, truncate, or destructive product data rewrite.

CREATE TYPE "ProductSerialStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'SOLD', 'RETURNED', 'DAMAGED');

ALTER TABLE "Product"
  ADD COLUMN "supplierId" UUID,
  ADD COLUMN "manufacturer" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "warehouseLocation" TEXT,
  ADD COLUMN "trackExpiry" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "trackLot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "trackSerial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isMarked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ProductBarcode"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID;

ALTER TABLE "ProductVariant"
  ADD COLUMN "imageUrl" TEXT,
  ADD COLUMN "costPrice" DECIMAL(18,2),
  ADD COLUMN "price" DECIMAL(18,2);

CREATE TABLE "ProductImage" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "url" TEXT NOT NULL,
  "alt" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductPackage" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "variantId" UUID,
  "parentPackageId" UUID,
  "name" TEXT NOT NULL,
  "conversionQuantity" DECIMAL(18,3) NOT NULL,
  "conversionToBase" DECIMAL(18,6) NOT NULL,
  "costPrice" DECIMAL(18,2),
  "price" DECIMAL(18,2),
  "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductPackage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductBatch" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "variantId" UUID,
  "warehouseId" UUID NOT NULL,
  "lotNumber" TEXT NOT NULL,
  "variantKey" TEXT NOT NULL DEFAULT 'BASE',
  "manufacturedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "quantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "reserved" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductSerial" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "variantId" UUID,
  "warehouseId" UUID NOT NULL,
  "batchId" UUID,
  "serial" TEXT NOT NULL,
  "imei" TEXT,
  "status" "ProductSerialStatus" NOT NULL DEFAULT 'AVAILABLE',
  "soldOrderId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductSerial_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "StockMovement"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "batchId" UUID;

ALTER TABLE "StockReservation"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID;

ALTER TABLE "OrderItem"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "baseQuantity" DECIMAL(18,3),
  ADD COLUMN "productName" TEXT,
  ADD COLUMN "sku" TEXT,
  ADD COLUMN "unitName" TEXT,
  ADD COLUMN "variantName" TEXT,
  ADD COLUMN "packageName" TEXT,
  ADD COLUMN "conversionToBase" DECIMAL(18,6) NOT NULL DEFAULT 1;

ALTER TABLE "GoodsReceiptItem"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "batchId" UUID,
  ADD COLUMN "baseQuantity" DECIMAL(18,3),
  ADD COLUMN "conversionToBase" DECIMAL(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN "lotNumber" TEXT,
  ADD COLUMN "manufacturedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "serialNumbers" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "InvoiceItem"
  ADD COLUMN "variantName" TEXT,
  ADD COLUMN "packageName" TEXT,
  ADD COLUMN "baseQuantity" DECIMAL(18,3);

ALTER TABLE "ReturnItem"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "baseQuantity" DECIMAL(18,3),
  ADD COLUMN "conversionToBase" DECIMAL(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN "serialIds" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "HeldCartItem"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "baseQuantity" DECIMAL(18,3),
  ADD COLUMN "conversionToBase" DECIMAL(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN "serialIds" JSONB NOT NULL DEFAULT '[]';

DROP INDEX IF EXISTS "GoodsReceiptItem_receiptId_productId_key";
DROP INDEX IF EXISTS "HeldCartItem_heldCartId_productId_key";

CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId", "sortOrder");
CREATE INDEX "ProductBarcode_variantId_idx" ON "ProductBarcode"("variantId");
CREATE INDEX "ProductBarcode_packageId_idx" ON "ProductBarcode"("packageId");
CREATE INDEX "ProductPackage_companyId_productId_status_idx" ON "ProductPackage"("companyId", "productId", "status");
CREATE INDEX "ProductPackage_variantId_idx" ON "ProductPackage"("variantId");
CREATE UNIQUE INDEX "ProductBatch_companyId_productId_warehouseId_lotNumber_variantKey_key" ON "ProductBatch"("companyId", "productId", "warehouseId", "lotNumber", "variantKey");
CREATE INDEX "ProductBatch_companyId_warehouseId_expiresAt_idx" ON "ProductBatch"("companyId", "warehouseId", "expiresAt");
CREATE UNIQUE INDEX "ProductSerial_companyId_serial_key" ON "ProductSerial"("companyId", "serial");
CREATE UNIQUE INDEX "ProductSerial_companyId_imei_key" ON "ProductSerial"("companyId", "imei");
CREATE INDEX "ProductSerial_companyId_productId_warehouseId_status_idx" ON "ProductSerial"("companyId", "productId", "warehouseId", "status");
CREATE INDEX "GoodsReceiptItem_receiptId_productId_idx" ON "GoodsReceiptItem"("receiptId", "productId");
CREATE INDEX "HeldCartItem_heldCartId_productId_idx" ON "HeldCartItem"("heldCartId", "productId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_parentPackageId_fkey"
  FOREIGN KEY ("parentPackageId") REFERENCES "ProductPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductSerial" ADD CONSTRAINT "ProductSerial_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductSerial" ADD CONSTRAINT "ProductSerial_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductSerial" ADD CONSTRAINT "ProductSerial_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductSerial" ADD CONSTRAINT "ProductSerial_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductSerial" ADD CONSTRAINT "ProductSerial_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductSerial" ADD CONSTRAINT "ProductSerial_soldOrderId_fkey"
  FOREIGN KEY ("soldOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HeldCartItem" ADD CONSTRAINT "HeldCartItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HeldCartItem" ADD CONSTRAINT "HeldCartItem_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tracking-aware stock transfers and adjustments
ALTER TABLE "StockTransferItem"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "batchId" UUID,
  ADD COLUMN "serialIds" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "StockAdjustmentItem"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "batchId" UUID,
  ADD COLUMN "serialIds" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "serialNumbers" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "lotNumber" TEXT,
  ADD COLUMN "manufacturedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "StockTransferItem_transferId_productId_key";
DROP INDEX IF EXISTS "StockAdjustmentItem_adjustmentId_productId_key";
CREATE INDEX "StockTransferItem_transferId_productId_idx" ON "StockTransferItem"("transferId", "productId");
CREATE INDEX "StockTransferItem_variantId_idx" ON "StockTransferItem"("variantId");
CREATE INDEX "StockTransferItem_batchId_idx" ON "StockTransferItem"("batchId");
CREATE INDEX "StockAdjustmentItem_adjustmentId_productId_idx" ON "StockAdjustmentItem"("adjustmentId", "productId");
CREATE INDEX "StockAdjustmentItem_variantId_idx" ON "StockAdjustmentItem"("variantId");
CREATE INDEX "StockAdjustmentItem_batchId_idx" ON "StockAdjustmentItem"("batchId");

ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockAdjustmentItem" ADD CONSTRAINT "StockAdjustmentItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockAdjustmentItem" ADD CONSTRAINT "StockAdjustmentItem_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StockTransferItem" ADD COLUMN "packageId" UUID;
ALTER TABLE "StockAdjustmentItem" ADD COLUMN "packageId" UUID;
CREATE INDEX "StockTransferItem_packageId_idx" ON "StockTransferItem"("packageId");
CREATE INDEX "StockAdjustmentItem_packageId_idx" ON "StockAdjustmentItem"("packageId");
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockAdjustmentItem" ADD CONSTRAINT "StockAdjustmentItem_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "ProductPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Variant-aware warehouse stock. Existing rows remain aggregate BASE balances.
-- New variant rows are stored in the same WarehouseStock table while BASE continues to be the product aggregate.
ALTER TABLE "WarehouseStock"
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "stockKey" TEXT NOT NULL DEFAULT 'BASE';

DROP INDEX IF EXISTS "WarehouseStock_warehouseId_productId_key";
CREATE UNIQUE INDEX "WarehouseStock_warehouseId_productId_stockKey_key" ON "WarehouseStock"("warehouseId", "productId", "stockKey");
CREATE INDEX "WarehouseStock_companyId_productId_variantId_idx" ON "WarehouseStock"("companyId", "productId", "variantId");
ALTER TABLE "WarehouseStock" ADD CONSTRAINT "WarehouseStock_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Persist exact tracking identity on sold/returned lines for deterministic returns.
ALTER TABLE "OrderItem"
  ADD COLUMN "serialIds" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "batchAllocations" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "ReturnItem"
  ADD COLUMN "batchAllocations" JSONB NOT NULL DEFAULT '[]';
