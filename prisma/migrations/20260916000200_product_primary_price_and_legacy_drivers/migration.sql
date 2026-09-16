ALTER TABLE "Product" ADD COLUMN "primaryPriceListId" UUID;

ALTER TABLE "Product"
ADD CONSTRAINT "Product_primaryPriceListId_fkey"
FOREIGN KEY ("primaryPriceListId") REFERENCES "PriceList"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Product_companyId_primaryPriceListId_idx"
ON "Product"("companyId", "primaryPriceListId");

INSERT INTO "EmployeeModule" ("id", "employeeId", "module", "enabled", "createdAt", "updatedAt")
SELECT gen_random_uuid(), employee."id", 'driver_workspace', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Employee" employee
LEFT JOIN "EmployeeType" employee_type ON employee_type."id" = employee."employeeTypeId"
WHERE employee."deletedAt" IS NULL
  AND (
    lower(coalesce(employee_type."code", '')) IN ('delivery_driver', 'driver', 'courier')
    OR lower(coalesce(employee_type."name", '')) LIKE '%yetkazib beruvchi%'
    OR lower(coalesce(employee_type."name", '')) LIKE '%haydovchi%'
    OR lower(coalesce(employee_type."name", '')) LIKE '%kuryer%'
    OR lower(coalesce(employee."title", '')) LIKE '%yetkazib beruvchi%'
    OR lower(coalesce(employee."title", '')) LIKE '%haydovchi%'
    OR lower(coalesce(employee."title", '')) LIKE '%kuryer%'
  )
ON CONFLICT ("employeeId", "module") DO UPDATE SET "enabled" = true, "updatedAt" = CURRENT_TIMESTAMP;
