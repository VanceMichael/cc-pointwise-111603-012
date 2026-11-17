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

const source = await startSource(new URL('../fixtures/tracking-source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  // 既有集合管道保持可用
  const legacySource = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    const page = parsePage(await new SourceClient(legacySource.url).read(entryPath));
    const repository = new RecordRepository(join(directory, 'records.json'));
    await new CollectionService(repository).ingest(page.records);
    console.log('legacy collection:', JSON.stringify(await readOperations(repository)));
  } finally {
    await legacySource.close();
  }

  // 轨迹事件日志与客服投影：第一批只有 seq3 签收，先进入待核对
  const journal = new EventJournal(join(directory, 'tracking-events.json'));
  const tracking = new TrackingService(journal);
  const client = new SourceClient(source.url);
  const opening = parseEventFeed(await client.read(trackingEntryPath));
  await tracking.record(opening.events);
  const before = await readTrackingOperations(journal);
  console.log('before repair:', JSON.stringify({
    status: before.rows[0].status,
    assurance: before.rows[0].assurance,
    reasons: before.rows[0].reasons.map((item) => item.code),
  }));

  // 来源补传揽收/运输节点，并撤回扫错的签收
  source.publish('updated');
  const updated = parseEventFeed(await client.read(trackingEntryPath));
  await tracking.record(updated.events);
  const after = await readTrackingOperations(journal);
  console.log('after repair:', JSON.stringify({
    status: after.rows[0].status,
    assurance: after.rows[0].assurance,
    reasons: after.rows[0].reasons.map((item) => item.code),
    lateArrivals: after.rows[0].lateArrivals.map((item) => item.eventId),
    retracted: after.rows[0].timeline.filter((row) => row.state === 'retracted').map((row) => row.eventId),
  }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
