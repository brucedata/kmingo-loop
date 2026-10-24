import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recordFeedback, runLoop } from '../lib/engine.mjs';
import { dailyMarkdown, publicDaily, recordDaily, seoulDate } from '../lib/journal.mjs';

const now = '2026-10-24T10:00:00.000Z';
const fixture = async () => JSON.parse(await readFile(new URL('../seed.json', import.meta.url), 'utf8'));

test('daily journal is reproducible, preserves revisions, and does not invent improvements', async () => {
  let state = await runLoop(await fixture(), { now });
  let journal = recordDaily(state, { now, note: 'private operator note' });
  assert.equal(journal.entry.date, '2026-10-24');
  assert.equal(journal.entry.metrics.validOrders, 0);
  assert.equal(journal.entry.totalPolicyChanges, 0);
  state = await runLoop(journal.state, { now: '2026-10-24T10:01:00Z' });
  const repeat = recordDaily(state, { now: '2026-10-24T10:01:00Z', note: 'private operator note' });
  assert.equal(repeat.changed, false);
  assert.equal(repeat.state.dailyJournal.length, 1);
  state = recordFeedback(repeat.state, { eventId: 'journal-ready', leadId: 'Q04', sourceKind: 'customer', text: 'Fixture only. 국내 수령 가능하며 구매를 검토합니다.', facts: { purchaseIntent: 'yes', deliveryEligible: 'yes', jarStatus: 'none' } }, '2026-10-24T10:02:00Z');
  state = await runLoop(state, { now: '2026-10-24T10:03:00Z' });
  journal = recordDaily(state, { now: '2026-10-24T10:03:00Z', note: 'private operator note' });
  assert.equal(journal.entry.revision, 2);
  assert.equal(journal.state.dailyJournal.length, 2);
  assert.equal(journal.entry.totalPolicyChanges, 1);
  assert.equal(journal.entry.policyChangesToday, 1);
  assert.match(journal.entry.improvementReason, /우선 대상/);
});

test('public daily report excludes private input, targets and evidence references', async () => {
  let state = await runLoop(await fixture(), { now });
  state.strategy.topTargets[0].leadId = 'PRIVATE_CUSTOMER';
  state.strategy.topTargets[0].evidenceIds = ['PRIVATE_PAYMENT_REFERENCE'];
  const { entry } = recordDaily(state, { now, note: 'private@example.com PRIVATE_OPERATOR_NOTE' });
  const text = dailyMarkdown(entry);
  const output = JSON.stringify(publicDaily(entry));
  for (const forbidden of ['private@example.com', 'PRIVATE_OPERATOR_NOTE', 'PRIVATE_CUSTOMER', 'PRIVATE_PAYMENT_REFERENCE']) {
    assert.ok(!text.includes(forbidden)); assert.ok(!output.includes(forbidden));
  }
  assert.match(text, /0\/10건/);
  assert.match(text, /직접 확인해 입력한/);
  assert.ok(!Object.hasOwn(publicDaily(entry), 'topTargets'));
});

test('historical journal uses the policy known then and never future performance', async () => {
  let state = await runLoop(await fixture(), { now });
  const baselineVersion = state.strategy.version;
  const baselineTargets = structuredClone(state.strategy.topTargets);
  state = recordFeedback(state, { leadId: 'Q04', sourceKind: 'customer', text: 'Fixture only. 구매 조건 확인', facts: { deliveryEligible: 'yes', purchaseIntent: 'yes' } }, '2026-10-25T01:00:00Z');
  state = await runLoop(state, { now: '2026-10-25T01:01:00Z' });
  const backfill = recordDaily(state, { date: '2026-10-24', now: '2026-10-25T01:02:00Z' });
  assert.equal(backfill.entry.strategyVersion, baselineVersion);
  assert.equal(backfill.entry.evidenceCounts.customerResponses, 0);
  assert.equal(backfill.entry.totalPolicyChanges, 0);
  assert.deepEqual(backfill.entry.topTargets, baselineTargets);
  const nextDay = recordDaily(state, { date: '2026-10-26', now: '2026-10-26T01:00:00Z' });
  assert.equal(nextDay.entry.policyChangesToday, 0);
  assert.match(nextDay.entry.improvementReason, /새로 기록된 전략 판단이 없습니다/);
});

test('journal rejects future, out-of-campaign and impossible dates', async () => {
  const state = await fixture();
  for (const date of ['2026-10-25', '2026-10-23', '2026-11-01', '2026-02-30', '../../report']) assert.throws(() => recordDaily(state, { date, now }));
  assert.equal(seoulDate('2026-10-24T15:00:00Z'), '2026-10-25');
});
