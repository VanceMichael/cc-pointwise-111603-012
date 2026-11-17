import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(args) {
  return spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
}

const feed = {
  items: [
    { eventId: 'e3', carrier: 'C1', parcelId: 'P-99', sequence: 3, kind: 'delivered', eventTime: '2026-11-16T09:00:00Z', receivedAt: '2026-11-16T09:00:00Z' },
  ],
};

test('track-ingest 写入只追加日志，track-query 展示待核对投影而不是直接签收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'track-cli-'));
  const journalFile = join(directory, 'events.json');
  const input = join(directory, 'feed.json');
  await writeFile(input, JSON.stringify(feed));
  try {
    const ingest = run(['track-ingest', input, '--journal', journalFile]);
    assert.equal(ingest.status, 0, ingest.stderr);
    const result = JSON.parse(ingest.stdout);
    assert.equal(result.recorded, 1);
    assert.equal(result.projection.parcels[0].assurance, 'pending-review');

    const query = run(['track-query', 'P-99', '--journal', journalFile]);
    assert.equal(query.status, 0, query.stderr);
    const view = JSON.parse(query.stdout);
    assert.equal(view.rows[0].status, 'delivered');
    assert.equal(view.rows[0].assurance, 'pending-review');
    assert.ok(view.rows[0].reasons.some((item) => item.code === 'sequence-gap'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('track-replay 重放日志并给出检查点，track-log 保留原始事件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'track-cli-replay-'));
  const journalFile = join(directory, 'events.json');
  const input = join(directory, 'feed.json');
  await writeFile(input, JSON.stringify(feed));
  try {
    const ingest = run(['track-ingest', input, '--journal', journalFile]);
    assert.equal(ingest.status, 0, ingest.stderr);

    const replay = run(['track-replay', '--journal', journalFile]);
    assert.equal(replay.status, 0, replay.stderr);
    const replayed = JSON.parse(replay.stdout);
    assert.equal(replayed.entries.length, 1);
    assert.equal(replayed.checkpoints.length, 1);
    assert.equal(replayed.entries[0].raw.eventId, 'e3');

    const log = run(['track-log', '--journal', journalFile]);
    assert.equal(log.status, 0, log.stderr);
    const document = JSON.parse(log.stdout);
    assert.equal(document.totals.entries, 1);
    assert.ok(document.entries[0].recordedAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('帮助列出轨迹命令且原有命令保持不变', () => {
  const help = JSON.parse(run(['--help']).stdout);
  assert.deepEqual(help.commands, ['ingest', 'query']);
  assert.deepEqual(help.tracking, ['track-ingest', 'track-query', 'track-log', 'track-replay']);
});
