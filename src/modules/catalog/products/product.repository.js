import { PRODUCT_INCLUDE } from "./product.constants.js";
import { ConflictError, ValidationError } from "../../../shared/errors/index.js";

async function assertProductReferences(tx, companyId, input) {
  const priceListIds = [...new Set((input.prices || []).map(({ priceListId }) => priceListId))];
  const warehouseIds = [...new Set((input.openingStock || []).map(({ warehouseId }) => warehouseId))];
  const [unit, category, supplier, priceLists, warehouses] = await Promise.all([
    input.unitId ? tx.unit.count({ where: { id: input.unitId, companyId, status: "ACTIVE" } }) : 1,
    input.categoryId ? tx.category.count({ where: { id: input.categoryId, companyId, deletedAt: null } }) : 1,
    input.supplierId ? tx.supplier.count({ where: { id: input.supplierId, companyId, deletedAt: null } }) : 1,
    priceListIds.length ? tx.priceList.count({ where: { id: { in: priceListIds }, companyId, status: "ACTIVE" } }) : 0,
    warehouseIds.length ? tx.warehouse.count({ where: { id: { in: warehouseIds }, companyId, deletedAt: null, status: "ACTIVE" } }) : 0,
  ]);
  if (unit !== 1 || category !== 1 || supplier !== 1 || priceLists !== priceListIds.length || warehouses !== warehouseIds.length) {
    throw new ValidationError("Invalid product resource reference");
  }
}

async function assertUniqueCodes(tx, companyId, productId, input) {
  const skuValues = [input.sku, ...(input.variants || []).map(({ sku }) => sku)].filter(Boolean);
  if (skuValues.length !== new Set(skuValues).size) throw new ConflictError("SKU values must be unique");
  const [productSku, variantSku] = await Promise.all([
    skuValues.length ? tx.product.findFirst({ where: { companyId, id: { not: productId || undefined }, sku: { in: skuValues }, deletedAt: null }, select: { sku: true } }) : null,
    skuValues.length ? tx.productVariant.findFirst({ where: { companyId, productId: { not: productId || undefined }, sku: { in: skuValues } }, select: { sku: true } }) : null,
  ]);
  if (productSku || variantSku) throw new ConflictError(`SKU ${productSku?.sku || variantSku?.sku} already exists`);
  const barcodes = [
    ...(input.barcodes || []).map(({ barcode }) => barcode),
    ...(input.variants || []).flatMap(({ barcodes: values = [] }) => values),
    ...(input.packages || []).map(({ barcode }) => barcode).filter(Boolean),
  ];
  if (barcodes.length !== new Set(barcodes).size) throw new ConflictError("Barcode values must be unique");
  if (barcodes.length) {
    const duplicate = await tx.productBarcode.findFirst({ where: { companyId, productId: { not: productId || undefined }, barcode: { in: barcodes } }, select: { barcode: true } });
    if (duplicate) throw new ConflictError(`Barcode ${duplicate.barcode} already exists`);
  }
}

async function nextSku(tx, companyId) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const sequence = await tx.documentSequence.upsert({
      where: { companyId_type_year: { companyId, type: "SKU", year: 0 } },
      create: { companyId, type: "SKU", prefix: "", year: 0, value: 1 }, update: { value: { increment: 1 } },
    });
    // Keep the familiar five-digit format while small, but never impose a five-digit ceiling.
    const candidate = String(sequence.value).padStart(5, "0");
    const [product, variant] = await Promise.all([
      tx.product.findFirst({ where: { companyId, sku: candidate, deletedAt: null }, select: { id: true } }),
      tx.productVariant.findFirst({ where: { companyId, sku: candidate }, select: { id: true } }),
    ]);
    if (!product && !variant) return candidate;
  }
  throw new ConflictError("Unable to generate a unique SKU; please enter one manually");
}

function normalizePriceRow(entry) {
  const variantId = entry.variantId || null;
  const packageId = entry.packageId || null;
  if (variantId && packageId) throw new ValidationError("Price can target either a variant or a package, not both");
  return {
    priceListId: entry.priceListId,
    variantId,
    packageId,
    scopeKey: packageId ? `PACKAGE:${packageId}` : variantId ? `VARIANT:${variantId}` : "BASE",
    price: entry.price,
  };
}

async function syncExplicitPrices(tx, companyId, productId, prices, { replaceAll = false } = {}) {
  const now = new Date();
  if (replaceAll) await tx.productPrice.updateMany({ where: { productId, validTo: null }, data: { validTo: now } });
  if (!prices?.length) return;
  const variants = await tx.productVariant.findMany({ where: { companyId, productId }, select: { id: true } });
  const packages = await tx.productPackage.findMany({ where: { companyId, productId }, select: { id: true } });
  const variantIds = new Set(variants.map((row) => row.id));
  const packageIds = new Set(packages.map((row) => row.id));
  const rows = prices.map(normalizePriceRow);
  for (const row of rows) {
    if (row.variantId && !variantIds.has(row.variantId)) throw new ValidationError("Price variant does not belong to product");
    if (row.packageId && !packageIds.has(row.packageId)) throw new ValidationError("Price package does not belong to product");
  }
  if (!replaceAll) {
    for (const row of rows) {
      await tx.productPrice.updateMany({ where: { companyId, productId, priceListId: row.priceListId, scopeKey: row.scopeKey, validTo: null }, data: { validTo: now } });
    }
  }
  await tx.productPrice.createMany({ data: rows.map((row) => ({ ...row, companyId, productId })) });
}

async function syncLegacyDefaultScopedPrices(tx, companyId, productId, { variantsTouched = false, packagesTouched = false } = {}) {
  if (!variantsTouched && !packagesTouched) return;
  const defaultList = await tx.priceList.findFirst({ where: { companyId, status: "ACTIVE", isDefault: true }, orderBy: { createdAt: "asc" } });
  if (!defaultList) return;
  const now = new Date();
  if (variantsTouched) {
    const variants = await tx.productVariant.findMany({ where: { companyId, productId, status: "ACTIVE" }, select: { id: true, price: true } });
    const keys = variants.map((row) => `VARIANT:${row.id}`);
    if (keys.length) await tx.productPrice.updateMany({ where: { companyId, productId, priceListId: defaultList.id, scopeKey: { in: keys }, validTo: null }, data: { validTo: now } });
    const rows = variants.filter((row) => row.price != null).map((row) => ({ companyId, productId, priceListId: defaultList.id, variantId: row.id, scopeKey: `VARIANT:${row.id}`, price: row.price }));
    if (rows.length) await tx.productPrice.createMany({ data: rows });
  }
  if (packagesTouched) {
    const packages = await tx.productPackage.findMany({ where: { companyId, productId, status: "ACTIVE" }, select: { id: true, price: true } });
    const keys = packages.map((row) => `PACKAGE:${row.id}`);
    if (keys.length) await tx.productPrice.updateMany({ where: { companyId, productId, priceListId: defaultList.id, scopeKey: { in: keys }, validTo: null }, data: { validTo: now } });
    const rows = packages.filter((row) => row.price != null).map((row) => ({ companyId, productId, priceListId: defaultList.id, packageId: row.id, scopeKey: `PACKAGE:${row.id}`, price: row.price }));
    if (rows.length) await tx.productPrice.createMany({ data: rows });
  }
}

const primaryRows = (rows = []) => rows.map((entry, index) => ({ ...entry, isPrimary: index === (rows.findIndex((row) => row.isPrimary) < 0 ? 0 : rows.findIndex((row) => row.isPrimary)) }));

async function createRelations(tx, companyId, productId, { images = [], barcodes = [], variants = [], packages = [] }) {
  if (images.length) await tx.productImage.createMany({ data: primaryRows(images).map(({ id: _id, ...row }, sortOrder) => ({ ...row, sortOrder, companyId, productId })) });
  if (barcodes.length) await tx.productBarcode.createMany({ data: primaryRows(barcodes).map((row) => ({ ...row, companyId, productId })) });
  const variantsBySku = new Map();
  for (const { id: _id, barcodes: values = [], ...row } of variants) {
    void _id;
    const variant = await tx.productVariant.create({ data: { ...row, companyId, productId } });
    variantsBySku.set(variant.sku, variant);
    if (values.length) await tx.productBarcode.createMany({ data: values.map((barcode) => ({ barcode, companyId, productId, variantId: variant.id })) });
  }
  for (const { id: _id, barcode, variantSku, variantId: suppliedVariantId, ...row } of packages) {
    void _id;
    if (row.parentPackageId) throw new ValidationError("Parent package can only reference an existing package of the same product after creation");
    if (suppliedVariantId && !variantSku) throw new ValidationError("New product packages must reference a variant by variantSku");
    const variant = variantSku ? variantsBySku.get(variantSku) : null;
    if (variantSku && !variant) throw new ValidationError(`Package variant SKU ${variantSku} does not belong to this product`);
    const productPackage = await tx.productPackage.create({ data: { ...row, variantId: variant?.id || null, companyId, productId } });
    if (barcode) await tx.productBarcode.create({ data: { barcode, companyId, productId, packageId: productPackage.id } });
  }
}

async function syncRelations(tx, companyId, productId, input) {
  if (input.images) {
    await tx.productImage.deleteMany({ where: { productId } });
    if (input.images.length) await tx.productImage.createMany({ data: primaryRows(input.images).map(({ id: _id, ...row }, sortOrder) => ({ ...row, sortOrder, companyId, productId })) });
  }
  if (input.barcodes) {
    await tx.productBarcode.deleteMany({ where: { productId, variantId: null, packageId: null } });
    if (input.barcodes.length) await tx.productBarcode.createMany({ data: primaryRows(input.barcodes).map((row) => ({ ...row, companyId, productId })) });
  }
  if (input.variants) {
    const retained = input.variants.flatMap(({ id }) => id ? [id] : []);
    const removed = await tx.productVariant.findMany({ where: { productId, ...(retained.length ? { id: { notIn: retained } } : {}) }, select: { id: true } });
    await tx.productVariant.updateMany({ where: { productId, ...(retained.length ? { id: { notIn: retained } } : {}) }, data: { status: "INACTIVE" } });
    if (removed.length) await tx.productBarcode.deleteMany({ where: { variantId: { in: removed.map(({ id }) => id) } } });
    for (const { id, barcodes = [], ...row } of input.variants) {
      const variant = id
        ? await tx.productVariant.update({ where: { id, productId }, data: row })
        : await tx.productVariant.create({ data: { ...row, companyId, productId } });
      await tx.productBarcode.deleteMany({ where: { variantId: variant.id } });
      if (barcodes.length) await tx.productBarcode.createMany({ data: barcodes.map((barcode) => ({ barcode, companyId, productId, variantId: variant.id })) });
    }
    const inactiveVariants = await tx.productVariant.findMany({ where: { productId, status: "INACTIVE" }, select: { id: true } });
    if (inactiveVariants.length) {
      const variantIds = inactiveVariants.map(({ id }) => id);
      const affectedPackages = await tx.productPackage.findMany({ where: { productId, variantId: { in: variantIds }, status: "ACTIVE" }, select: { id: true } });
      if (affectedPackages.length) {
        const packageIds = affectedPackages.map(({ id }) => id);
        await tx.productPackage.updateMany({ where: { id: { in: packageIds } }, data: { status: "INACTIVE" } });
        await tx.productBarcode.deleteMany({ where: { packageId: { in: packageIds } } });
      }
    }
  }
  if (input.packages) {
    const retained = input.packages.flatMap(({ id }) => id ? [id] : []);
    const removed = await tx.productPackage.findMany({ where: { productId, ...(retained.length ? { id: { notIn: retained } } : {}) }, select: { id: true } });
    await tx.productPackage.updateMany({ where: { productId, ...(retained.length ? { id: { notIn: retained } } : {}) }, data: { status: "INACTIVE" } });
    if (removed.length) await tx.productBarcode.deleteMany({ where: { packageId: { in: removed.map(({ id }) => id) } } });
    const productVariants = await tx.productVariant.findMany({ where: { productId }, select: { id: true, sku: true, status: true } });
    const variantsById = new Map(productVariants.map((variant) => [variant.id, variant]));
    const variantsBySku = new Map(productVariants.map((variant) => [variant.sku, variant]));
    for (const { id, barcode, variantSku, variantId, ...row } of input.packages) {
      const variant = variantSku ? variantsBySku.get(variantSku) : variantId ? variantsById.get(variantId) : null;
      if ((variantSku || variantId) && !variant) throw new ValidationError("Package variant does not belong to this product");
      if (variant && row.status !== "INACTIVE" && variant.status === "INACTIVE") throw new ValidationError("Active package cannot reference an inactive variant");
      let parentPackage = null;
      if (row.parentPackageId) {
        if (row.parentPackageId === id) throw new ValidationError("Package cannot be its own parent");
        parentPackage = await tx.productPackage.findFirst({ where: { id: row.parentPackageId, productId, companyId }, select: { id: true, variantId: true, parentPackageId: true } });
        if (!parentPackage) throw new ValidationError("Parent package does not belong to this product");
        if (variant && parentPackage.variantId && parentPackage.variantId !== variant.id) throw new ValidationError("Package parent belongs to a different variant");
        if (id && parentPackage.parentPackageId === id) throw new ValidationError("Package hierarchy cannot contain a direct cycle");
      }
      const data = { ...row, variantId: variant?.id || null };
      const productPackage = id
        ? await tx.productPackage.update({ where: { id, productId }, data })
        : await tx.productPackage.create({ data: { ...data, companyId, productId } });
      await tx.productBarcode.deleteMany({ where: { packageId: productPackage.id } });
      if (barcode) await tx.productBarcode.create({ data: { barcode, companyId, productId, packageId: productPackage.id } });
    }
  }
}

export function createProductRepository(prisma) {
  return {
    async list(companyId, { where = {}, skip, take, orderBy }) {
      const scoped = { companyId, deletedAt: null, ...where };
      const [data, total] = await prisma.$transaction([prisma.product.findMany({ where: scoped, include: PRODUCT_INCLUDE, skip, take, orderBy }), prisma.product.count({ where: scoped })]);
      return { data, total };
    },
    find(companyId, id) { return prisma.product.findFirst({ where: { companyId, id, deletedAt: null }, include: PRODUCT_INCLUDE }); },
    create(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        const { barcodes = [], prices = [], openingStock = [], variants = [], packages = [], images = [], replacePrices: _replacePrices, ...fields } = input;
        void _replacePrices;
        await assertProductReferences(tx, companyId, input);
        const sku = fields.sku || await nextSku(tx, companyId);
        await assertUniqueCodes(tx, companyId, null, { ...input, sku });
        const primaryImage = images.find((row) => row.isPrimary)?.url || images[0]?.url;
        const product = await tx.product.create({ data: { ...fields, imageUrl: fields.imageUrl || primaryImage, sku, companyId,
          stocks: { create: openingStock.map((entry) => ({ ...entry, companyId, reserved: 0 })) } } });
        await createRelations(tx, companyId, product.id, { images, barcodes, variants, packages });
        if (prices.length) await syncExplicitPrices(tx, companyId, product.id, prices);
        await syncLegacyDefaultScopedPrices(tx, companyId, product.id, { variantsTouched: variants.length > 0, packagesTouched: packages.length > 0 });
        if (openingStock.length) await tx.stockMovement.createMany({ data: openingStock.map((entry) => ({ companyId, employeeId, productId: product.id,
          warehouseId: entry.warehouseId, type: "OPENING", quantity: entry.onHand, balanceAfter: entry.onHand })) });
        return tx.product.findUnique({ where: { id: product.id }, include: PRODUCT_INCLUDE });
      }, { isolationLevel: "Serializable" });
    },
    update(companyId, id, input) {
      return prisma.$transaction(async (tx) => {
        const current = await tx.product.findFirst({ where: { id, companyId, deletedAt: null }, include: PRODUCT_INCLUDE });
        if (!current) return null;
        const aggregateStocks = current.stocks.filter((row) => !row.variantId && (!row.stockKey || row.stockKey === "BASE"));
        const onHand = aggregateStocks.reduce((sum, row) => sum + Number(row.onHand), 0);
        for (const field of ["trackSerial", "trackLot", "trackExpiry"]) {
          if (input[field] === true && current[field] === false && onHand > 0) {
            throw new ConflictError(`Cannot enable ${field} while untracked stock exists. Reduce stock to zero, enable tracking, then receive stock with tracking data.`);
          }
        }
        const currentActiveVariants = current.variants.filter((row) => row.status === "ACTIVE");
        const nextActiveVariants = input.variants?.filter((row) => row.status !== "INACTIVE") || null;
        if (nextActiveVariants && currentActiveVariants.length === 0 && nextActiveVariants.length > 0 && onHand > 0) {
          throw new ConflictError("Cannot enable variants while unassigned stock exists. Reduce base stock to zero, create variants, then receive stock per variant.");
        }
        if (input.variants) {
          const nextActiveIds = new Set(nextActiveVariants.flatMap((row) => row.id ? [row.id] : []));
          const stockedVariant = current.stocks.find((row) => row.variantId && (Number(row.onHand) !== 0 || Number(row.reserved) !== 0) && !nextActiveIds.has(row.variantId));
          if (stockedVariant) throw new ConflictError("Cannot remove/deactivate a variant while it has stock or reservations");
        }
        const [serialHistoryCount, lotHistoryCount, expiryHistoryCount] = await Promise.all([
          input.trackSerial === false && current.trackSerial ? tx.productSerial.count({ where: { companyId, productId: id } }) : 0,
          input.trackLot === false && current.trackLot ? tx.productBatch.count({ where: { companyId, productId: id } }) : 0,
          input.trackExpiry === false && current.trackExpiry ? tx.productBatch.count({ where: { companyId, productId: id, expiresAt: { not: null } } }) : 0,
        ]);
        if (serialHistoryCount) throw new ConflictError("Cannot disable serial tracking after serial/IMEI history exists. Archive the product instead to preserve sale and return traceability.");
        if (lotHistoryCount) throw new ConflictError("Cannot disable lot tracking after batch history exists. Archive the product instead to preserve sale and return traceability.");
        if (expiryHistoryCount) throw new ConflictError("Cannot disable expiry tracking after expiry history exists. Archive the product instead to preserve sale and return traceability.");

        const suppliedVariantIds = new Set((input.variants || []).flatMap(({ id: variantId }) => variantId ? [variantId] : []));
        const mergedVariants = input.variants === undefined
          ? current.variants.map((variant) => ({ ...variant, barcodes: variant.barcodes.map(({ barcode }) => barcode) }))
          : [...input.variants, ...current.variants.filter(({ id: variantId }) => !suppliedVariantIds.has(variantId)).map((variant) => ({ ...variant, barcodes: [] }))];
        const mergedPackages = input.packages === undefined
          ? current.packages.map((productPackage) => ({ ...productPackage, barcode: productPackage.barcodes[0]?.barcode }))
          : input.packages;
        const mergedBarcodes = input.barcodes === undefined
          ? current.barcodes.filter(({ variantId, packageId }) => !variantId && !packageId).map(({ barcode, isPrimary }) => ({ barcode, isPrimary }))
          : input.barcodes;
        const codeInput = { ...input, sku: input.sku ?? current.sku, variants: mergedVariants, packages: mergedPackages, barcodes: mergedBarcodes };
        await assertProductReferences(tx, companyId, input); await assertUniqueCodes(tx, companyId, id, codeInput);
        const { barcodes, prices, variants, packages, images, replacePrices, ...fields } = input;
        if (images?.length && !fields.imageUrl) fields.imageUrl = images.find((row) => row.isPrimary)?.url || images[0]?.url;
        if (images && !images.length) fields.imageUrl = null;
        await syncRelations(tx, companyId, id, { barcodes, variants, packages, images });
        if (prices) await syncExplicitPrices(tx, companyId, id, prices, { replaceAll: Boolean(replacePrices) });
        await syncLegacyDefaultScopedPrices(tx, companyId, id, { variantsTouched: variants !== undefined, packagesTouched: packages !== undefined });
        const data = await tx.product.update({ where: { id }, data: fields, include: PRODUCT_INCLUDE });
        return { before: current, data };
      }, { isolationLevel: "Serializable" });
    },
    archive(companyId, id) { return prisma.product.updateMany({ where: { id, companyId, deletedAt: null }, data: { deletedAt: new Date(), status: "ARCHIVED" } }); },
  };
}
