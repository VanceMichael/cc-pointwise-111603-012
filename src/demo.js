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
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
let tick = 0;
const clock = () => new Date(Date.parse('2026-11-16T12:00:00Z') + tick++ * 1000).toISOString();
try {
  // 既有集合流程保持不变。
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  const repository = new RecordRepository(join(directory, 'records.json'));
  await new CollectionService(repository).ingest(page.records);
  console.log('既有业务查询：');
  console.log(JSON.stringify(await readOperations(repository), null, 2));

  // 轨迹接入：首批只到了序号 3、2，揽收缺失，投影必须给出待核对原因。
  const tracking = new TrackingService(new TrackingStore(join(directory, 'tracking')), { clock });
  const first = await tracking.intake(toCarrierEvents(page));
  console.log('\n首批接入（缺揽收）：', JSON.stringify(first));
  const uncertain = await tracking.listParcels();
  console.log('待核对投影：', JSON.stringify(uncertain.parcels, null, 2));

  // 来源发布下一观察：迟到的揽收补传 + 撤回扫错的签收。
  source.publish('updated');
  const nextPage = parsePage(await new SourceClient(source.url).read(entryPath));
  const second = await tracking.intake(toCarrierEvents(nextPage));
  console.log('\n补传与撤回接入：', JSON.stringify(second));
  const recovered = await tracking.getParcel('P-17');
  console.log('恢复后的投影（当前状态不采信最后收到的一条）：', JSON.stringify({
    parcelId: recovered.parcelId,
    status: recovered.status,
    currentStatus: recovered.currentStatus,
    retractedEventIds: recovered.retractedEventIds,
    lateArrivals: recovered.timeline.filter((row) => row.lateArrival).map((row) => row.eventId),
    historySnapshots: recovered.history.length,
    earlierReasons: recovered.history[0].parcel.reasons.map((reason) => reason.code),
  }, null, 2));

  // 重放只凭事件日志重建，证明投影可复现。
  console.log('\n重放校验：', JSON.stringify(await tracking.replay(), null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
