import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventJournal } from '../src/tracking/journal.js';
import { TrackingService } from '../src/tracking/service.js';
import { normalizeCarrierEvent, parseEventFeed } from '../src/tracking/adapter.js';
import { readEventLog, readTrackingOperations } from '../src/tracking/operations.js';

const baseEvent = (overrides = {}) => ({
  ...{
    eventId: 'e1', carrier: 'C1', parcelId: 'P-1', sequence: 1,
    kind: 'collected', eventTime: '2026-11-16T08:00:00Z',
    receivedAt: '2026-11-16T08:00:00Z',
  },
  ...overrides,
});

test('日志只追加：重复接收与撤回都保留原始 entry，重放得到同一投影', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracking-journal-'));
  try {
    const journal = new EventJournal(join(directory, 'events.json'));
    let tick = 0;
    const clock = () => `2026-11-16T1${tick++}:00:00Z`;
    const service = new TrackingService(journal, clock);

    const first = await service.record([
      baseEvent({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z', receivedAt: '2026-11-16T09:00:00Z' }),
    ]);
    assert.equal(first.recorded, 1);
    assert.equal(first.totalEntries, 1);
    assert.equal(first.projection.parcels[0].assurance, 'pending-review');

    // 同一条事件再次接收：日志新增 entry 而不是覆盖
    const duplicate = await service.record([baseEvent({ eventId: 'e3', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z', receivedAt: '2026-11-16T09:00:00Z' })]);
    assert.equal(duplicate.totalEntries, 2);

    // 补传揽收与运输节点 + 撤回签收
    const repaired = await service.record([
      baseEvent({ eventId: 'e1', sequence: 1, kind: 'collected', eventTime: '2026-11-16T08:00:00Z', receivedAt: '2026-11-16T10:00:00Z' }),
      baseEvent({ eventId: 'e2', sequence: 2, kind: 'in-transit', eventTime: '2026-11-16T08:30:00Z', receivedAt: '2026-11-16T10:00:00Z' }),
      baseEvent({ eventId: 'e4', sequence: 4, kind: 'retract', retracts: 'e3', eventTime: '2026-11-16T10:05:00Z', receivedAt: '2026-11-16T10:05:00Z' }),
    ]);
    assert.equal(repaired.totalEntries, 5);
    const parcel = repaired.projection.parcels[0];
    assert.equal(parcel.status, 'in-transit');
    assert.equal(parcel.assurance, 'confirmed');

    const onDisk = JSON.parse(await readFile(join(directory, 'events.json'), 'utf8'));
    assert.equal(onDisk.entries.length, 5);
    assert.ok(onDisk.entries.every((entry) => entry.raw && entry.recordedAt && entry.batchId));

    // 全新实例重放：结果一致，检查点保留“曾经不能确定”的依据
    const replay = await new TrackingService(new EventJournal(join(directory, 'events.json'))).replay();
    assert.equal(replay.entries.length, 5);
    assert.equal(replay.projection.parcels[0].status, 'in-transit');
    assert.equal(replay.checkpoints.length, 3);
    assert.ok(replay.checkpoints[0].parcels['C1/P-1'].opened.some((item) => item.code === 'sequence-gap'));
    assert.ok(replay.checkpoints[2].parcels['C1/P-1'].resolved.some((item) => item.code === 'sequence-gap'));

    const operations = await readTrackingOperations(journal);
    assert.equal(operations.product, '包裹轨迹客服投影');
    assert.equal(operations.rows[0].assurance, 'confirmed');
    const log = await readEventLog(journal);
    assert.equal(log.totals.entries, 5);
    assert.equal(log.totals.batches, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('来源页适配保留原始字段并校验来源时间、接收时间和序号', () => {
  const page = parseEventFeed({ text: JSON.stringify({ items: [baseEvent()], next: null }) });
  assert.equal(page.next, null);
  assert.deepEqual(page.events[0], baseEvent());
  assert.throws(() => normalizeCarrierEvent(baseEvent({ sequence: 1.5 })), /invalid sequence/);
  assert.throws(() => normalizeCarrierEvent(baseEvent({ eventTime: 'nope' })), /invalid eventTime/);
  assert.throws(() => normalizeCarrierEvent(baseEvent({ receivedAt: 'nope' })), /invalid receivedAt/);
  assert.throws(() => normalizeCarrierEvent(baseEvent({ kind: 'retract', eventId: 'r1', retracts: undefined })), /must reference/);
  const input = baseEvent();
  const normalized = normalizeCarrierEvent(input);
  assert.notEqual(normalized, input);
});

test('空日志的业务读取返回空行而不是报错', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracking-empty-'));
  try {
    const operations = await readTrackingOperations(new EventJournal(join(directory, 'events.json')));
    assert.deepEqual(operations.rows, []);
    assert.equal(operations.totals.entries, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
