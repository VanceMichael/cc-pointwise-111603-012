import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEntries } from '../src/tracking/journal.js';
import { buildParcelProjection, buildProjections } from '../src/tracking/projection.js';

let tick = 0;
const clock = () => new Date(Date.parse('2026-11-16T12:00:00Z') + tick++ * 1000).toISOString();

function project(events, parcelId = 'P-1') {
  const entries = [];
  appendEntries(entries, events, { now: clock });
  return buildParcelProjection(parcelId, entries.filter((entry) => entry.parcelId === parcelId));
}

const hour = (sequence) => String(7 + sequence).padStart(2, '0');
const statusEvent = (eventId, sequence, kind, overrides = {}) => ({
  eventId,
  carrier: 'C1',
  parcelId: 'P-1',
  sequence,
  kind,
  eventTime: `2026-11-16T${hour(sequence)}:00:00Z`,
  receivedAt: `2026-11-16T${hour(sequence)}:05:00Z`,
  ...overrides,
});

const collected = (sequence = 1, overrides = {}) => statusEvent(`e${sequence}`, sequence, 'collected', overrides);
const inTransit = (sequence = 2, overrides = {}) => statusEvent(`e${sequence}`, sequence, 'in-transit', overrides);
const delivered = (sequence = 3, overrides = {}) => statusEvent(`e${sequence}`, sequence, 'delivered', overrides);
const retract = (eventId, retracts, sequence, overrides = {}) => ({
  eventId, carrier: 'C1', parcelId: 'P-1', sequence, kind: 'retract', retracts,
  eventTime: `2026-11-16T${hour(sequence)}:30:00Z`,
  receivedAt: `2026-11-16T${hour(sequence)}:35:00Z`,
  ...overrides,
});

const codes = (parcel) => parcel.reasons.map((reason) => reason.code);

test('合法完整轨迹投影为确定状态，且时间线按来源序号而非接收顺序', () => {
  // 接收顺序故意颠倒：先到 e3、e2，后到 e1。
  const parcel = project([
    delivered(3, { receivedAt: '2026-11-16T09:05:00Z' }),
    inTransit(2, { receivedAt: '2026-11-16T09:05:00Z' }),
    collected(1, { receivedAt: '2026-11-16T10:00:00Z' }),
  ]);
  assert.equal(parcel.currentStatus, 'delivered');
  assert.equal(parcel.status, 'delivered');
  assert.equal(parcel.needsReview, false);
  assert.deepEqual(parcel.timeline.map((row) => row.eventId), ['e1', 'e2', 'e3']);
  // 揽收补传：业务序号更小却更晚收到，应被标记为迟到。
  assert.equal(parcel.timeline.find((row) => row.eventId === 'e1').lateArrival, true);
});

test('缺少揽收与序列缺口时给出待核对原因，不补造中间状态', () => {
  const parcel = project([inTransit(2), delivered(4)]);
  assert.equal(parcel.status, 'needs-review');
  assert.equal(parcel.currentStatus, null);
  assert.ok(codes(parcel).includes('missing-collected'));
  const gap = parcel.reasons.find((reason) => reason.code === 'sequence-gap');
  assert.deepEqual(gap.missingSequences, [1, 3]);
});

test('撤回一次扫错的签收后，当前状态回到在途且签收在时间线中保留为已撤回', () => {
  const parcel = project([
    collected(1),
    inTransit(2),
    delivered(3),
    retract('e9', 'e3', 4),
  ]);
  assert.equal(parcel.needsReview, false);
  assert.equal(parcel.currentStatus, 'in-transit');
  assert.deepEqual(parcel.retractedEventIds, ['e3']);
  const deliveredRow = parcel.timeline.find((row) => row.eventId === 'e3');
  assert.equal(deliveredRow.retracted, true);
  assert.equal(parcel.retractions[0].effective, true);
  assert.equal(parcel.retractions[0].targetEntryId, 3);
});

test('撤回引用不存在的事件时标记待核对，而不是凭空制造反向动作', () => {
  const parcel = project([
    collected(1),
    retract('e9', 'e-missing', 2),
  ]);
  assert.equal(parcel.status, 'needs-review');
  const reason = parcel.reasons.find((item) => item.code === 'retract-target-missing');
  assert.equal(reason.retracts, 'e-missing');
});

test('撤回另一条撤回不是有效撤销', () => {
  const parcel = project([
    collected(1),
    retract('r1', 'e1', 2),
    retract('r2', 'r1', 3),
  ]);
  assert.ok(codes(parcel).includes('retract-target-not-status'));
  assert.equal(parcel.retractions.every((item) => !item.effective || item.eventId === 'r1'), true);
});

test('状态机矛盾（重复状态、倒流）逐条报告非法跳转', () => {
  const parcel = project([
    collected(1),
    inTransit(2),
    inTransit(3, { eventId: 'e3b' }),
    collected(4, { eventId: 'e4' }),
  ]);
  const illegal = parcel.reasons.filter((reason) => reason.code === 'illegal-transition');
  assert.equal(illegal.length, 2);
  assert.deepEqual(illegal.map((reason) => reason.to), ['in-transit', 'collected']);
  assert.equal(parcel.status, 'needs-review');
});

test('来源时间倒流与未知状态都进入待核对', () => {
  const parcel = project([
    collected(1, { eventTime: '2026-11-16T10:00:00Z' }),
    inTransit(2, { eventTime: '2026-11-16T09:00:00Z' }),
    statusEvent('ex', 3, 'custom-scan', { eventTime: '2026-11-16T11:00:00Z' }),
  ]);
  assert.ok(codes(parcel).includes('event-time-out-of-order'));
  assert.ok(codes(parcel).includes('unknown-status'));
});

test('同一序号被两个事件占用时报告序号冲突', () => {
  const parcel = project([
    collected(1),
    inTransit(2, { eventId: 'e2a' }),
    delivered(2, { eventId: 'e2b' }),
  ]);
  const conflict = parcel.reasons.find((reason) => reason.code === 'sequence-conflict');
  assert.deepEqual(conflict.eventIds.sort(), ['e2a', 'e2b']);
});

test('重复与冲突事件可在投影中追踪，首次接入保持为权威条目', () => {
  const parcel = project([
    collected(1),
    inTransit(2),
    // 完全重复
    { ...inTransit(2), receivedAt: '2026-11-16T12:00:00Z' },
    // 同身份冲突
    { ...inTransit(2), kind: 'delivered', receivedAt: '2026-11-16T12:05:00Z' },
  ]);
  assert.equal(parcel.duplicates.length, 2);
  assert.equal(parcel.duplicates.filter((item) => item.conflict).length, 1);
  assert.ok(codes(parcel).includes('conflicting-duplicate'));
  const row = parcel.timeline.find((item) => item.eventId === 'e2');
  assert.equal(row.duplicateArrivals.length, 2);
});

test('投影是纯函数：同一日志重复构建得到完全一致的结果', () => {
  const events = [delivered(3), inTransit(2), collected(1)];
  const first = project(events);
  const second = project(events);
  assert.deepEqual(second, first);
  const all = buildProjections(buildEntries(events));
  assert.equal(all.parcelCount, 1);
  assert.equal(all.needsReviewCount, 0);
});

test('不同包裹分别投影，互不串扰', () => {
  const entries = [];
  appendEntries(entries, [
    { ...collected(1), parcelId: 'P-A' },
    { ...delivered(3), parcelId: 'P-B' },
  ], { now: clock });
  const all = buildProjections(entries);
  assert.deepEqual(all.parcels.map((parcel) => parcel.parcelId), ['P-A', 'P-B']);
  assert.equal(all.parcels.find((parcel) => parcel.parcelId === 'P-B').status, 'needs-review');
});

function buildEntries(events) {
  const entries = [];
  appendEntries(entries, events, { now: clock });
  return entries;
}
