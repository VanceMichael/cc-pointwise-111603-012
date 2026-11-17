import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { EventJournal } from '../src/tracking/journal.js';
import { TrackingService } from '../src/tracking/service.js';
import { parseEventFeed, trackingEntryPath } from '../src/tracking/adapter.js';
import { readTrackingOperations } from '../src/tracking/operations.js';

const scenarioPath = new URL('../fixtures/tracking-source.json', import.meta.url);

test('来源两阶段接入：先待核对，补传与撤回后恢复可解释轨迹', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'tracking-integration-'));
  try {
    const client = new SourceClient(source.url);
    const journal = new EventJournal(join(directory, 'events.json'));
    const service = new TrackingService(journal);

    const opening = parseEventFeed(await client.read(trackingEntryPath));
    assert.deepEqual(opening.events.map((event) => event.sequence), [3]);
    const firstBatch = await service.record(opening.events);
    const firstParcel = firstBatch.projection.parcels[0];
    // 签收先于揽收到达：不能直接宣称已签收
    assert.equal(firstParcel.assurance, 'pending-review');
    assert.ok(firstParcel.reasons.some((item) => item.code === 'sequence-gap'));
    assert.ok(firstParcel.reasons.some((item) => item.code === 'missing-collected'));
    assert.equal(firstParcel.status, 'delivered');

    source.publish('updated');
    const updated = parseEventFeed(await client.read(trackingEntryPath));
    const secondBatch = await service.record(updated.events);
    const parcel = secondBatch.projection.parcels[0];
    // 揽收补齐、签收撤回：状态回退到 in-transit，轨迹可解释
    assert.equal(parcel.assurance, 'confirmed');
    assert.equal(parcel.status, 'in-transit');
    assert.equal(parcel.timeline.find((row) => row.eventId === 'e3').state, 'retracted');
    assert.deepEqual(parcel.lateArrivals.map((row) => row.eventId), ['e1', 'e2']);

    const operations = await readTrackingOperations(journal, { parcel: 'P-17' });
    assert.equal(operations.rows.length, 1);
    assert.equal(operations.rows[0].timeline.length, 3);
    assert.equal(operations.totals.pendingReview, 0);

    const replay = await service.replay();
    assert.equal(replay.checkpoints.length, 2);
    const firstCheckpoint = replay.checkpoints[0].parcels['C1/P-17'];
    const secondCheckpoint = replay.checkpoints[1].parcels['C1/P-17'];
    assert.equal(firstCheckpoint.assurance, 'pending-review');
    assert.ok(secondCheckpoint.resolved.some((item) => item.code === 'sequence-gap'));
    assert.ok(secondCheckpoint.resolved.some((item) => item.code === 'missing-collected'));
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('重放同一份日志是幂等的，且原始事件未被投影修改', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'tracking-replay-'));
  try {
    const service = new TrackingService(new EventJournal(join(directory, 'events.json')));
    const page = parseEventFeed(await new SourceClient(source.url).read(trackingEntryPath));
    await service.record(page.events);
    const first = await service.replay();
    const second = await service.replay();
    assert.deepEqual(second.projection, first.projection);
    assert.deepEqual(second.checkpoints, first.checkpoints);
    assert.equal(first.entries[0].raw.eventId, 'e3');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
