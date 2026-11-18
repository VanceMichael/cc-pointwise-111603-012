import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEntries, createEntry, JOURNAL_VERSION } from '../src/tracking/journal.js';

const clock = () => '2026-11-16T12:00:00Z';
const event = (overrides = {}) => ({
  eventId: 'e1',
  carrier: 'C1',
  parcelId: 'P-1',
  sequence: 1,
  kind: 'collected',
  eventTime: '2026-11-16T08:00:00Z',
  receivedAt: '2026-11-16T08:01:00Z',
  ...overrides,
});

test('日志条目同时保留来源时间、接收时间与本地接入序号', () => {
  const entry = createEntry(event(), { now: clock(), entryId: 1 });
  assert.equal(entry.eventTime, '2026-11-16T08:00:00Z');
  assert.equal(entry.receivedAt, '2026-11-16T08:01:00Z');
  assert.equal(entry.recordedAt, '2026-11-16T12:00:00Z');
  assert.equal(entry.entryId, 1);
  assert.equal(entry.retracts, null);
  assert.equal(JOURNAL_VERSION, 1);
  assert.deepEqual(entry.raw, event());
});

test('接入序号严格递增，重放同一批事件得到同样的追加顺序', () => {
  const entries = [];
  appendEntries(entries, [event({ eventId: 'e2', sequence: 2 }), event({ eventId: 'e3', sequence: 3 })], { now: clock });
  const replay = [];
  appendEntries(replay, [event({ eventId: 'e2', sequence: 2 }), event({ eventId: 'e3', sequence: 3 })], { now: clock });
  assert.deepEqual(replay.map((entry) => entry.entryId), [1, 2]);
  assert.deepEqual(entries.map((entry) => entry.entryId), [1, 2]);
});

test('重复事件不覆盖原始条目，而是引用首次接入并保留自己的接收时间', () => {
  const entries = [];
  appendEntries(entries, [event({ receivedAt: '2026-11-16T09:00:00Z' })], { now: clock });
  const result = appendEntries(entries, [event({ receivedAt: '2026-11-16T11:00:00Z' })], { now: clock });
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.conflictCount, 0);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].receivedAt, '2026-11-16T09:00:00Z');
  assert.equal(entries[1].duplicateOf, entries[0].entryId);
  assert.equal(entries[1].receivedAt, '2026-11-16T11:00:00Z');
  assert.equal(entries[1].duplicate, true);
});

test('同一身份但内容冲突的重复事件被标记，原始载荷仍然保留', () => {
  const entries = [];
  appendEntries(entries, [event({ kind: 'in-transit', sequence: 2 })], { now: clock });
  const result = appendEntries(entries, [event({ kind: 'delivered', sequence: 2 })], { now: clock });
  assert.equal(result.conflictCount, 1);
  assert.equal(entries[0].kind, 'in-transit');
  assert.equal(entries[1].kind, 'delivered');
  assert.equal(entries[1].conflict, true);
});

test('eventId 仅在承运商内唯一：不同承运商的相同 eventId 是不同条目', () => {
  const entries = [];
  const result = appendEntries(entries, [
    event({ carrier: 'C1' }),
    event({ carrier: 'C2' }),
  ], { now: clock });
  assert.equal(result.duplicateCount, 0);
  assert.equal(entries.length, 2);
});

test('撤回事件必须携带 retracts 引用', () => {
  assert.throws(
    () => createEntry(event({ kind: 'retract', retracts: undefined }), { now: clock(), entryId: 1 }),
    /must reference an eventId/,
  );
  const retract = createEntry(event({ kind: 'retract', retracts: 'e3', sequence: 4 }), { now: clock(), entryId: 2 });
  assert.equal(retract.retracts, 'e3');
});

test('非法时间、序号或缺字段被明确拒绝而不是写入日志', () => {
  assert.throws(() => createEntry(event({ eventTime: 'not-a-date' }), { now: clock(), entryId: 1 }), /invalid eventTime/);
  assert.throws(() => createEntry(event({ receivedAt: '2026-11-16' }), { now: clock(), entryId: 1 }), /invalid receivedAt/);
  assert.throws(() => createEntry(event({ sequence: 0 }), { now: clock(), entryId: 1 }), /invalid sequence/);
  assert.throws(() => createEntry(event({ carrier: '  ' }), { now: clock(), entryId: 1 }), /invalid carrier/);
  assert.throws(() => createEntry(event(), { now: clock(), entryId: 0 }), /positive integer/);
});
