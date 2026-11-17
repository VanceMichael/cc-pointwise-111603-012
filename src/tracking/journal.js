import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const JOURNAL_SCHEMA_VERSION = 1;

// 只追加（append-only）的承运商事件日志。
// 日志只记录事实：每次接收到的原始事件都会留下一条 entry，
// 重复接收不覆盖、撤回不删除，投影完全由日志重放得到。
export class EventJournal {
  constructor(path) {
    this.path = path;
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value.entries)) throw new Error('journal file has no entries array');
      return structuredClone(value.entries);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async append(entries) {
    const current = await this.read();
    const next = [...current, ...entries];
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const document = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      entries: next,
    };
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
    return next.length;
  }
}
