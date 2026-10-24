import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignSummary, dailySnapshot, ensureCampaign, recordActivity, recordOrder, validPaidOrders } from '../lib/campaign.mjs';

const NOW = '2026-10-24T12:00:00+09:00';
const ACTIVITY_TIME = '2026-10-24T10:00:00+09:00';
const PAID_TIME = '2026-10-24T11:00:00+09:00';
const seed = () => ({ version: 1, leads: [
  { id: 'Q01', type: 'consumer', country: 'KR', jarStatus: 'low', purchaseIntent: 'yes', deliveryEligible: 'yes', draft: 'private sales copy', action: { kind: 'qualify' } },
  { id: 'Q02', type: 'consumer', country: 'KR', jarStatus: 'full', purchaseIntent: 'unknown', deliveryEligible: 'unknown' }
], metrics: { sent: 900, orders: 999 }, feedback: [], runs: [] });
const activity = (changes = {}) => ({ activityId: 'A-001', type: 'proposal_sent', leadId: 'Q01', channel: 'manual-review', variantId: 'next-meal-v1', happenedAt: ACTIVITY_TIME, evidenceRef: 'private-activity:receipt-01', ...changes });
const order = (changes = {}) => ({ orderId: 'O-001', customerId: 'C-001', leadId: 'Q01', activityId: 'A-001', status: 'paid', amountKRW: 25000, paidAt: PAID_TIME, evidenceRef: 'private-payment:receipt-01', paymentVerified: true, ...changes });
const withActivity = () => recordActivity(seed(), activity(), NOW);
const withPaid = () => recordOrder(withActivity(), order(), NOW);

test('v1 migration is immutable and never treats old counters as evidence', () => {
  const original = seed();
  const migrated = ensureCampaign(original);
  assert.equal(original.campaign, undefined);
  assert.deepEqual(migrated.metrics, { sent: 900, orders: 999 });
  const summary = campaignSummary(migrated, NOW);
  assert.equal(summary.validOrders, 0);
  assert.equal(summary.sent, 0);
  assert.equal(summary.remainingOrders, 10);
  assert.equal(summary.verification, 'operator_attested_not_payment_api');
});

test('an activity is idempotent and its original qualification and copy stay fixed', () => {
  let state = withActivity();
  state.leads[0].deliveryEligible = 'unknown';
  state.leads[0].purchaseIntent = 'no';
  state.leads[0].draft = 'changed copy';
  const repeated = recordActivity(state, activity(), NOW);
  assert.equal(repeated.activityEvents.length, 1);
  assert.equal(repeated.activityEvents[0].snapshot.qualified, true);
  assert.equal(repeated.activityEvents[0].snapshot.draft, 'private sales copy');
  assert.equal(campaignSummary(repeated, NOW).qualifiedProposals, 1);
  assert.throws(() => recordActivity(state, activity({ isTest: true }), NOW), /변경/);
  assert.throws(() => recordActivity(state, activity({ variantId: 'other-v2' }), NOW), /변경/);
});

test('qualification requires delivery confirmation rather than a domestic country alone', () => {
  const original = seed();
  original.leads[0].deliveryEligible = 'unknown';
  const state = recordActivity(original, activity(), NOW);
  assert.equal(campaignSummary(state, NOW).sent, 1);
  assert.equal(campaignSummary(state, NOW).qualifiedProposals, 0);
});

test('only explicit completed, timestamped and evidenced activities can be logged', () => {
  assert.throws(() => recordActivity(seed(), activity({ type: 'draft' }), NOW));
  assert.throws(() => recordActivity(seed(), activity({ leadId: 'missing' }), NOW));
  assert.throws(() => recordActivity(seed(), activity({ happenedAt: '2026-10-24T13:00:00+09:00' }), NOW), /미래/);
  assert.throws(() => recordActivity(seed(), activity({ happenedAt: '2026-10-24' }), NOW), /ISO/);
  assert.throws(() => recordActivity(seed(), activity({ evidenceRef: undefined }), NOW));
  assert.throws(() => recordActivity(seed(), activity({ channel: 'someone@example.com' }), NOW));
  assert.throws(() => recordActivity(seed(), activity({ variantId: '010-1234-5678' }), NOW));
});

test('verified attributed paid orders count once and repeated input is idempotent', () => {
  const original = withActivity();
  const state = recordOrder(original, order(), NOW);
  const repeated = recordOrder(state, order(), NOW);
  assert.equal(original.orderEvents.length, 0);
  assert.equal(repeated.orderEvents.length, 1);
  const summary = campaignSummary(repeated, NOW);
  assert.equal(summary.validOrders, 1);
  assert.equal(summary.uniqueCustomers, 1);
  assert.equal(summary.netRevenueKRW, 25000);
  assert.equal(summary.qualifiedProposals, 1);
  assert.equal(summary.convertedProposals, 1);
  assert.equal(summary.conversionRate, 1);
});

test('repeat purchases keep order and revenue totals but never inflate proposal conversion', () => {
  let state = withPaid();
  state = recordOrder(state, order({ orderId: 'O-002' }), NOW);
  const summary = campaignSummary(state, NOW);
  assert.equal(summary.validOrders, 2);
  assert.equal(summary.uniqueCustomers, 1);
  assert.equal(summary.netRevenueKRW, 50000);
  assert.equal(summary.convertedProposals, 1);
  assert.equal(summary.conversionRate, 1);
});

test('order state changes append history and cancellation removes payment from valid results', () => {
  const paid = withPaid();
  const cancelled = recordOrder(paid, order({ status: 'cancelled' }), NOW);
  assert.equal(paid.orderEvents.length, 1);
  assert.equal(cancelled.orderEvents.length, 2);
  assert.equal(cancelled.orderEvents[0].status, 'paid');
  const summary = campaignSummary(cancelled, NOW);
  assert.equal(summary.validOrders, 0);
  assert.equal(summary.netRevenueKRW, 0);
  assert.equal(summary.cancelledOrders, 1);
  assert.equal(validPaidOrders(cancelled, NOW).length, 0);
  assert.throws(() => recordOrder(cancelled, order(), NOW), /되돌릴/);
});

test('a refund is excluded and cannot be revived as a paid order', () => {
  const state = recordOrder(withPaid(), order({ status: 'refunded' }), NOW);
  assert.equal(campaignSummary(state, NOW).refundedOrders, 1);
  assert.throws(() => recordOrder(state, order(), NOW), /되돌릴/);
});

test('customer, attribution, test flag and paid facts cannot be silently rewritten', () => {
  const state = withPaid();
  for (const changes of [
    { customerId: 'C-002' }, { isTest: true }, { amountKRW: 30000 },
    { paidAt: '2026-10-24T11:30:00+09:00' }, { evidenceRef: 'another-receipt' },
    { paymentVerified: false }, { status: 'pending' }
  ]) assert.throws(() => recordOrder(state, order(changes), NOW));
});

test('pending orders can become paid with an explicit payment check and remain append only', () => {
  let state = recordOrder(withActivity(), order({ status: 'pending', paidAt: null, paymentVerified: false, evidenceRef: 'private-intent:01' }), NOW);
  assert.equal(campaignSummary(state, NOW).pendingOrders, 1);
  assert.equal(campaignSummary(state, NOW).validOrders, 0);
  state = recordOrder(state, order(), NOW);
  assert.equal(state.orderEvents.length, 2);
  assert.equal(campaignSummary(state, NOW).validOrders, 1);
  assert.throws(() => recordOrder(withActivity(), order({ paymentVerified: undefined }), NOW), /명시/);
});

test('test orders, test attribution and unchecked payment never count as actual results', () => {
  const tested = recordOrder(withActivity(), order({ isTest: true }), NOW);
  assert.equal(campaignSummary(tested, NOW).testOrders, 1);
  assert.throws(() => recordOrder(tested, order({ isTest: false }), NOW), /테스트/);
  const testActivity = recordActivity(seed(), activity({ isTest: true }), NOW);
  const attributed = recordOrder(testActivity, order(), NOW);
  assert.equal(campaignSummary(attributed, NOW).validOrders, 0);
  assert.equal(campaignSummary(attributed, NOW).exclusionReasons.test_attribution, 1);
  const unchecked = recordOrder(withActivity(), order({ paymentVerified: false }), NOW);
  assert.equal(campaignSummary(unchecked, NOW).unverifiedOrders, 1);
  assert.equal(campaignSummary(unchecked, NOW).netRevenueKRW, 0);
});

test('only same-lead activity preceding the payment is valid attribution', () => {
  assert.throws(() => recordOrder(withActivity(), order({ activityId: 'missing' }), NOW), /활동/);
  assert.throws(() => recordOrder(withActivity(), order({ leadId: 'Q02' }), NOW), /활동/);
  assert.throws(() => recordOrder(withActivity(), order({ paidAt: '2026-10-24T09:00:00+09:00' }), NOW), /결제 뒤/);
  const raw = ensureCampaign(seed());
  raw.orderEvents.push({ ...order(), recordedAt: NOW });
  assert.equal(campaignSummary(raw, NOW).exclusionReasons.missing_attribution, 1);
});

test('deadline and campaign start use KST and out-of-window payment is excluded', () => {
  const end = '2026-10-31T18:00:00+09:00';
  const atEnd = recordOrder(withActivity(), order({ paidAt: end }), end);
  assert.equal(campaignSummary(atEnd, end).validOrders, 1);
  const late = '2026-10-31T18:00:01+09:00';
  const outside = recordOrder(withActivity(), order({ paidAt: late }), late);
  assert.equal(campaignSummary(outside, late).outsidePeriodOrders, 1);
  const old = recordActivity(seed(), activity({ happenedAt: '2026-10-23T23:59:59+09:00' }), NOW);
  const invalidAttribution = recordOrder(old, order(), NOW);
  assert.equal(campaignSummary(invalidAttribution, NOW).exclusionReasons.activity_outside_period, 1);
});

test('a landing attribution counts revenue without pretending to be a qualified proposal conversion', () => {
  const landing = recordActivity(seed(), activity({ type: 'landing_visit' }), NOW);
  const summary = campaignSummary(recordOrder(landing, order(), NOW), NOW);
  assert.equal(summary.validOrders, 1);
  assert.equal(summary.landingVisits, 1);
  assert.equal(summary.sent, 0);
  assert.equal(summary.convertedProposals, 0);
  assert.equal(summary.conversionRate, 0);
});

test('public summaries and snapshots omit private IDs, payment references and message text', () => {
  const state = dailySnapshot(withPaid(), '2026-10-24', NOW);
  const publicText = JSON.stringify({ summary: campaignSummary(state, NOW), snapshots: state.dailySnapshots });
  for (const privateValue of ['Q01', 'O-001', 'C-001', 'A-001', 'private-activity', 'private-payment', 'private sales copy', 'receipt-01']) assert.equal(publicText.includes(privateValue), false, privateValue);
});

test('daily snapshots are computed from ledgers, idempotent, and retain earlier revisions', () => {
  let state = dailySnapshot(withActivity(), '2026-10-24', NOW);
  assert.equal(state.dailySnapshots[0].daily.validOrders, 0);
  state = dailySnapshot(state, '2026-10-24', '2026-10-24T12:05:00+09:00');
  assert.equal(state.dailySnapshots[0].revision, 1);
  assert.equal(state.dailySnapshotHistory.length, 0);
  state = recordOrder(state, order(), '2026-10-24T12:10:00+09:00');
  state = dailySnapshot(state, '2026-10-24', '2026-10-24T12:15:00+09:00');
  assert.equal(state.dailySnapshots[0].revision, 2);
  assert.equal(state.dailySnapshotHistory[0].daily.validOrders, 0);
  assert.equal(state.dailySnapshots[0].daily.validOrders, 1);
  assert.equal(state.dailySnapshots[0].cumulative.validOrders, 1);
  assert.throws(() => dailySnapshot(state, '2026-10-25', NOW), /미래/);
});

test('an as-of summary excludes later-recorded changes rather than rewriting previous knowledge', () => {
  let state = withPaid();
  state = recordOrder(state, order({ status: 'refunded' }), '2026-10-25T12:00:00+09:00');
  assert.equal(campaignSummary(state, NOW).validOrders, 1);
  assert.equal(campaignSummary(state, '2026-10-25T12:00:00+09:00').validOrders, 0);
});

test('late payment evidence is allocated to its confirmation day without losing campaign attribution', () => {
  const nextDay = '2026-10-25T12:00:00+09:00';
  let state = recordOrder(withActivity(), order({ status: 'pending', paidAt: null, paymentVerified: false, evidenceRef: 'private-intent:01' }), NOW);
  state = recordOrder(state, order(), nextDay);
  state = dailySnapshot(state, '2026-10-24', nextDay);
  state = dailySnapshot(state, '2026-10-25', nextDay);
  const firstDay = state.dailySnapshots.find(item => item.date === '2026-10-24');
  const secondDay = state.dailySnapshots.find(item => item.date === '2026-10-25');
  assert.equal(firstDay.daily.validOrders, 0);
  assert.equal(secondDay.dailyDayBasis, 'verification_recorded_at');
  assert.equal(secondDay.daily.validOrders, 1);
  assert.equal(secondDay.daily.netRevenueKRW, 25000);
  assert.equal(secondDay.cumulative.validOrders, 1);
  assert.equal(validPaidOrders(state, nextDay)[0].paidAt, new Date(PAID_TIME).toISOString());
});
