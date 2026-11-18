// 可重放的承运商事件日志：只追加、不覆盖、不删除。
// 每条日志条目带有独立的来源时间(eventTime)、接收时间(receivedAt)与接入序号(entryId)，
// 三者语义不同，不能互相替代：
//  - eventTime 是承运商声称事件发生的时间，用于业务轨迹排序；
//  - receivedAt 是该来源记录被观察到的时间，补传/迟到由它识别；
//  - entryId 是本地接入的严格递增序号，保证重放顺序确定、可追溯。

export const JOURNAL_VERSION = 1;

const STATUSES = new Set(['collected', 'in-transit', 'delivered']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid ${field} in carrier event`);
  }
  return value.trim();
}

function requireTimestamp(value, field) {
  const text = requireString(value, field);
  if (!ISO.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`invalid ${field} in carrier event`);
  }
  return text;
}

// 将一条来源事件规范化为日志条目内容；不做去重，也不修改既有条目。
export function createEntry(event, { now, entryId }) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('carrier event must be an object');
  }
  if (!Number.isInteger(entryId) || entryId < 1) {
    throw new Error('journal entryId must be a positive integer');
  }
  const carrier = requireString(event.carrier, 'carrier');
  const eventId = requireString(event.eventId, 'eventId');
  const parcelId = requireString(event.parcelId, 'parcelId');
  const sequence = event.sequence;
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`invalid sequence in carrier event ${carrier}/${eventId}`);
  }
  const kind = requireString(event.kind, 'kind');
  const eventTime = requireTimestamp(event.eventTime, 'eventTime');
  const receivedAt = requireTimestamp(event.receivedAt, 'receivedAt');
  const recordedAt = requireTimestamp(now, 'recordedAt');
  const retracts = event.retracts === undefined || event.retracts === null
    ? null
    : requireString(event.retracts, 'retracts');
  if (kind === 'retract' && !retracts) {
    throw new Error(`retract event ${carrier}/${eventId} must reference an eventId`);
  }
  if (kind !== 'retract' && !STATUSES.has(kind)) {
    // 未知状态保留原文，投影层会标记待核对，而不是猜测或补造。
  }
  return {
    entryId,
    carrier,
    eventId,
    parcelId,
    sequence,
    kind,
    eventTime,
    receivedAt,
    recordedAt,
    retracts,
    raw: structuredClone(event),
  };
}

// 把一批来源事件追加到日志。重复事件（同 carrier+eventId）不会覆盖原始条目，
// 而是以 duplicateOf 引用首次接入的条目，并保留自己的接收时间与原始载荷；
// 与首次内容冲突时标记 conflict，由投影层给出待核对原因。
export function appendEntries(entries, events, options) {
  const clock = options?.now ?? (() => new Date().toISOString());
  let nextId = entries.length
    ? entries.reduce((max, entry) => Math.max(max, entry.entryId), 0) + 1
    : 1;
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
  const appended = [];
  let duplicateCount = 0;
  let conflictCount = 0;
  for (const event of events) {
    const base = createEntry(event, { now: clock(event), entryId: nextId });
    const first = byKey.get(`${base.carrier}/${base.eventId}`);
    if (first) {
      base.duplicateOf = first.entryId;
      base.duplicate = true;
      duplicateCount += 1;
      if (payloadConflict(first, base)) {
        base.conflict = true;
        conflictCount += 1;
      }
    } else {
      byKey.set(`${base.carrier}/${base.eventId}`, base);
    }
    entries.push(base);
    appended.push(base);
    nextId += 1;
  }
  return { appended, duplicateCount, conflictCount };
}

function entryKey(entry) {
  return `${entry.carrier}/${entry.eventId}`;
}

function payloadConflict(first, candidate) {
  return first.parcelId !== candidate.parcelId
    || first.sequence !== candidate.sequence
    || first.kind !== candidate.kind
    || first.eventTime !== candidate.eventTime
    || first.retracts !== candidate.retracts;
}
