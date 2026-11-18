// 轨迹接入服务：把来源事件写入可重放日志，并维护客服投影及其历史。
// 历史快照保留每次接入后的结论与待核对原因，因此即使迟到事件后来补齐了轨迹，
// 也能追溯“之前为什么不能确定”。
import { appendEntries, JOURNAL_VERSION } from './journal.js';
import { buildProjections } from './projection.js';
import { JOURNAL_FILE, PROJECTION_FILE } from './store.js';

export class TrackingService {
  constructor(store, options = {}) {
    this.store = store;
    // 时钟可注入，测试无需等待真实时间；默认用当前 UTC 时间。
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  // 接入一批来源事件。返回值同时报告重复与冲突，调用方不能把它们静默吞掉。
  async intake(events) {
    if (!Array.isArray(events)) throw new TypeError('intake input must be an array');
    const entries = await this.store.readJournal();
    const previousEntryCount = entries.length;
    const { appended, duplicateCount, conflictCount } = appendEntries(entries, events, { now: this.clock });

    const projection = buildProjections(entries);
    const prior = await this.store.readProjection();
    const affectedParcels = [...new Set(appended.map((entry) => entry.parcelId))];
    const builtAt = this.clock();
    const snapshot = {
      builtAt,
      journalEntryCount: entries.length,
      addedEntryIds: appended.map((entry) => entry.entryId),
      affectedParcels,
      parcels: projection.parcels,
    };
    const nextProjection = {
      version: 1,
      lastJournalEntryId: entries.reduce((max, entry) => Math.max(max, entry.entryId), 0),
      builtAt,
      parcels: projection.parcels,
      parcelCount: projection.parcelCount,
      needsReviewCount: projection.needsReviewCount,
      history: [...prior.history, snapshot],
    };

    // 日志与投影一起落盘；任一失败都不留下半截状态（两份文件各自原子写）。
    await this.store.writeJournal(entries);
    await this.store.writeProjection(nextProjection);
    return {
      received: events.length,
      appended: appended.length,
      duplicates: duplicateCount,
      conflicts: conflictCount,
      journalEntries: entries.length,
      newEntryIds: appended.map((entry) => entry.entryId),
      affectedParcels,
      parcelCount: projection.parcelCount,
      needsReviewCount: projection.needsReviewCount,
    };
  }

  async listParcels() {
    const projection = await this.store.readProjection();
    return {
      product: '包裹轨迹汇集器',
      builtAt: projection.builtAt,
      lastJournalEntryId: projection.lastJournalEntryId,
      parcelCount: projection.parcels.length,
      needsReviewCount: projection.parcels.filter((parcel) => parcel.needsReview).length,
      parcels: projection.parcels.map((parcel) => ({
        parcelId: parcel.parcelId,
        carriers: parcel.carriers,
        status: parcel.status,
        currentStatus: parcel.currentStatus,
        needsReview: parcel.needsReview,
        reasonCodes: parcel.reasons.map((reason) => reason.code),
        timelineLength: parcel.timeline.length,
        lastReceivedAt: parcel.observed.lastReceivedAt,
      })),
    };
  }

  async getParcel(parcelId) {
    const projection = await this.store.readProjection();
    const current = projection.parcels.find((parcel) => parcel.parcelId === parcelId);
    if (!current) {
      const error = new Error(`unknown parcel: ${parcelId}`);
      error.code = 'PARCEL_NOT_FOUND';
      throw error;
    }
    // 只返回与该包裹相关的历史快照，保留每次接入时的结论与依据。
    const parcelHistory = projection.history
      .filter((snapshot) => snapshot.affectedParcels.includes(parcelId))
      .map((snapshot) => ({
        builtAt: snapshot.builtAt,
        journalEntryCount: snapshot.journalEntryCount,
        addedEntryIds: snapshot.addedEntryIds,
        parcel: snapshot.parcels.find((item) => item.parcelId === parcelId) ?? null,
      }));
    return { ...current, history: parcelHistory };
  }

  async readJournalEntries() {
    return this.store.readJournal();
  }

  // 重放：丢弃当前投影，只凭事件日志重新推导，并与已存投影逐包裹核对。
  // 这证明投影完全由日志决定，也能发现任何与日志不一致的存储状态。
  async replay() {
    const entries = await this.store.readJournal();
    const rebuilt = buildProjections(entries);
    const stored = await this.store.readProjection();
    const mismatches = compareProjections(stored.parcels, rebuilt.parcels);
    const historyCheck = checkHistory(stored.history, entries);
    return {
      journalVersion: JOURNAL_VERSION,
      journalEntries: entries.length,
      parcelCount: rebuilt.parcelCount,
      needsReviewCount: rebuilt.needsReviewCount,
      projectionMismatches: mismatches,
      historySnapshots: stored.history.length,
      historyCheck,
      files: { journal: JOURNAL_FILE, projection: PROJECTION_FILE },
      consistent: mismatches.length === 0 && historyCheck.consistent,
    };
  }
}

function compareProjections(storedParcels, rebuiltParcels) {
  const mismatches = [];
  const rebuiltById = new Map(rebuiltParcels.map((parcel) => [parcel.parcelId, parcel]));
  for (const stored of storedParcels) {
    const rebuilt = rebuiltById.get(stored.parcelId);
    if (!rebuilt) {
      mismatches.push({ parcelId: stored.parcelId, code: 'missing-after-rebuild' });
      continue;
    }
    const storedSignature = signature(stored);
    const rebuiltSignature = signature(rebuilt);
    if (JSON.stringify(storedSignature) !== JSON.stringify(rebuiltSignature)) {
      mismatches.push({ parcelId: stored.parcelId, code: 'projection-diverged' });
    }
  }
  for (const rebuilt of rebuiltParcels) {
    if (!storedParcels.some((stored) => stored.parcelId === rebuilt.parcelId)) {
      mismatches.push({ parcelId: rebuilt.parcelId, code: 'missing-in-storage' });
    }
  }
  return mismatches;
}

// 比较时排除运行期元数据，只比较业务结论本身。
function signature(parcel) {
  return {
    status: parcel.status,
    currentStatus: parcel.currentStatus,
    needsReview: parcel.needsReview,
    reasons: parcel.reasons,
    timeline: parcel.timeline.map((row) => ({
      eventId: row.eventId,
      sequence: row.sequence,
      kind: row.kind,
      retracted: row.retracted ?? false,
      lateArrival: row.lateArrival ?? false,
    })),
    retractions: parcel.retractions,
    duplicates: parcel.duplicates,
    retractedEventIds: parcel.retractedEventIds,
    observed: parcel.observed,
  };
}

function checkHistory(history, entries) {
  const maxEntryId = entries.reduce((max, entry) => Math.max(max, entry.entryId), 0);
  const last = history.at(-1);
  if (!last) {
    return { consistent: entries.length === 0, reason: entries.length ? 'history-missing' : null };
  }
  if (last.journalEntryCount !== entries.length) {
    return { consistent: false, reason: 'history-journal-count-mismatch' };
  }
  const declared = new Set(last.addedEntryIds);
  const within = [...declared].every((id) => id >= 1 && id <= maxEntryId);
  return { consistent: within, reason: within ? null : 'history-entry-out-of-range', lastBuiltAt: last.builtAt };
}
