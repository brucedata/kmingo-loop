import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createStore } from '../lib/store.mjs';

const NOW = '2026-10-24T09:00:00.000Z';
const initial = () => ({
  version: 1, product: { name: 'KMINGO', url: 'https://kmingo.com/' },
  leads: [
    { id: 'Q01', name: 'HTTP-PRIVATE-PERSON', type: 'consumer', sourceUrl: 'https://private.example/question-q01', evidence: 'HTTP-PRIVATE-RAW-EVIDENCE', jarStatus: 'unknown', purchaseIntent: 'unknown', deliveryEligible: 'unknown', priority: 1, processedFeedbackIds: [], history: [] },
    { id: 'Q02', name: 'Second candidate', type: 'consumer', sourceUrl: 'https://example.com/question-q02', evidence: 'Needs a new jar', jarStatus: 'low', purchaseIntent: 'yes', deliveryEligible: 'unknown', priority: 2, processedFeedbackIds: [], history: [] }
  ],
  feedback: [], runs: [], metrics: { sent: 0, customerResponses: 0, partnerResponses: 0, peerFeedback: 0, orders: 0 }
});
const activity = () => ({ activityId: 'HTTP-PRIVATE-ACTIVITY', type: 'proposal_sent', leadId: 'Q01', channel: 'manual-review', variantId: 'next-meal-v1', happenedAt: '2026-10-24T07:50:00Z', evidenceRef: 'private-activity:HTTP-SENT' });
const order = () => ({ orderId: 'HTTP-PRIVATE-ORDER', customerId: 'HTTP-PRIVATE-CUSTOMER', leadId: 'Q01', activityId: 'HTTP-PRIVATE-ACTIVITY', status: 'paid', amountKRW: 25000, paidAt: '2026-10-24T08:00:00Z', evidenceRef: 'private-payment:HTTP-PAID', paymentVerified: true });

async function setup(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const scratch = fileURLToPath(new URL('../data/test-fixtures/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'campaign-http-'));
  await mkdir(join(directory, 'public'));
  await writeFile(join(directory, 'public', 'index.html'), '<h1>Fixture only</h1>');
  await writeFile(join(directory, 'seed.json'), JSON.stringify(initial()));
  const store = createStore(join(directory, 'data', 'state.json'), join(directory, 'seed.json'));
  const server = createApp({ baseDir: directory, store, generate: async () => { throw new Error('HTTP campaign tests must never call an AI API'); } });
  t.after(async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (!resolve(directory).startsWith(`${resolve(scratch)}${sep}`)) throw new Error('Fixture cleanup escaped the workspace fixture directory');
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(`${origin}${path}`).then(response => response.json());
  const post = (path, body, extraHeaders = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...extraHeaders }, body: JSON.stringify(body) });
  return { directory, get, post };
}

test('HTTP campaign connects confirmed feedback, proposal, paid order and private daily journal without publishing raw records', async t => {
  const { directory, get, post } = await setup(t);
  assert.equal((await get('/api/campaign')).summary.validOrders, 0);
  const feedback = await post('/api/feedback', { leadId: 'Q01', sourceKind: 'customer', text: 'HTTP-PRIVATE-RESPONSE person@example.com', facts: { jarStatus: 'low', purchaseIntent: 'yes', deliveryEligible: 'yes', country: 'KR' } });
  assert.equal(feedback.status, 200);
  const loop = await post('/api/loop', { mode: 'rules' });
  assert.equal(loop.status, 200);
  const beforePurchase = await loop.json();
  assert.equal(beforePurchase.leads[0].deliveryEligible, 'yes');
  assert.equal(beforePurchase.strategy.topTargets[0].leadId, 'Q01');
  assert.equal((await post('/api/activity', activity())).status, 200);
  assert.equal((await post('/api/orders', order())).status, 200);
  assert.equal((await post('/api/orders', order())).status, 200);
  const stateAfterOrder = await get('/api/state');
  assert.equal(stateAfterOrder.orderEvents.length, 1, 'duplicate order must not append a second event');
  assert.equal(stateAfterOrder.metrics.orders, 1);
  const progress = await get('/api/campaign');
  assert.equal(progress.summary.goalOrders, 10);
  assert.equal(progress.summary.validOrders, 1);
  assert.equal(progress.summary.remainingOrders, 9);
  assert.equal(progress.summary.netRevenueKRW, 25000);
  assert.equal(progress.summary.qualifiedProposals, 1);
  assert.equal(progress.summary.convertedProposals, 1);
  assert.equal(progress.summary.conversionRate, 1);
  assert.equal(progress.summary.verification, 'operator_attested_not_payment_api');

  const daily = await post('/api/daily', { date: '2026-10-24', note: 'HTTP-PRIVATE-OPERATOR-NOTE', mode: 'rules' });
  assert.equal(daily.status, 200);
  const dailyResult = await daily.json();
  assert.equal(dailyResult.summary.validOrders, 1);
  assert.equal(dailyResult.dailyReports.at(-1).metrics.validOrders, 1);
  assert.equal(dailyResult.dailyReports.at(-1).note, 'HTTP-PRIVATE-OPERATOR-NOTE');
  assert.ok(dailyResult.dailyReports.at(-1).improvementReason.length > 0);
  assert.ok(dailyResult.dailyReports.at(-1).nextAction.length > 0);
  const afterDaily = await get('/api/state');
  assert.equal(afterDaily.leads[0].action.kind, 'support');
  assert.equal(afterDaily.strategy.topTargets.some(target => target.leadId === 'Q01'), false);
  const publicReport = await readFile(join(directory, 'daily', '2026-10-24.md'), 'utf8');
  assert.match(publicReport, /1\/10/);
  assert.match(publicReport, /25000/);
  for (const secret of ['HTTP-PRIVATE-PERSON', 'HTTP-PRIVATE-RAW-EVIDENCE', 'HTTP-PRIVATE-RESPONSE', 'person@example.com', 'HTTP-PRIVATE-OPERATOR-NOTE', 'HTTP-PRIVATE-ACTIVITY', 'HTTP-PRIVATE-ORDER', 'HTTP-PRIVATE-CUSTOMER', 'private-activity:HTTP-SENT', 'private-payment:HTTP-PAID', 'https://private.example']) assert.equal(publicReport.includes(secret), false, `${secret} must stay private`);

  assert.equal((await post('/api/orders', { ...order(), status: 'refunded' })).status, 200);
  const refunded = await get('/api/campaign');
  assert.equal(refunded.summary.validOrders, 0);
  assert.equal(refunded.summary.netRevenueKRW, 0);
  assert.equal(refunded.summary.refundedOrders, 1);
  assert.equal((await get('/api/state')).metrics.orders, 0);
  assert.equal((await post('/api/daily', { date: '2026-10-24' })).status, 200);
  const revisedReport = await readFile(join(directory, 'daily', '2026-10-24.md'), 'utf8');
  assert.match(revisedReport, /0\/10/);
  const revised = await get('/api/campaign');
  assert.equal(revised.dailyReports.length, 2, 'earlier daily result remains in private revision history');
  assert.equal(revised.dailyReports.at(-1).revision, 2);
});

test('new campaign mutation endpoints enforce origin and strict input validation before changing state', async t => {
  const { get, post } = await setup(t);
  for (const path of ['/api/activity', '/api/orders', '/api/daily']) {
    assert.equal((await post(path, {}, { Origin: 'https://attacker.example' })).status, 403, `${path}: origin`);
    assert.equal((await post(path, { unexpected: true })).status, 400, `${path}: unknown field`);
  }
  const state = await get('/api/state');
  assert.equal(state.runs.length, 0);
  assert.equal(state.metrics.orders, 0);
  assert.equal(state.activityEvents?.length || 0, 0);
  assert.equal(state.orderEvents?.length || 0, 0);
  assert.equal(state.dailyJournal?.length || 0, 0);
});

test('rejected future daily close rolls back loop execution and creates no public result', async t => {
  const { directory, get, post } = await setup(t);
  const response = await post('/api/daily', { date: '2026-10-25', mode: 'rules' });
  assert.equal(response.status, 400);
  assert.equal((await get('/api/state')).runs.length, 0);
  await assert.rejects(readFile(join(directory, 'daily', '2026-10-25.md')), { code: 'ENOENT' });
});
