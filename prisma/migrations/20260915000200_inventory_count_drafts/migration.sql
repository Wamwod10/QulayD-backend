-- Allow real inventory-count drafts to preserve uncounted lines.
-- Existing values remain unchanged; no data is deleted or reset.
ALTER TABLE "InventoryCountItem" ALTER COLUMN "counted" DROP NOT NULL;
ALTER TABLE "InventoryCountItem" ALTER COLUMN "difference" DROP NOT NULL;
