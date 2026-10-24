import { randomUUID } from 'node:crypto';
import { AppError } from './engine.mjs';

const WINDOW = Object.freeze({ goalOrders: 10, startAt: '2026-10-24T00:00:00+09:00', deadline: '2026-10-31T18:00:00+09:00', timezone: 'Asia/Seoul' });
const clone = value => structuredClone(value);
const kstDate = value => new Date(Date.parse(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const identical = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new AppError(`${label} 필드를 확인하세요.`);
}
function token(value, label, max = 160) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) || value.length > max || (/^[\d.:-]+$/.test(value) && value.replace(/\D/g, '').length >= 10)) throw new AppError(`${label}은 개인정보가 없는 영문·숫자 ID여야 합니다.`);
  return value;
}
function reference(value) {
  return token(value, '증빙 참조', 300);
}
function bool(value, label, defaultValue) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'boolean') throw new AppError(`${label}은 명시적인 boolean이어야 합니다.`);
  return value;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError(`${label}은 시간대가 있는 ISO 시각이어야 합니다.`);
  return new Date(value).toISOString();
}
function presentLead(state, id) {
  const leadId = token(id, '대상 ID');
  const lead = state.leads?.find(item => item.id === leadId);
  if (!lead) throw new AppError('대상 원장에 없는 leadId입니다.', 404);
  return lead;
}
function notFuture(value, now, label) {
  if (Date.parse(value) > Date.parse(now)) throw new AppError(`${label}에 미래 시각을 기록할 수 없습니다.`);
}
function withinWindow(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(WINDOW.startAt) && time <= Date.parse(WINDOW.deadline);
}

// v1 counters remain intact for compatibility. They never become verified results.
export function ensureCampaign(original) {
  const state = clone(original);
  state.campaign = { ...state.campaign, ...WINDOW, verification: 'operator_attested_not_payment_api' };
  for (const key of ['activityEvents', 'orderEvents', 'dailySnapshots', 'dailySnapshotHistory']) {
    if (state[key] === undefined) state[key] = [];
    if (!Array.isArray(state[key])) throw new AppError(`${key} 원장 형식이 올바르지 않습니다.`);
  }
  return state;
}

export function recordActivity(original, body, now = new Date().toISOString()) {
  fields(body, ['activityId', 'type', 'leadId', 'channel', 'variantId', 'happenedAt', 'evidenceRef', 'isTest'], '활동');
  const recordedAt = timestamp(now, '기록 시각');
  const state = ensureCampaign(original);
  const lead = presentLead(state, body.leadId);
  if (!['proposal_sent', 'landing_visit'].includes(body.type)) throw new AppError('실제 완료한 proposal_sent 또는 landing_visit만 기록합니다.');
  const activity = {
    activityId: token(body.activityId, '활동 ID'), type: body.type, leadId: lead.id,
    channel: token(body.channel, '채널', 80), variantId: token(body.variantId, '문구 변형 ID'),
    happenedAt: timestamp(body.happenedAt, '활동 시각'), evidenceRef: reference(body.evidenceRef),
    isTest: bool(body.isTest, '테스트 여부', false)
  };
  notFuture(activity.happenedAt, recordedAt, '활동');
  const previous = state.activityEvents.find(item => item.activityId === activity.activityId);
  if (previous) {
    const previousInput = Object.fromEntries(Object.keys(activity).map(key => [key, previous[key]]));
    if (!identical(previousInput, activity)) throw new AppError('기존 활동 ID의 내용·테스트 여부를 변경할 수 없습니다.', 409);
    return state;
  }
  const target = state.strategy?.topTargets?.find(item => item.leadId === lead.id);
  activity.snapshot = {
    type: lead.type ?? null, country: lead.country ?? null, jarStatus: lead.jarStatus ?? 'unknown',
    purchaseIntent: lead.purchaseIntent ?? 'unknown', deliveryEligible: lead.deliveryEligible ?? 'unknown',
    stopContact: lead.stopContact === true,
    targetSegment: target?.segment ?? lead.segment ?? lead.targetSegment ?? null,
    strategyVersion: state.strategy?.version ?? state.strategyVersion ?? null,
    actionKind: lead.action?.kind ?? null, draft: lead.action?.copy ?? lead.draft ?? '',
    qualified: lead.deliveryEligible === 'yes' && lead.stopContact !== true && (lead.purchaseIntent === 'yes' || ['low', 'none'].includes(lead.jarStatus))
  };
  activity.recordedAt = recordedAt;
  state.activityEvents.push(activity);
  state.updatedAt = recordedAt;
  return state;
}

export function recordOrder(original, body, now = new Date().toISOString()) {
  fields(body, ['orderId', 'customerId', 'leadId', 'activityId', 'status', 'amountKRW', 'paidAt', 'evidenceRef', 'paymentVerified', 'isTest'], '주문');
  const recordedAt = timestamp(now, '기록 시각');
  const state = ensureCampaign(original);
  const lead = presentLead(state, body.leadId);
  if (!['paid', 'pending', 'cancelled', 'refunded'].includes(body.status)) throw new AppError('주문 상태는 paid/pending/cancelled/refunded 중 하나여야 합니다.');
  if (!Number.isSafeInteger(body.amountKRW) || body.amountKRW < 0 || (body.status === 'paid' && body.amountKRW === 0)) throw new AppError('금액은 실제 원화 정수이며 paid 주문은 1원 이상이어야 합니다.');
  const order = {
    orderId: token(body.orderId, '주문 ID'), customerId: token(body.customerId, '고객 가명 ID'), leadId: lead.id,
    activityId: token(body.activityId, '귀속 활동 ID'), status: body.status, amountKRW: body.amountKRW,
    paidAt: body.paidAt === null && body.status !== 'paid' ? null : timestamp(body.paidAt, '결제 시각'),
    evidenceRef: reference(body.evidenceRef), paymentVerified: bool(body.paymentVerified, '결제 증빙 확인 여부'), isTest: bool(body.isTest, '테스트 여부', false)
  };
  if (order.paidAt) notFuture(order.paidAt, recordedAt, '결제');
  const activity = state.activityEvents.find(item => item.activityId === order.activityId);
  if (!activity || activity.leadId !== order.leadId) throw new AppError('같은 대상의 실제 활동에 주문을 연결해야 합니다.');
  if (order.paidAt && Date.parse(activity.happenedAt) > Date.parse(order.paidAt)) throw new AppError('결제 뒤에 발생한 활동으로 주문을 귀속할 수 없습니다.');
  const history = state.orderEvents.filter(item => item.orderId === order.orderId);
  const previous = history.at(-1);
  if (previous) {
    const previousInput = Object.fromEntries(Object.keys(order).map(key => [key, previous[key]]));
    if (identical(previousInput, order)) return state;
    if (Date.parse(recordedAt) < Date.parse(previous.recordedAt)) throw new AppError('주문 변경 기록의 시각을 이전 기록보다 앞당길 수 없습니다.', 409);
    for (const key of ['customerId', 'leadId', 'activityId', 'isTest']) if (previous[key] !== order[key]) throw new AppError('주문의 고객·귀속·테스트 여부는 변경할 수 없습니다.', 409);
    if (['cancelled', 'refunded'].includes(previous.status) && order.status !== previous.status) throw new AppError('취소·환불한 주문을 다시 결제 주문으로 되돌릴 수 없습니다.', 409);
    if (previous.status === 'paid' && order.status === 'pending') throw new AppError('결제한 주문을 미결제 상태로 되돌릴 수 없습니다.', 409);
    const paid = history.find(item => item.status === 'paid');
    if (paid) {
      for (const key of ['amountKRW', 'paidAt', 'evidenceRef']) if (paid[key] !== order[key]) throw new AppError('최초 결제의 금액·시각·증빙 원천은 변경할 수 없습니다.', 409);
      if (paid.paymentVerified && !order.paymentVerified) throw new AppError('확인한 결제 증빙을 조용히 해제할 수 없습니다. 취소·환불 상태를 기록하세요.', 409);
    }
  }
  state.orderEvents.push({ ...order, eventId: randomUUID(), recordedAt });
  state.updatedAt = recordedAt;
  return state;
}

function latestOrders(state, at) {
  const latest = new Map();
  for (const entry of state.orderEvents) if (Date.parse(entry.recordedAt) <= Date.parse(at)) latest.set(entry.orderId, entry);
  return [...latest.values()];
}
function orderReason(order, activities, at) {
  if (order.isTest) return 'test_order';
  if (order.status === 'pending') return 'pending';
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'refunded') return 'refunded';
  if (order.status !== 'paid') return 'invalid_status';
  if (!order.paymentVerified) return 'payment_unverified';
  if (!Number.isSafeInteger(order.amountKRW) || order.amountKRW < 1) return 'invalid_amount';
  if (!withinWindow(order.paidAt)) return 'outside_period';
  if (Date.parse(order.paidAt) > Date.parse(at)) return 'deferred';
  const activity = activities.find(item => item.activityId === order.activityId);
  if (!activity || !order.customerId || activity.leadId !== order.leadId) return 'missing_attribution';
  if (activity.isTest) return 'test_attribution';
  if (!withinWindow(activity.happenedAt)) return 'activity_outside_period';
  if (Date.parse(activity.happenedAt) > Date.parse(order.paidAt)) return 'activity_after_payment';
  if (!order.evidenceRef || !activity.evidenceRef) return 'missing_evidence';
  return null;
}
function validData(state, at) {
  const activities = state.activityEvents.filter(item => Date.parse(item.recordedAt) <= Date.parse(at));
  const orders = latestOrders(state, at);
  const checked = orders.map(order => ({ order, reason: orderReason(order, activities, at) }));
  return { activities, orders, checked, valid: checked.filter(item => !item.reason).map(item => item.order) };
}

// Internal business logic only. This array contains private attribution IDs and
// must never be written to the public daily report or summary endpoint.
export function validPaidOrders(original, at = new Date().toISOString()) {
  return clone(validData(ensureCampaign(original), timestamp(at, '집계 시각')).valid);
}

// Only counts, money, dates and fixed reason labels leave this boundary.
export function campaignSummary(original, at = new Date().toISOString()) {
  const state = ensureCampaign(original);
  const asOf = timestamp(at, '집계 시각');
  const { activities, orders, checked, valid } = validData(state, asOf);
  const eligible = activities.filter(item => !item.isTest && withinWindow(item.happenedAt) && Date.parse(item.happenedAt) <= Date.parse(asOf));
  const proposals = eligible.filter(item => item.type === 'proposal_sent');
  const qualified = proposals.filter(item => item.snapshot?.qualified === true);
  const qualifiedIds = new Set(qualified.map(item => item.activityId));
  const converted = new Set(valid.filter(item => qualifiedIds.has(item.activityId)).map(item => item.activityId));
  const reasons = {};
  for (const item of checked) if (item.reason) reasons[item.reason] = (reasons[item.reason] || 0) + 1;
  return {
    goalOrders: WINDOW.goalOrders, validOrders: valid.length, uniqueCustomers: new Set(valid.map(item => item.customerId)).size,
    netRevenueKRW: valid.reduce((sum, item) => sum + item.amountKRW, 0), sent: proposals.length,
    qualifiedProposals: qualified.length, convertedProposals: converted.size,
    conversionRate: qualified.length ? converted.size / qualified.length : 0,
    landingVisits: eligible.filter(item => item.type === 'landing_visit').length,
    remainingOrders: Math.max(0, WINDOW.goalOrders - valid.length), totalOrders: orders.length,
    excludedOrders: orders.length - valid.length, testOrders: reasons.test_order || 0,
    pendingOrders: reasons.pending || 0, cancelledOrders: reasons.cancelled || 0,
    refundedOrders: reasons.refunded || 0, unverifiedOrders: reasons.payment_unverified || 0,
    outsidePeriodOrders: reasons.outside_period || 0, deferredOrders: reasons.deferred || 0,
    exclusionReasons: reasons, window: { startAt: WINDOW.startAt, deadline: WINDOW.deadline, timezone: WINDOW.timezone, asOf },
    verification: 'operator_attested_not_payment_api', legacyMetricsExcluded: true
  };
}

export function dailySnapshot(original, date, now = new Date().toISOString()) {
  const midnight = typeof date === 'string' ? Date.parse(`${date}T00:00:00+09:00`) : NaN;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) || kstDate(new Date(midnight).toISOString()) !== date) throw new AppError('일지는 실제 YYYY-MM-DD 날짜여야 합니다.');
  const computedAt = timestamp(now, '기록 시각');
  if (date > kstDate(computedAt)) throw new AppError('미래 날짜의 성과를 기록할 수 없습니다.');
  const state = ensureCampaign(original);
  const endAt = new Date(Math.min(Date.parse(`${date}T23:59:59.999+09:00`), Date.parse(computedAt))).toISOString();
  const cumulative = campaignSummary(state, endAt);
  const { activities, valid } = validData(state, endAt);
  const dailyActivities = activities.filter(item => !item.isTest && withinWindow(item.happenedAt) && kstDate(item.happenedAt) === date);
  const dailyProposals = dailyActivities.filter(item => item.type === 'proposal_sent' && item.snapshot?.qualified === true);
  const proposalIds = new Set(dailyProposals.map(item => item.activityId));
  // Human payment evidence can be checked after the original payment day.
  // Allocate the daily result to its confirmed ledger-entry day so a late
  // verified order appears in a daily result as well as the cumulative total.
  // paidAt still determines whether the order belongs to the campaign window.
  const dailyOrders = valid.filter(item => kstDate(item.recordedAt) === date);
  const conversions = new Set(valid.filter(item => proposalIds.has(item.activityId)).map(item => item.activityId)).size;
  const value = {
    date, dailyDayBasis: 'verification_recorded_at', daily: {
      sent: dailyActivities.filter(item => item.type === 'proposal_sent').length, qualifiedProposals: dailyProposals.length,
      landingVisits: dailyActivities.filter(item => item.type === 'landing_visit').length,
      validOrders: dailyOrders.length, uniqueCustomers: new Set(dailyOrders.map(item => item.customerId)).size,
      netRevenueKRW: dailyOrders.reduce((sum, item) => sum + item.amountKRW, 0), convertedProposals: conversions,
      conversionRate: dailyProposals.length ? conversions / dailyProposals.length : 0
    }, cumulative
  };
  const index = state.dailySnapshots.findIndex(item => item.date === date);
  const previous = state.dailySnapshots[index];
  if (previous) {
    const comparable = clone(previous); delete comparable.computedAt; delete comparable.revision;
    const before = clone(comparable); delete before.cumulative.window.asOf;
    const after = clone(value); delete after.cumulative.window.asOf;
    if (identical(before, after)) return state;
    state.dailySnapshotHistory.push(clone(previous));
  }
  const entry = { ...value, revision: (previous?.revision || 0) + 1, computedAt };
  if (index < 0) state.dailySnapshots.push(entry); else state.dailySnapshots[index] = entry;
  state.dailySnapshots.sort((a, b) => a.date.localeCompare(b.date));
  state.updatedAt = computedAt;
  return state;
}
