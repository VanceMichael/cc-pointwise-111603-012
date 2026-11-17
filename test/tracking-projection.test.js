import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckpoints, buildProjection, reasonFingerprint } from '../src/tracking/projection.js';

let counter = 0;
function entry(raw, batchId = 'batch-1', batchSequence = 1, recordedAt = raw.receivedAt) {
  counter += 1;
  return { entryId: `entry-${counter}`, batchId, batchSequence, sequenceInLog: counter, recordedAt, raw };
}

test.beforeEach(() => { counter = 0; });

function event(overrides = {}) {
  return {
    ...{
      eventId: 'e1', carrier: 'C1', parcelId: 'P-1', sequence: 1,
      kind: 'collected', eventTime: '2026-11-16T08:00:00Z',
      receivedAt: '2026-11-16T08:00:00Z',
    },
    ...overrides,
  };
}

function codes(parcel) {
  return parcel.reasons.map((item) => item.code);
}

test('乱序到达不会把最后收到的一条当成包裹状态', () => {
  const entries = [
    entry(event({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z' })),
    entry(event({ eventId: 'e2', sequence: 2, kind: 'in-transit', eventTime: '2026-11-16T08:30:00Z' })),
    entry(event({ eventId: 'e1', sequence: 1, kind: 'collected', eventTime: '2026-11-16T08:00:00Z' })),
  ];
  const view = buildProjection(entries);
  const parcel = view.parcels[0];
  assert.equal(parcel.status, 'delivered');
  assert.equal(parcel.assurance, 'confirmed');
  assert.deepEqual(parcel.timeline.map((row) => row.sequence), [1, 2, 3]);
  // e1/e2 都在 seq3 之后才接收，是补传而不是新的物流动作（按序号输出）
  assert.deepEqual(parcel.lateArrivals.map((row) => row.eventId), ['e1', 'e2']);
  assert.ok(codes(parcel).includes('late-arrival'));
});

test('序号缺口与缺少揽收起点时进入待核对，而不是补造运输过程', () => {
  const entries = [
    entry(event({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z' })),
  ];
  const parcel = buildProjection(entries).parcels[0];
  assert.equal(parcel.assurance, 'pending-review');
  const current = new Set(codes(parcel));
  assert.ok(current.has('sequence-gap'));
  assert.ok(current.has('missing-collected'));
  const gap = parcel.reasons.find((item) => item.code === 'sequence-gap');
  assert.deepEqual(gap.evidence.missing, [1, 2]);
  assert.deepEqual(gap.evidence.range, { from: 1, to: 3 });
});

test('迟到揽收补齐后恢复可解释轨迹，并保留曾经无法确定的检查点依据', () => {
  const first = [
    entry(event({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z', receivedAt: '2026-11-16T09:00:00Z' }), 'batch-1', 1, '2026-11-16T09:00:00Z'),
  ];
  const second = [
    entry(event({ eventId: 'e1', sequence: 1, kind: 'collected', eventTime: '2026-11-16T08:00:00Z', receivedAt: '2026-11-16T10:00:00Z' }), 'batch-2', 2, '2026-11-16T10:00:00Z'),
    entry(event({ eventId: 'e2', sequence: 2, kind: 'in-transit', eventTime: '2026-11-16T08:30:00Z', receivedAt: '2026-11-16T10:00:00Z' }), 'batch-2', 2, '2026-11-16T10:00:00Z'),
  ];
  const checkpoints = buildCheckpoints([...first, ...second]);
  assert.equal(checkpoints.length, 2);
  const firstView = checkpoints[0].parcels['C1/P-1'];
  assert.equal(firstView.assurance, 'pending-review');
  assert.ok(firstView.opened.some((item) => item.code === 'sequence-gap'));
  const secondView = checkpoints[1].parcels['C1/P-1'];
  assert.equal(secondView.assurance, 'confirmed');
  assert.equal(secondView.status, 'delivered');
  // 缺口原因在本批被消除，检查点里保留它曾经存在以及被补齐的事实
  assert.ok(secondView.resolved.some((item) => item.code === 'sequence-gap' && item.previousBatchId === 'batch-1'));
  // 最终投影不再有待核对项，但补传事实仍保留
  const finalParcel = buildProjection([...first, ...second]).parcels[0];
  assert.equal(finalParcel.assurance, 'confirmed');
  assert.deepEqual(finalParcel.lateArrivals.map((row) => row.eventId), ['e1', 'e2']);
});

test('承运商撤回扫错的签收后，状态回退且撤回引用可追踪', () => {
  const entries = [
    entry(event({ eventId: 'e1', sequence: 1, kind: 'collected' })),
    entry(event({ eventId: 'e2', sequence: 2, kind: 'in-transit', eventTime: '2026-11-16T08:30:00Z' })),
    entry(event({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z' })),
    entry(event({ eventId: 'e4', sequence: 4, kind: 'retract', retracts: 'e3', eventTime: '2026-11-16T10:00:00Z', receivedAt: '2026-11-16T10:00:00Z' })),
  ];
  const parcel = buildProjection(entries).parcels[0];
  assert.equal(parcel.status, 'in-transit');
  assert.equal(parcel.assurance, 'confirmed');
  const delivered = parcel.timeline.find((row) => row.eventId === 'e3');
  assert.equal(delivered.state, 'retracted');
  assert.equal(delivered.retractedBy, 'e4');
  const retraction = parcel.retractions.find((row) => row.eventId === 'e4');
  assert.equal(retraction.retracts, 'e3');
  assert.equal(retraction.active, true);
  assert.ok(codes(parcel).includes('delivery-retracted'));
});

test('重复事件被记录但只去重一次，内容冲突的重复进入待核对', () => {
  const consistent = [
    entry(event(), 'batch-1'),
    entry(event(), 'batch-2', 2),
  ];
  const parcel = buildProjection(consistent).parcels[0];
  assert.equal(parcel.counts.duplicateReceipts, 1);
  assert.equal(parcel.duplicates[0].receiptCount, 2);
  assert.equal(parcel.duplicates[0].conflict, false);
  assert.equal(parcel.counts.canonicalEvents, 1);
  assert.ok(codes(parcel).includes('duplicate-receipt'));
  assert.equal(parcel.assurance, 'confirmed');

  const conflicting = [
    entry(event(), 'batch-1'),
    entry(event({ eventTime: '2026-11-16T11:00:00Z' }), 'batch-2', 2),
  ];
  const conflictParcel = buildProjection(conflicting).parcels[0];
  assert.equal(conflictParcel.duplicates[0].conflict, true);
  assert.ok(codes(conflictParcel).includes('duplicate-conflict'));
  assert.equal(conflictParcel.assurance, 'pending-review');
});

test('撤回一条撤回：原签收恢复为有效，撤回链状态可解释', () => {
  const entries = [
    entry(event({ eventId: 'e1', sequence: 1, kind: 'collected' })),
    entry(event({ eventId: 'e2', sequence: 2, kind: 'in-transit', eventTime: '2026-11-16T08:30:00Z' })),
    entry(event({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z' })),
    entry(event({ eventId: 'r1', sequence: 4, kind: 'retract', retracts: 'e3', eventTime: '2026-11-16T10:00:00Z', receivedAt: '2026-11-16T10:00:00Z' })),
    entry(event({ eventId: 'r2', sequence: 5, kind: 'retract', retracts: 'r1', eventTime: '2026-11-16T11:00:00Z', receivedAt: '2026-11-16T11:00:00Z' })),
  ];
  const parcel = buildProjection(entries).parcels[0];
  // r1 被 r2 撤回，因此 r1 对 e3 的撤回不再生效，签收恢复
  assert.equal(parcel.status, 'delivered');
  assert.equal(parcel.assurance, 'confirmed');
  const delivered = parcel.timeline.find((row) => row.eventId === 'e3');
  assert.equal(delivered.state, 'active');
  const r1 = parcel.retractions.find((row) => row.eventId === 'r1');
  const r2 = parcel.retractions.find((row) => row.eventId === 'r2');
  assert.equal(r1.active, false);
  assert.equal(r1.retractedBy, 'r2');
  assert.equal(r2.active, true);
});

test('悬空撤回与撤回环不会被悄悄丢弃，而是给出待核对原因', () => {
  const dangling = [
    entry(event()),
    entry(event({ eventId: 'r1', sequence: 5, kind: 'retract', retracts: 'missing', eventTime: '2026-11-16T12:00:00Z', receivedAt: '2026-11-16T12:00:00Z' })),
  ];
  const parcel = buildProjection(dangling).parcels[0];
  assert.ok(codes(parcel).includes('dangling-retract'));
  assert.equal(parcel.assurance, 'pending-review');
  assert.equal(parcel.retractions[0].targetKnown, false);

  const cyclic = [
    entry(event()),
    entry(event({ eventId: 'r1', sequence: 5, kind: 'retract', retracts: 'r2', eventTime: '2026-11-16T12:00:00Z', receivedAt: '2026-11-16T12:00:00Z' })),
    entry(event({ eventId: 'r2', sequence: 6, kind: 'retract', retracts: 'r1', eventTime: '2026-11-16T12:01:00Z', receivedAt: '2026-11-16T12:01:00Z' })),
  ];
  const cyclicParcel = buildProjection(cyclic).parcels[0];
  assert.ok(codes(cyclicParcel).includes('retract-cycle'));
  assert.equal(cyclicParcel.assurance, 'pending-review');
});

test('非法状态跳跃和签收后的新扫描被识别为矛盾', () => {
  const jump = [
    entry(event({ eventId: 'e1', sequence: 1, kind: 'collected' })),
    entry(event({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z' })),
  ];
  const parcel = buildProjection(jump).parcels[0];
  assert.ok(codes(parcel).includes('sequence-gap'));
  assert.ok(codes(parcel).includes('illegal-transition'));

  const afterDelivery = [
    entry(event({ eventId: 'e1', sequence: 1, kind: 'collected' })),
    entry(event({ eventId: 'e2', sequence: 2, kind: 'in-transit', eventTime: '2026-11-16T08:30:00Z' })),
    entry(event({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z' })),
    entry(event({ eventId: 'e4', sequence: 4, kind: 'in-transit', eventTime: '2026-11-16T09:30:00Z', receivedAt: '2026-11-16T09:30:00Z' })),
  ];
  const second = buildProjection(afterDelivery).parcels[0];
  assert.ok(codes(second).includes('delivered-not-final'));
  assert.equal(second.assurance, 'pending-review');
});

test('同一序号被多个事件占用时报序号冲突', () => {
  const entries = [
    entry(event({ eventId: 'a', sequence: 1 })),
    entry(event({ eventId: 'b', sequence: 1 })),
  ];
  const parcel = buildProjection(entries).parcels[0];
  assert.ok(codes(parcel).includes('sequence-conflict'));
  assert.deepEqual(parcel.reasons.find((item) => item.code === 'sequence-conflict').evidence.eventIds, ['a', 'b']);
});

test('原因指纹稳定且可用于检查点状态跟踪', () => {
  const reason = { code: 'sequence-gap', severity: 'blocking', message: 'm', evidence: { missing: [1], range: { to: 3, from: 2 } } };
  assert.equal(reasonFingerprint(reason), reasonFingerprint({ ...reason, message: 'different' }));
  assert.notEqual(reasonFingerprint(reason), reasonFingerprint({ ...reason, evidence: { missing: [2] } }));
});

test('多个包裹按 carrier/parcelId 分组投影，空日志给出空结果', () => {
  assert.deepEqual(buildProjection([]).totals, { entries: 0, parcels: 0, pendingReview: 0 });
  const entries = [
    entry(event({ eventId: 'a1', parcelId: 'P-A' })),
    entry(event({ eventId: 'b1', parcelId: 'P-B' })),
  ];
  const view = buildProjection(entries);
  assert.deepEqual(view.parcels.map((parcel) => parcel.parcelId), ['P-A', 'P-B']);
  assert.equal(view.totals.parcels, 2);
});
