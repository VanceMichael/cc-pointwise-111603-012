import { buildProjection } from './projection.js';

// 客服业务读取入口：展示的是从日志重放得到的投影，而不是“最后收到的一条”。
// 每一行都带有状态可信度（confirmed/pending-review/unknown）、待核对原因、
// 时间线（含撤回状态）、重复接收与补传记录，以及对应的检查点历史。
export async function readTrackingOperations(journal, options = {}) {
  const entries = await journal.read();
  const projection = buildProjection(entries);
  const rows = projection.parcels
    .filter((parcel) => !options.parcel || parcel.parcelId === options.parcel)
    .map((parcel) => ({
      parcelKey: parcel.key,
      parcelId: parcel.parcelId,
      carrier: parcel.carrier,
      status: parcel.status,
      assurance: parcel.assurance,
      reasons: parcel.reasons,
      timeline: parcel.timeline,
      retractions: parcel.retractions,
      duplicates: parcel.duplicates,
      lateArrivals: parcel.lateArrivals,
      observedSequences: parcel.observedSequences,
      counts: parcel.counts,
    }));
  return {
    product: '包裹轨迹客服投影',
    basis: 'append-only event journal replay',
    totals: projection.totals,
    rows,
  };
}

export async function readEventLog(journal) {
  const entries = await journal.read();
  return {
    product: '包裹轨迹事件日志',
    totals: { entries: entries.length, batches: new Set(entries.map((entry) => entry.batchId)).size },
    entries,
  };
}
