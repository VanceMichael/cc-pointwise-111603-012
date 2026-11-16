import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('carrier source arrival order differs from business sequence and carries retraction', async () => {
  const first = (await observe()).records.map((row) => row.attributes);
  const next = (await observe('updated')).records.map((row) => row.attributes);
  assert.deepEqual(first.map((row) => row.sequence), [3, 2]);
  assert.equal(next[0].sequence, 1);
  assert.equal(next[1].retracts, first[0].eventId);
  assert.equal(next[1].kind, 'retract');
});
