import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('命令帮助列出全部入口且正常退出', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.ok(help.usage.includes('ingest'));
  assert.deepEqual(help.commands, ['ingest', 'query', 'track', 'parcels', 'parcel', 'replay']);
});

test('未知动作明确失败而不执行默认查询', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'invalid-action'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ingest, query, track, parcels, parcel or replay/);
});

test('track、parcels、parcel 与 replay 在独立状态目录中端到端工作', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracking-cli-'));
  try {
    const env = { ...process.env, TRACKING_DIR: directory };
    const track = spawnSync(process.execPath, ['src/cli.js', 'track', 'fixtures/tracking-events.json'], { encoding: 'utf8', env });
    assert.equal(track.status, 0, track.stderr);
    const intake = JSON.parse(track.stdout);
    assert.equal(intake.received, 4);
    assert.equal(intake.affectedParcels[0], 'P-17');

    const parcels = spawnSync(process.execPath, ['src/cli.js', 'parcels'], { encoding: 'utf8', env });
    assert.equal(parcels.status, 0, parcels.stderr);
    const list = JSON.parse(parcels.stdout);
    assert.equal(list.parcels[0].parcelId, 'P-17');
    // e3 签收被 e4 撤回，当前状态应为在途而非最后收到的撤回/签收。
    assert.equal(list.parcels[0].currentStatus, 'in-transit');

    const parcel = spawnSync(process.execPath, ['src/cli.js', 'parcel', 'P-17'], { encoding: 'utf8', env });
    assert.equal(parcel.status, 0, parcel.stderr);
    const detail = JSON.parse(parcel.stdout);
    assert.deepEqual(detail.retractedEventIds, ['e3']);
    assert.equal(detail.timeline.find((row) => row.eventId === 'e3').retracted, true);

    const replay = spawnSync(process.execPath, ['src/cli.js', 'replay'], { encoding: 'utf8', env });
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).consistent, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
