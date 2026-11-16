export const entryPath = "/carriers/C1/events";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["eventId"]),
    source: "包裹轨迹汇集器",
    observedAt: item["eventTime"],
    label: String(item["kind"]),
    attributes: structuredClone(item),
  })) };
}
