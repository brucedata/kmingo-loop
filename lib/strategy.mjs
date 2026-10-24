import { createHash } from 'node:crypto';

const actual = event => event.isTest !== true;
const direct = event => actual(event) && ['customer', 'partner'].includes(event.sourceKind);
const angles = {
  price: { id: 'total-cost', angle: '현재 가격과 배송비를 합친 총액·필요 용량 확인', reason: '가격 우려에 답하기 위해 현재 총액을 확인하는 문구를 시험합니다.' },
  time: { id: 'time-fit', angle: '고객의 실제 조리 시간과 이미 준비된 재료 확인', reason: '시간 우려에 답하기 위해 준비 가능한 시간을 먼저 묻는 문구를 시험합니다.' },
  heat: { id: 'heat-check', angle: '선호 매운맛과 확인된 제품 맵기 정보 대조', reason: '맵기 우려에 답하기 위해 선호와 확인된 라벨 정보를 맞추는 문구를 시험합니다.' },
  ingredients: { id: 'label-check', angle: '구매 전 필요한 원재료·알레르기 라벨 확인', reason: '원재료 우려에 답하기 위해 확인할 성분을 먼저 묻는 문구를 시험합니다.' }
};

export function evidenceFingerprint(state) {
  const evidence = [
    ...(state.feedback || []).filter(actual).map(event => ['feedback', event.id, event.eventId || null, event.leadId, event.sourceKind, event.facts, event.text, event.observedAt || event.createdAt]),
    ...(state.activityEvents || []).filter(actual).map(event => ['activity', event.activityId || event.id || event.eventId, event.leadId, event.type, event.happenedAt]),
    ...(state.orderEvents || []).filter(actual).map(event => ['order', event.eventId || event.id, event.orderId, event.leadId, event.status, event.paymentVerified, event.paidAt]),
    state.leads.map(lead => ['lead', lead.id, lead.type, lead.sourceUrl, lead.jarStatus, lead.purchaseIntent, lead.deliveryEligible || 'unknown', lead.stopContact === true, lead.country || null, lead.dish || null, lead.timeBudgetMinutes || null])
  ];
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function messageHypothesis(state) {
  const latest = new Map();
  for (const event of (state.feedback || []).filter(direct)) {
    if (event.facts?.objection !== undefined) latest.set(event.leadId, event);
  }
  const groups = Object.keys(angles).map(concern => {
    const events = [...latest.values()].filter(event => event.facts.objection === concern);
    return { concern, events };
  }).filter(group => group.events.length >= 2).sort((a, b) => b.events.length - a.events.length || a.concern.localeCompare(b.concern));
  const group = groups[0];
  if (!group) return { id: 'next-meal', concern: 'none', angle: '고객의 다음 한 끼와 실제 구매·배송 조건 확인', status: 'hypothesis', evidenceIds: [], leadIds: [], reason: '공통 우려가 서로 다른 실제 응답자 2명 이상에게서 확인되지 않았습니다. 기본 제안을 유지하며 승자를 선언하지 않습니다.' };
  return { ...angles[group.concern], concern: group.concern, status: 'hypothesis', evidenceIds: group.events.map(event => event.id), leadIds: group.events.map(event => event.leadId), reason: `${group.events.length}명의 서로 다른 직접 응답에서 같은 우려가 확인됐습니다. ${angles[group.concern].reason} 다른 고객의 사실은 바꾸지 않으며 전환 우승 문구로 간주하지 않습니다.` };
}

function ranking(state, lead, paidLeadIds) {
  const directEvents = (state.feedback || []).filter(event => direct(event) && event.leadId === lead.id);
  const evidenceIds = directEvents.map(event => event.id);
  const addSource = evidenceIds.length ? evidenceIds : [`source:${lead.id}`];
  if (lead.stopContact) return { leadId: lead.id, score: -1000, segment: 'excluded', eligible: false, reason: '직접 연락 중단 요청이 있어 영업 대상에서 제외합니다.', evidenceIds: addSource };
  if (lead.deliveryEligible === 'no') return { leadId: lead.id, score: -900, segment: 'excluded', eligible: false, reason: '수령·배송 불가가 확인되어 영업 대상에서 제외합니다.', evidenceIds: addSource };
  if (paidLeadIds.has(lead.id)) return { leadId: lead.id, score: -100, segment: 'post-purchase', eligible: false, reason: '검증된 결제 고객은 재판매 제안 대신 사용 지원으로 전환합니다.', evidenceIds: [...addSource, ...(state.orderEvents || []).filter(event => actual(event) && event.leadId === lead.id).map(event => event.eventId || event.id || event.orderId)] };
  if (lead.jarStatus === 'full' || lead.purchaseIntent === 'no' || (lead.ownsGochujang === true && lead.jarStatus === 'unknown' && lead.purchaseIntent !== 'yes')) return { leadId: lead.id, score: 0, segment: 'usage-support', eligible: false, reason: '보유량 또는 구매 의사를 고려해 현재 가진 고추장 활용을 지원합니다.', evidenceIds: addSource };
  const ready = lead.deliveryEligible === 'yes' && (lead.purchaseIntent === 'yes' || ['low', 'none'].includes(lead.jarStatus));
  let score = lead.type === 'partner' ? 25 : 30;
  if (lead.purchaseIntent === 'yes') score += 30;
  if (['low', 'none'].includes(lead.jarStatus)) score += 20;
  if (lead.deliveryEligible === 'yes') score += 35;
  if (lead.country) score += 3;
  if (directEvents.length) score += 5;
  const segment = ready ? 'ready-to-buy' : lead.type === 'partner' ? 'partner-review' : 'qualify-delivery';
  const reason = ready ? '수령 가능과 구매 의사 또는 보충 필요가 확인되어 우선 구매 조건을 안내합니다.' : lead.type === 'partner' ? '협업 적합성과 실제 수령·구매 조건을 먼저 확인합니다.' : '구매·보충 신호가 있어 수령 가능 여부와 부족한 조건을 먼저 확인합니다.';
  return { leadId: lead.id, score, segment, eligible: true, reason, evidenceIds: addSource };
}

// All decisions are deterministic. Time passing or rerunning without new evidence
// does not manufacture a new strategy revision or an A/B-test winner.
export function deriveStrategy(state, { now = new Date().toISOString(), paidOrders = [] } = {}) {
  const fingerprint = evidenceFingerprint(state);
  const rankings = state.leads.map(lead => ranking(state, lead, new Set(paidOrders.map(order => order.leadId))));
  const byId = new Map(state.leads.map(lead => [lead.id, lead]));
  const topTargets = rankings.filter(item => item.eligible).sort((a, b) => b.score - a.score || (byId.get(a.leadId).priority ?? 999) - (byId.get(b.leadId).priority ?? 999) || a.leadId.localeCompare(b.leadId)).slice(0, 3).map(({ eligible, ...item }) => item);
  const hypothesis = messageHypothesis(state);
  if (state.strategy?.evidenceFingerprint === fingerprint) return { strategy: structuredClone(state.strategy), historyEntry: null, rankings, changed: false };
  const before = state.strategy ? { version: state.strategy.version, topTargets: state.strategy.topTargets, messageHypothesis: state.strategy.messageHypothesis } : null;
  const evidenceIds = [
    ...(state.feedback || []).filter(actual).map(event => event.id),
    ...(state.activityEvents || []).filter(actual).map(event => event.activityId || event.id || event.eventId),
    ...(state.orderEvents || []).filter(actual).map(event => event.eventId || event.id || event.orderId)
  ].filter(Boolean);
  let reason = '조사 근거를 기준으로 첫 우선 대상과 검증할 문구 가설을 정했습니다.';
  if (before) {
    const targetChanged = JSON.stringify(before.topTargets.map(item => item.leadId)) !== JSON.stringify(topTargets.map(item => item.leadId));
    const angleChanged = before.messageHypothesis?.id !== hypothesis.id;
    const explanations = [];
    if (targetChanged) explanations.push('수령 가능·구매 의사·보충 필요와 영업 제외 조건을 다시 확인해 다음 우선 대상을 바꿨습니다.');
    if (angleChanged) explanations.push(hypothesis.concern === 'none' ? '서로 다른 직접 응답의 공통 우려 근거가 부족해 기본 다음 한 끼 문구로 돌아갔습니다.' : hypothesis.reason);
    reason = explanations.join(' ') || '새 응답·활동·주문 근거를 검토했으며 현재 우선 대상과 문구 가설을 유지했습니다.';
  }
  const strategy = { version: (state.strategy?.version || 0) + 1, evidenceFingerprint: fingerprint, updatedAt: now, topTargets, messageHypothesis: hypothesis, evidenceIds, selectionPolicy: '확인된 배송·구매/보충 신호 우선, 중단·배송 불가·검증 결제·활용 지원 대상 제외', experimentStatus: '전환 우승 문구 미선정: 관찰 기간과 충분한 실제 발송·구매 근거를 갖춘 실험 후 판단', reason };
  const historyEntry = { version: strategy.version, createdAt: now, before, after: { version: strategy.version, topTargets, messageHypothesis: hypothesis }, reason: strategy.reason, evidenceIds };
  return { strategy, historyEntry, rankings, changed: true };
}
