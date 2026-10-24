import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { createStore } from '../lib/store.mjs';

const initial = { version: 1, leads: [], feedback: [], runs: [], product: {}, metrics: { sent: 0, customerResponses: 0, partnerResponses: 0, peerFeedback: 0, orders: 0 } };
async function setup(t) {
  const scratch = fileURLToPath(new URL('../data/test-fixtures/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'run-'));
  await mkdir(join(directory, 'public'));
  await writeFile(join(directory, 'public', 'index.html'), '<h1>KMINGO</h1>');
  await writeFile(join(directory, 'seed.json'), JSON.stringify(initial));
  await writeFile(join(directory, '.env.local'), 'DUMMY_ONLY=do-not-serve');
  const store = createStore(join(directory, 'data', 'state.json'), join(directory, 'seed.json'));
  const server = createApp({ baseDir: directory, store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await store.read();
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!resolve(directory).startsWith(`${resolve(scratch)}${sep}`)) throw new Error('Test cleanup path escaped workspace fixture directory');
    await rm(directory, { recursive: true, force: true });
  });
  return { store, directory, origin: `http://127.0.0.1:${server.address().port}` };
}
test('HTTP reads seed, serves app, denies secrets and rejects cross-origin mutations', async t => {
  const { origin } = await setup(t);
  assert.match(await (await fetch(origin)).text(), /KMINGO/);
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(), initial);
  for (const path of ['/.env.local', '/seed.json', '/data/state.json', '/%2e%2e%5c.env.local']) {
    const result = await fetch(`${origin}${path}`); assert.ok([403, 404].includes(result.status));
    assert.doesNotMatch(await result.text(), /do-not-serve/);
  }
  const rejected = await fetch(`${origin}/api/loop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }, body: '{"mode":"rules"}' });
  assert.equal(rejected.status, 403);
  assert.equal((await (await fetch(`${origin}/api/state`)).json()).runs.length, 0);
  const wrongType = await fetch(`${origin}/api/loop`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"mode":"rules"}' });
  assert.equal(wrongType.status, 415);
  const large = await fetch(`${origin}/api/loop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'rules', padding: 'x'.repeat(17000) }) });
  assert.equal(large.status, 413);
});
test('same-origin JSON mutation persists; unknown fields rejected; export is real state', async t => {
  const { origin, directory } = await setup(t);
  const request = body => fetch(`${origin}/api/loop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await request({ mode: 'rules', unexpected: true })).status, 400);
  assert.equal((await request({ mode: 'rules' })).status, 200);
  const saved = JSON.parse(await readFile(join(directory, 'data', 'state.json'), 'utf8'));
  assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].changes.length, 0);
  const exported = await fetch(`${origin}/api/export`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(await exported.json(), saved);
});
test('store serializes concurrent changes and failed mutation cannot corrupt persisted state', async t => {
  const { store, directory } = await setup(t);
  const mutations = Array.from({ length: 5 }, (_, i) => store.mutate(async state => { await new Promise(resolve => setTimeout(resolve, 2)); state.runs.push({ id: i }); return state; }));
  await Promise.all(mutations);
  assert.equal((await store.read()).runs.length, 5);
  await assert.rejects(store.mutate(state => { state.metrics.orders = 99; throw new Error('failed'); }));
  assert.equal((await store.read()).metrics.orders, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'data', 'state.json'), 'utf8')).metrics.orders, 0);
});
