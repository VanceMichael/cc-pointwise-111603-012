const fields = ["eventId", "carrier", "parcelId", "sequence", "kind", "eventTime", "receivedAt"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "包裹轨迹汇集器", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
