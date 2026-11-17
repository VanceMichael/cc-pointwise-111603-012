import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';
import { EventJournal } from './tracking/journal.js';
import { TrackingService } from './tracking/service.js';
import { parseEventFeed, trackingEntryPath } from './tracking/adapter.js';
import { readTrackingOperations } from './tracking/operations.js';

const legacySource = await startSource(new URL('../fixtures/source.json', import.meta.url));
const trackingSource = await startSource(new URL('../fixtures/tracking-source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const page = parsePage(await new SourceClient(legacySource.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  for (const row of operations.rows) {
    const original = stored.find(record => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }

  // 轨迹接入：只追加日志 + 可重放客服投影
  const journal = new EventJournal(join(directory, 'tracking-events.json'));
  const tracking = new TrackingService(journal);
  const client = new SourceClient(trackingSource.url);
  const opening = parseEventFeed(await client.read(trackingEntryPath));
  const initial = await tracking.record(opening.events);
  assert.equal(initial.projection.parcels[0].assurance, 'pending-review', '只有签收时必须进入待核对');
  assert.ok(initial.projection.parcels[0].reasons.some((item) => item.code === 'sequence-gap'));

  // 重放同一日志：结果确定且不改变原始事件
  const replayed = await tracking.replay();
  assert.equal(replayed.entries.length, opening.events.length);
  assert.deepEqual((await tracking.replay()).projection, initial.projection, '日志重放是确定性的');

  // 补传与撤回：恢复可解释轨迹，同时检查点保留之前不能确定的依据
  trackingSource.publish('updated');
  const updated = parseEventFeed(await client.read(trackingEntryPath));
  const repaired = await tracking.record(updated.events);
  const parcel = repaired.projection.parcels[0];
  assert.equal(parcel.assurance, 'confirmed');
  assert.equal(parcel.status, 'in-transit', '签收被撤回后回退到最后有效状态');
  assert.equal(parcel.timeline.find((row) => row.eventId === 'e3').state, 'retracted');

  const checkpoints = (await tracking.checkpoints());
  assert.equal(checkpoints.length, 2);
  assert.ok(checkpoints[1].parcels['C1/P-17'].resolved.some((item) => item.code === 'sequence-gap'), '检查点保留缺口被补齐的历史依据');

  const serviceView = await readTrackingOperations(journal);
  assert.equal(serviceView.rows[0].assurance, 'confirmed');
  assert.equal(serviceView.totals.pendingReview, 0);

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: second.stored,
    operationRows: operations.rows.length,
    trackingEntries: replayed.entries.length + updated.events.length,
    checkpoints: checkpoints.length,
    finalStatus: parcel.status,
    status: 'ok',
  }));
} finally {
  await legacySource.close();
  await trackingSource.close();
  await rm(directory, { recursive: true, force: true });
}
