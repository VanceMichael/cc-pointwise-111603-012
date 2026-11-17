// 承运商事件页适配：不丢弃任何来源字段，raw 保存原始事件，
// eventTime（来源时间）、receivedAt（接收时间）与本地 recordedAt 分开。
export const trackingEntryPath = '/carriers/C1/events';

const REQUIRED = ['eventId', 'carrier', 'parcelId', 'sequence', 'kind', 'eventTime', 'receivedAt'];

export function parseEventFeed(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  return {
    next: payload.next ?? null,
    events: payload.items.map((item) => normalizeCarrierEvent(item)),
  };
}

export function normalizeCarrierEvent(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('carrier event must be an object');
  }
  for (const field of REQUIRED) {
    if (item[field] === undefined || item[field] === null || String(item[field]).trim() === '') {
      throw new Error(`missing ${field} for carrier event`);
    }
  }
  if (!Number.isFinite(Number(item.sequence)) || !Number.isInteger(Number(item.sequence))) {
    throw new Error(`invalid sequence for carrier event ${item.eventId}`);
  }
  if (!Number.isFinite(Date.parse(String(item.eventTime)))) {
    throw new Error(`invalid eventTime for carrier event ${item.eventId}`);
  }
  if (!Number.isFinite(Date.parse(String(item.receivedAt)))) {
    throw new Error(`invalid receivedAt for carrier event ${item.eventId}`);
  }
  if (item.kind === 'retract' && !item.retracts) {
    throw new Error(`retract event ${item.eventId} must reference a target via retracts`);
  }
  // 深拷贝原始载荷，日志里保存的是接收当下的事实，后续改动不会回溯污染。
  return structuredClone(item);
}
