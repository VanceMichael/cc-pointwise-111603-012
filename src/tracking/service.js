import { buildCheckpoints, buildProjection } from './projection.js';

// 轨迹接入应用服务：负责把每次接收写成只追加日志，并从日志重放投影。
// 任何状态都不做就地更新；重复事件、撤回、补传全部保留为可重放的事实。
export class TrackingService {
  constructor(journal, clock = () => new Date().toISOString()) {
    this.journal = journal;
    this.clock = clock;
  }

  async record(events, options = {}) {
    if (!Array.isArray(events)) throw new TypeError('record input must be an array');
    const existing = await this.journal.read();
    const batchId = options.batchId ?? `batch-${existing.length ? Math.max(...existing.map((entry) => entry.batchSequence)) + 1 : 1}`;
    const batchSequence = existing.length ? Math.max(...existing.map((entry) => entry.batchSequence)) + 1 : 1;
    const recordedAt = options.recordedAt ?? this.clock();
    let sequenceInLog = existing.length;
    const entries = events.map((raw) => ({
      entryId: `entry-${++sequenceInLog}`,
      batchId,
      batchSequence,
      sequenceInLog,
      recordedAt,
      raw,
    }));
    const totalEntries = await this.journal.append(entries);
    return {
      batchId,
      recorded: entries.length,
      totalEntries,
      projection: buildProjection([...existing, ...entries]),
    };
  }

  async replay() {
    const entries = await this.journal.read();
    return { entries, projection: buildProjection(entries), checkpoints: buildCheckpoints(entries) };
  }

  async projection() {
    return buildProjection(await this.journal.read());
  }

  async checkpoints() {
    return buildCheckpoints(await this.journal.read());
  }
}
