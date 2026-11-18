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

// 轨迹接入保留来源事件的完整原始属性；来源时间、接收时间与序号各自独立传递，
// 由日志层分别保存，适配层不做任何“最新覆盖”或顺序假设。
export function toCarrierEvents(page) {
  return page.records.map((record) => structuredClone(record.attributes));
}
