import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath, toCarrierEvents } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';
import { TrackingStore } from './tracking/store.js';
import { TrackingService } from './tracking/service.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
let tick = 0;
const clock = () => new Date(Date.parse('2026-11-16T12:00:00Z') + tick++ * 1000).toISOString();
try {
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
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

  // 轨迹接入验收：缺失、补传、撤回、重放的完整生命周期。
  const tracking = new TrackingService(new TrackingStore(join(directory, 'tracking')), { clock });
  const opening = await tracking.intake(toCarrierEvents(page));
  assert.equal(opening.received, 2);
  assert.equal(opening.needsReviewCount, 1, '缺揽收时必须进入待核对');
  const uncertain = await tracking.getParcel('P-17');
  assert.deepEqual(uncertain.reasons.map((reason) => reason.code), ['sequence-gap', 'missing-collected']);

  source.publish('updated');
  const updatedPage = parsePage(await new SourceClient(source.url).read(entryPath));
  const updated = await tracking.intake(toCarrierEvents(updatedPage));
  assert.equal(updated.duplicates, 0);
  const recovered = await tracking.getParcel('P-17');
  assert.equal(recovered.currentStatus, 'in-transit', '签收被撤回后当前状态回到在途');
  assert.deepEqual(recovered.retractedEventIds, ['e3']);
  assert.equal(recovered.timeline.find((row) => row.eventId === 'e1').lateArrival, true, '补传揽收标记为迟到');
  assert.equal(recovered.history.length, 2, '每次接入都留下历史快照');
  assert.deepEqual(recovered.history[0].parcel.reasons.map((reason) => reason.code),
    ['sequence-gap', 'missing-collected'], '历史保留之前不能确定的依据');

  const replayed = await new TrackingService(new TrackingStore(join(directory, 'tracking')), { clock }).replay();
  assert.equal(replayed.consistent, true, '只凭事件日志重放须与存储投影一致');
  assert.deepEqual(replayed.projectionMismatches, []);

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: second.stored,
    operationRows: operations.rows.length,
    trackingReceived: opening.received + updated.received,
    journalEntries: replayed.journalEntries,
    historySnapshots: replayed.historySnapshots,
    finalStatus: recovered.currentStatus,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
