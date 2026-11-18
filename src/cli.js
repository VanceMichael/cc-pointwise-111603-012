import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { TrackingStore } from './tracking/store.js';
import { TrackingService } from './tracking/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const service = new CollectionService(new RecordRepository(resolve(here, '../var/records.json')));
const trackingDirectory = process.env.TRACKING_DIR
  ? resolve(process.env.TRACKING_DIR)
  : resolve(here, '../var/tracking');
const tracking = new TrackingService(new TrackingStore(trackingDirectory));
const action = process.argv[2] ?? '--help';

if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | track [文件] | parcels | parcel <包裹号> | replay',
    commands: ['ingest', 'query', 'track', 'parcels', 'parcel', 'replay'],
    trackingState: trackingDirectory,
  }));
  process.exit(0);
}

if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'track') {
  // 文件是承运商事件数组（与来源 items 同构）；重复与冲突在结果中显式报告。
  const file = process.argv[3] ?? resolve(here, '../fixtures/tracking-events.json');
  const events = JSON.parse(await readFile(file, 'utf8'));
  console.log(JSON.stringify(await tracking.intake(events), null, 2));
} else if (action === 'parcels') {
  console.log(JSON.stringify(await tracking.listParcels(), null, 2));
} else if (action === 'parcel') {
  const parcelId = process.argv[3];
  if (!parcelId) throw new Error('parcel action requires a parcelId');
  console.log(JSON.stringify(await tracking.getParcel(parcelId), null, 2));
} else if (action === 'replay') {
  console.log(JSON.stringify(await tracking.replay(), null, 2));
} else {
  throw new Error('action must be ingest, query, track, parcels, parcel or replay');
}
