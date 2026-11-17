import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { EventJournal } from './tracking/journal.js';
import { TrackingService } from './tracking/service.js';
import { normalizeCarrierEvent } from './tracking/adapter.js';
import { readEventLog, readTrackingOperations } from './tracking/operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const service = new CollectionService(new RecordRepository(resolve(here, '../var/records.json')));
const defaultJournalPath = resolve(here, '../var/tracking-events.json');
const action = process.argv[2] ?? '--help';

if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | track-ingest [文件] [--journal 路径] | track-query [包裹号] [--journal 路径] | track-log [--journal 路径] | track-replay [--journal 路径]',
    commands: ['ingest', 'query'],
    tracking: ['track-ingest', 'track-query', 'track-log', 'track-replay'],
  }));
  process.exit(0);
}

function optionValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function trackingService() {
  return new TrackingService(new EventJournal(optionValue('--journal') ?? defaultJournalPath));
}

async function readTrackingInput(file) {
  const document = JSON.parse(await readFile(file, 'utf8'));
  // 既支持来源页 { items, next }，也支持事件数组
  const items = Array.isArray(document) ? document : document.items;
  if (!Array.isArray(items)) throw new Error('tracking input needs items array or event array');
  return items.map((item) => normalizeCarrierEvent(item));
}

if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'track-ingest') {
  const file = process.argv[3] && !process.argv[3].startsWith('--')
    ? process.argv[3]
    : resolve(here, '../fixtures/tracking-events.json');
  const events = await readTrackingInput(file);
  console.log(JSON.stringify(await trackingService().record(events), null, 2));
} else if (action === 'track-query') {
  const parcel = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
  console.log(JSON.stringify(await readTrackingOperations(await trackingService().journal, { parcel }), null, 2));
} else if (action === 'track-log') {
  console.log(JSON.stringify(await readEventLog(await trackingService().journal), null, 2));
} else if (action === 'track-replay') {
  console.log(JSON.stringify(await trackingService().replay(), null, 2));
} else {
  throw new Error('action must be ingest or query');
}
