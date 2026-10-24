import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.mjs';

async function fixture(t) {
  const scratch = fileURLToPath(new URL('../data/cli-test-fixtures/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const baseDir = await mkdtemp(join(scratch, 'run-'));
  const original = await readFile(new URL('../seed.json', import.meta.url), 'utf8');
  await writeFile(join(baseDir, 'seed.json'), original);
  t.after(async () => {
    if (!resolve(baseDir).startsWith(`${resolve(scratch)}${sep}`)) throw new Error('Unsafe test cleanup path');
    await rm(baseDir, { recursive: true, force: true });
  });
  const outputs = [];
  const call = args => main(args, { baseDir, stdout: text => outputs.push(JSON.parse(text)), generate: async () => { throw new Error('Rules mode must not call AI'); } });
  return { baseDir, outputs, call };
}

test('CLI routine persists initial run, unchanged repeat, explicit feedback and one next action', async t => {
  const { baseDir, call } = await fixture(t);
  const initial = await call(['status']);
  assert.equal(initial.leadCount, 10); assert.equal(initial.runCount, 0);
  assert.ok(Object.values(initial.metrics).every(value => value === 0));
  const first = await call(['run']);
  assert.equal(first.changedCount, 10); assert.equal(first.mode, 'rules'); assert.equal(first.aiCalled, false);
  const repeat = await call(['run']);
  assert.equal(repeat.changedCount, 0); assert.equal(repeat.unchangedCount, 10);
  await writeFile(join(baseDir, 'feedback.json'), JSON.stringify({ leadId: 'Q01', text: 'Fixture only: 이미 새 통을 구매했습니다.', sourceKind: 'customer', facts: { jarStatus: 'full', purchaseIntent: 'no' } }));
  const recorded = await call(['feedback', '--file', 'feedback.json']);
  assert.equal(recorded.pending, true); assert.equal(recorded.metrics.customerResponses, 1);
  assert.equal((await call(['status'])).pendingFeedback, 1);
  const next = await call(['run']);
  assert.equal(next.changedCount, 1); assert.equal(next.changes[0].leadId, 'Q01');
  assert.equal(next.changes[0].before, 'qualify'); assert.equal(next.changes[0].after, 'support');
  assert.equal((await call(['status'])).pendingFeedback, 0);
  const state = await call(['export']);
  assert.equal(state.metrics.orders, 0); assert.equal(state.metrics.sent, 0);
  assert.equal(state.runs.length, 3);
  const exported = await call(['export', '--output', 'exports/test.json']);
  assert.deepEqual(JSON.parse(await readFile(exported.outputPath, 'utf8')), state);
});

test('CLI add uses shared validation; export cannot escape repo or overwrite state', async t => {
  const { baseDir, call } = await fixture(t);
  await writeFile(join(baseDir, 'lead.json'), JSON.stringify({ name: 'Fixture class', type: 'partner', sourceUrl: 'https://example.com/cli-fixture', evidence: 'Test fixture only, not a real prospect.' }));
  const added = await call(['add', '--file', 'lead.json']);
  assert.equal(added.leadCount, 11);
  await assert.rejects(call(['add', '--file', 'lead.json']), /이미 있습니다/);
  await assert.rejects(call(['export', '--output', '../escaped.json']), /저장소 내부/);
  await assert.rejects(call(['export', '--output', 'data/state.json']), /덮어쓸 수 없습니다/);
  await assert.rejects(call(['export', '--output', 'report.txt']), /저장소 내부/);
  await call(['export', '--output', 'snapshot.json']);
  await assert.rejects(call(['export', '--output', 'snapshot.json']), /이미 있습니다/);
  await assert.rejects(call(['run', '--magic']), /인자가 올바르지/);
  await writeFile(join(baseDir, 'bad.json'), '{not valid JSON}');
  await assert.rejects(call(['feedback', '--file', 'bad.json']), /유효한 UTF-8 JSON/);
});

test('CLI AI failure is explicit and cannot advance or corrupt the stored run', async t => {
  const { baseDir, call } = await fixture(t);
  await call(['status']);
  const before = await readFile(join(baseDir, 'data', 'state.json'), 'utf8');
  await assert.rejects(main(['run', '--ai'], { baseDir, stdout: () => {}, generate: async () => { throw new Error('Fixture API failure'); } }), /Fixture API failure/);
  assert.equal(await readFile(join(baseDir, 'data', 'state.json'), 'utf8'), before);
  assert.equal((await call(['status'])).runCount, 0);
});
