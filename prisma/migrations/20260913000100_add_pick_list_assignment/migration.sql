ALTER TABLE "PickList" ADD COLUMN "pickerEmployeeId" UUID;

CREATE INDEX "PickList_pickerEmployeeId_idx" ON "PickList"("pickerEmployeeId");

ALTER TABLE "PickList"
ADD CONSTRAINT "PickList_pickerEmployeeId_fkey"
FOREIGN KEY ("pickerEmployeeId") REFERENCES "Employee"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
