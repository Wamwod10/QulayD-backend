export async function nextDocumentNumber(prisma, companyId, type, prefix, date = new Date()) {
  const year = date.getUTCFullYear();
  const sequence = await prisma.documentSequence.upsert({
    where: { companyId_type_year: { companyId, type, year } },
    create: { companyId, type, prefix, year, value: 1 },
    update: { value: { increment: 1 }, prefix },
  });
  return `${sequence.prefix}-${year}-${String(sequence.value).padStart(6, "0")}`;
}
