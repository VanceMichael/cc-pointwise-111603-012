import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { parsePage, entryPath, toCarrierEvents } from '../src/adapter.js';
import { TrackingStore, JOURNAL_FILE, PROJECTION_FILE } from '../src/tracking/store.js';
import { TrackingService } from '../src/tracking/service.js';

let tick = 0;
const clock = () => new Date(Date.parse('2026-11-16T12:00:00Z') + tick++ * 1000).toISOString();

const hour = (sequence) => String(7 + sequence).padStart(2, '0');
const statusEvent = (eventId, sequence, kind, overrides = {}) => ({
  eventId, carrier: 'C1', parcelId: 'P-17', sequence, kind,
  eventTime: `2026-11-16T${hour(sequence)}:00:00Z`,
  receivedAt: `2026-11-16T${hour(sequence)}:05:00Z`,
  ...overrides,
});

async function withService(run) {
  const directory = await mkdtemp(join(tmpdir(), 'tracking-integration-'));
  try {
    const store = new TrackingStore(directory);
    await run(new TrackingService(store, { clock }), store, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('迟到揽收补齐后恢复可解释轨迹，同时保留之前不能确定的依据', async () => {
  await withService(async (service) => {
    // 第一批：签收与在途先到，揽收缺失（补传场景）。
    const first = await service.intake([
      statusEvent('e3', 3, 'delivered', { receivedAt: '2026-11-16T09:00:00Z' }),
      statusEvent('e2', 2, 'in-transit', { receivedAt: '2026-11-16T09:00:00Z' }),
    ]);
    assert.equal(first.needsReviewCount, 1);
    const uncertain = await service.getParcel('P-17');
    assert.equal(uncertain.status, 'needs-review');
    assert.deepEqual(uncertain.reasons.map((reason) => reason.code), ['sequence-gap', 'missing-collected']);

    // 第二批：迟到的揽收到达，缺口被补齐。
    await service.intake([
      statusEvent('e1', 1, 'collected', { receivedAt: '2026-11-16T10:00:00Z' }),
    ]);
    const recovered = await service.getParcel('P-17');
    assert.equal(recovered.status, 'delivered');
    assert.equal(recovered.needsReview, false);
    assert.equal(recovered.timeline.find((row) => row.eventId === 'e1').lateArrival, true);

    // 历史快照保留了“之前为什么不能确定”的完整依据。
    assert.equal(recovered.history.length, 2);
    const earlier = recovered.history[0].parcel;
    assert.deepEqual(earlier.reasons.map((reason) => reason.code), ['sequence-gap', 'missing-collected']);
    assert.equal(earlier.status, 'needs-review');
  });
});

test('撤回扫错的签收会改变当前投影，但原始事件与撤回引用都保留在日志中', async () => {
  await withService(async (service) => {
    await service.intake([
      statusEvent('e1', 1, 'collected'),
      statusEvent('e2', 2, 'in-transit'),
      statusEvent('e3', 3, 'delivered'),
    ]);
    await service.intake([
      { eventId: 'e4', carrier: 'C1', parcelId: 'P-17', sequence: 4, kind: 'retract', retracts: 'e3',
        eventTime: '2026-11-16T10:00:00Z', receivedAt: '2026-11-16T10:05:00Z' },
    ]);
    const parcel = await service.getParcel('P-17');
    assert.equal(parcel.currentStatus, 'in-transit');
    assert.deepEqual(parcel.retractedEventIds, ['e3']);
    assert.equal(parcel.retractions[0].effective, true);

    const journal = await service.readJournalEntries();
    const delivered = journal.find((entry) => entry.eventId === 'e3');
    const retraction = journal.find((entry) => entry.eventId === 'e4');
    assert.equal(delivered.kind, 'delivered'); // 原始事件未被删除或改写
    assert.equal(retraction.retracts, 'e3');
    assert.ok(journal.every((entry, index) => index === 0 || entry.entryId > journal[index - 1].entryId));
  });
});

test('重复接入不产生新结论，但每次接入都在历史与日志中可追踪', async () => {
  await withService(async (service) => {
    const events = [statusEvent('e1', 1, 'collected'), statusEvent('e2', 2, 'in-transit')];
    await service.intake(events);
    const replay = await service.intake(events);
    assert.equal(replay.appended, 2);
    assert.equal(replay.duplicates, 2);
    assert.equal(replay.conflicts, 0);
    assert.equal(replay.needsReviewCount, 0);
    const parcel = await service.getParcel('P-17');
    assert.equal(parcel.duplicates.length, 2);
    assert.equal(parcel.history.length, 2);
  });
});

test('重启后从持久文件恢复，重放投影与存储投影逐包裹一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracking-restart-'));
  try {
    const service = new TrackingService(new TrackingStore(directory), { clock });
    await service.intake([
      statusEvent('e3', 3, 'delivered', { receivedAt: '2026-11-16T09:00:00Z' }),
      statusEvent('e2', 2, 'in-transit', { receivedAt: '2026-11-16T09:00:00Z' }),
      statusEvent('e1', 1, 'collected', { receivedAt: '2026-11-16T10:00:00Z' }),
    ]);
    const files = await Promise.all([
      readFile(join(directory, JOURNAL_FILE), 'utf8'),
      readFile(join(directory, PROJECTION_FILE), 'utf8'),
    ]);
    assert.ok(JSON.parse(files[0]).entries.length === 3);
    assert.ok(JSON.parse(files[1]).history.length === 1);

    const reopened = new TrackingService(new TrackingStore(directory), { clock });
    const list = await reopened.listParcels();
    assert.equal(list.parcels[0].status, 'delivered');
    const result = await reopened.replay();
    assert.equal(result.consistent, true);
    assert.equal(result.journalEntries, 3);
    assert.deepEqual(result.projectionMismatches, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('来源页面经适配器进入日志，来源时间、接收时间与序号各司其职', async () => {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  await withService(async (service) => {
    try {
      const page = parsePage(await new SourceClient(source.url).read(entryPath));
      const result = await service.intake(toCarrierEvents(page));
      assert.equal(result.received, 2);
      const journal = await service.readJournalEntries();
      assert.equal(journal[0].eventTime, journal[0].raw.eventTime);
      assert.equal(journal[0].receivedAt, journal[0].raw.receivedAt);
      assert.equal(journal[0].entryId, 1);
      const parcel = await service.getParcel('P-17');
      assert.equal(parcel.status, 'needs-review');
      assert.ok(parcel.reasons.some((reason) => reason.code === 'missing-collected'));
      assert.deepEqual(parcel.timeline.map((row) => row.sequence), [2, 3]);
    } finally {
      await source.close();
    }
  });
});
