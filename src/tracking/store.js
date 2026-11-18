// 轨迹接入的状态存储：一份只追加的事件日志 + 一份带历史的投影。
// 与现有 RecordRepository 一样使用临时文件原子替换，状态目录是运行产物。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JOURNAL_VERSION } from './journal.js';

export const JOURNAL_FILE = 'tracking-journal.json';
export const PROJECTION_FILE = 'tracking-projection.json';

export class TrackingStore {
  constructor(directory) {
    this.directory = directory;
    this.journalPath = join(directory, JOURNAL_FILE);
    this.projectionPath = join(directory, PROJECTION_FILE);
  }

  async readJournal() {
    try {
      const value = JSON.parse(await readFile(this.journalPath, 'utf8'));
      if (!Array.isArray(value.entries)) throw new Error('journal file has no entries array');
      if (value.version !== JOURNAL_VERSION) throw new Error(`unsupported journal version ${value.version}`);
      return value.entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeJournal(entries) {
    await atomicWrite(this.journalPath, { version: JOURNAL_VERSION, entries });
  }

  async readProjection() {
    try {
      const value = JSON.parse(await readFile(this.projectionPath, 'utf8'));
      if (!Array.isArray(value.parcels)) throw new Error('projection file has no parcels array');
      if (!Array.isArray(value.history)) throw new Error('projection file has no history array');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { version: 1, parcels: [], history: [], lastJournalEntryId: 0, builtAt: null };
      }
      throw error;
    }
  }

  async writeProjection(projection) {
    await atomicWrite(this.projectionPath, projection);
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}
