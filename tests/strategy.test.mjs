import test from 'node:test';
import assert from 'node:assert/strict';
import { recordFeedback, runLoop } from '../lib/engine.mjs';
import { recordActivity, recordOrder } from '../lib/campaign.mjs';

const NOW = '2026-10-25T12:00:00.000Z';
const make = () => ({ version: 1, product: { name: 'KMINGO' }, leads: ['A', 'B', 'C', 'D'].map((id, index) => ({ id, name: `후보 ${id}`, type: 'consumer', sourceUrl: `https://example.com/${id}`, evidence: '구매 조건 확인 필요', priority: index + 1, jarStatus: index ? 'unknown' : 'low', purchaseIntent: index ? 'unknown' : 'yes', country: null, action: null, draft: index ? '' : '어떤 요리를 하시며 어느 나라에서 구매하시나요?', processedFeedbackIds: [], history: [] })), feedback: [], runs: [], metrics: { sent: 0, customerResponses: 0, partnerResponses: 0, peerFeedback: 0, orders: 0 } });
const run = state => runLoop(state, { now: NOW });
const feedback = (state, leadId, facts, extra = {}) => recordFeedback(state, { leadId, sourceKind: 'customer', text: '실제 응답을 운영자가 기록', facts, ...extra }, NOW);

test('confirmed delivery and replenishment replace the next target; evidence explains the decision', async () => {
  const first = await run(make());
  assert.deepEqual(first.strategy.topTargets.map(item => item.leadId), ['A', 'B', 'C']);
  const recorded = feedback(first, 'D', { deliveryEligible: 'yes', country: 'Korea', purchaseIntent: 'yes', jarStatus: 'none', dish: '비빔밥' }, { eventId: 'response-D-1', evidenceRef: 'private-response-D' });
  const second = await run(recorded);
  assert.equal(second.strategy.topTargets[0].leadId, 'D');
  assert.equal(second.strategy.topTargets[0].segment, 'ready-to-buy');
  assert.ok(second.strategy.topTargets[0].evidenceIds.includes(recorded.feedback.at(-1).id));
  assert.equal(second.strategy.version, first.strategy.version + 1);
  assert.deepEqual(second.strategyHistory.at(-1).before.topTargets, first.strategy.topTargets);
  assert.match(second.leads.find(lead => lead.id === 'D').action.copy, /비빔밥/);
});

test('new country, dish and time replace the stale seed question without inferring delivery', async () => {
  let state = await run(make());
  state = feedback(state, 'A', { country: 'Korea', dish: '비빔밥', timeBudgetMinutes: 10, objection: 'time' });
  state = await run(state);
  const lead = state.leads[0];
  assert.equal(lead.country, 'Korea');
  assert.notEqual(lead.deliveryEligible, 'yes');
  assert.match(lead.action.copy, /10분/);
  assert.doesNotMatch(lead.action.copy, /어느 나라|국가는 어디|어떤 요리/);
  assert.doesNotMatch(lead.action.nextQuestion, /몇 분/);
});

test('same concern from two distinct actual customers creates a global message hypothesis', async () => {
  let state = await run(make());
  state = feedback(state, 'A', { objection: 'price' });
  state = feedback(state, 'A', { objection: 'price' });
  state = await run(state);
  assert.equal(state.strategy.messageHypothesis.concern, 'none');
  const unchangedC = structuredClone(state.leads[2]);
  state = feedback(state, 'B', { objection: 'price' });
  state = await run(state);
  assert.equal(state.strategy.messageHypothesis.concern, 'price');
  assert.equal(state.strategy.messageHypothesis.status, 'hypothesis');
  assert.equal(state.strategy.messageHypothesis.leadIds.length, 2);
  assert.match(state.leads[2].action.copy, /예산|총액/);
  assert.match(state.leads[2].action.reason, /가설|승자는 미확정/);
  assert.equal(state.leads[2].objection, unchangedC.objection);
  assert.equal(state.leads[2].country, unchangedC.country);
  assert.equal(state.leads[2].purchaseIntent, unchangedC.purchaseIntent);
});

test('removing a shared concern also removes its old draft from customers without that concern', async () => {
  let state = await run(make());
  state = feedback(state, 'A', { objection: 'price' });
  state = feedback(state, 'B', { objection: 'price' });
  state = await run(state);
  assert.match(state.leads[2].action.copy, /예산과 필요한 용량/);
  assert.equal(state.leads[2].appliedHypothesisId, 'total-cost');
  state = feedback(state, 'A', { objection: 'none' });
  state = feedback(state, 'B', { objection: 'none' });
  state = await run(state);
  assert.equal(state.strategy.messageHypothesis.id, 'next-meal');
  assert.equal(state.leads[2].appliedHypothesisId, 'next-meal');
  assert.doesNotMatch(state.leads[2].action.copy, /예산과 필요한 용량/);
  assert.doesNotMatch(state.leads[2].action.reason, /공통 우려/);
  assert.equal(state.leads[2].objection, undefined);
  assert.ok(state.runs.at(-1).changes.some(change => change.leadId === 'C'));
  const again = await run(state);
  assert.deepEqual(again.leads, state.leads);
});

test('a customer leaving the top targets loses a global draft while personal objections remain', async () => {
  let state = await run(make());
  state = feedback(state, 'A', { objection: 'price' });
  state = feedback(state, 'B', { objection: 'price' });
  state = await run(state);
  assert.equal(state.leads[2].appliedHypothesisId, 'total-cost');
  state = feedback(state, 'D', { deliveryEligible: 'yes', purchaseIntent: 'yes', jarStatus: 'none' });
  state = await run(state);
  assert.deepEqual(state.strategy.topTargets.map(target => target.leadId), ['D', 'A', 'B']);
  assert.equal(state.strategy.messageHypothesis.id, 'total-cost');
  assert.equal(state.leads[2].appliedHypothesisId, 'next-meal');
  assert.doesNotMatch(state.leads[2].action.copy, /예산과 필요한 용량/);
  assert.equal(state.leads[3].appliedHypothesisId, 'total-cost');
  assert.match(state.leads[3].action.copy, /예산과 필요한 용량/);
  // A personal price objection remains authoritative even after the person
  // leaves the global experiment's target list.
  state = feedback(state, 'D', { stopContact: true });
  state = feedback(state, 'C', { deliveryEligible: 'yes', purchaseIntent: 'yes', jarStatus: 'none' });
  state = feedback(state, 'B', { jarStatus: 'full' });
  state = await run(state);
  assert.equal(state.leads[1].appliedHypothesisId, 'next-meal');
  assert.equal(state.leads[1].objection, 'price');
  assert.match(state.leads[1].action.copy, /예산과 필요한 용량/);
});

test('no new evidence leaves strategy version, action text and reason unchanged', async () => {
  const first = await run(make());
  const second = await run(first);
  assert.deepEqual(second.strategy, first.strategy);
  assert.deepEqual(second.strategyHistory, first.strategyHistory);
  assert.deepEqual(second.leads, first.leads);
  assert.equal(second.runs.at(-1).strategyChanged, false);
});

test('test feedback, peers and public observations do not train customer facts or aggregate hypotheses', async () => {
  const first = await run(make());
  let state = feedback(first, 'D', { deliveryEligible: 'yes', jarStatus: 'none', purchaseIntent: 'yes', objection: 'price' }, { isTest: true });
  state = await run(state);
  assert.equal(state.metrics.customerResponses, 0);
  assert.deepEqual(state.strategy, first.strategy);
  assert.deepEqual(state.leads, first.leads);
  for (const [leadId, sourceKind] of [['A', 'peer'], ['B', 'public']]) state = recordFeedback(state, { leadId, sourceKind, text: '편집 의견', facts: { objection: 'price', country: 'France', deliveryEligible: 'yes', dish: '떡볶이', timeBudgetMinutes: 5 } }, NOW);
  state = await run(state);
  assert.equal(state.strategy.messageHypothesis.concern, 'none');
  assert.equal(state.leads[0].country, null);
  assert.equal(state.leads[0].dish, undefined);
  assert.notEqual(state.leads[0].deliveryEligible, 'yes');
});

test('stop and delivery rejection remove targets; later feedback cannot reset a stop request', async () => {
  let state = await run(make());
  state = feedback(state, 'A', { stopContact: true });
  state = feedback(state, 'B', { deliveryEligible: 'no' });
  state = await run(state);
  assert.deepEqual(state.strategy.topTargets.map(item => item.leadId), ['C', 'D']);
  assert.equal(state.leads[0].action.kind, 'close');
  assert.equal(state.leads[1].action.kind, 'close');
  state = feedback(state, 'A', { stopContact: false, deliveryEligible: 'yes', purchaseIntent: 'yes' });
  state = await run(state);
  assert.equal(state.leads[0].action.kind, 'close');
  assert.ok(!state.strategy.topTargets.some(item => item.leadId === 'A'));
});

test('same event ID is idempotent and different contents are rejected', async () => {
  const first = feedback(await run(make()), 'A', { country: 'Korea' }, { eventId: 'response-unique-1' });
  const duplicate = feedback(first, 'A', { country: 'Korea' }, { eventId: 'response-unique-1' });
  assert.deepEqual(duplicate, first);
  assert.throws(() => feedback(first, 'A', { country: 'France' }, { eventId: 'response-unique-1' }), /내용이 다릅니다/);
  assert.throws(() => feedback(first, 'A', { deliveryEligible: 'maybe' }));
  assert.throws(() => feedback(first, 'A', { timeBudgetMinutes: -1 }));
});

test('verified attributed payment moves a customer out of sales targets into usage support', async () => {
  let state = await run(make());
  state = feedback(state, 'A', { deliveryEligible: 'yes', dish: '비빔밥' });
  state = await run(state);
  state = recordActivity(state, { activityId: 'proposal-A-1', type: 'proposal_sent', leadId: 'A', channel: 'direct', variantId: 'next-meal', happenedAt: '2026-10-25T10:00:00Z', evidenceRef: 'private-sent-A' }, NOW);
  state = recordOrder(state, { orderId: 'order-A-1', customerId: 'customer-A', leadId: 'A', activityId: 'proposal-A-1', status: 'paid', amountKRW: 25000, paidAt: '2026-10-25T11:00:00Z', evidenceRef: 'private-payment-A', paymentVerified: true }, NOW);
  state = await run(state);
  assert.equal(state.leads[0].action.kind, 'support');
  assert.equal(state.leads[0].commercialState, 'paid');
  assert.ok(!state.strategy.topTargets.some(item => item.leadId === 'A'));
  assert.match(state.leads[0].action.copy, /비빔밥/);
  const again = await run(state);
  assert.deepEqual(again.strategy, state.strategy);
  assert.deepEqual(again.leads, state.leads);
});
