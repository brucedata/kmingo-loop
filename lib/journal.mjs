import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { AppError } from './engine.mjs';
import { campaignSummary, dailySnapshot } from './campaign.mjs';

export function seoulDate(now = new Date().toISOString()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new AppError('유효한 기록 시각이 필요합니다.');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function metrics(summary) {
  return Object.fromEntries(['validOrders', 'uniqueCustomers', 'netRevenueKRW', 'sent', 'qualifiedProposals', 'convertedProposals', 'remainingOrders', 'excludedOrders', 'testOrders', 'cancelledOrders', 'refundedOrders', 'pendingOrders', 'unverifiedOrders'].map(key => [key, count(summary[key])]).concat([['conversionRate', Number.isFinite(summary.conversionRate) ? summary.conversionRate : 0]]));
}
function validateDate(date, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || seoulDate(`${date}T00:00:00+09:00`) !== date) throw new AppError('일지 날짜는 실제 YYYY-MM-DD여야 합니다.');
  if (date < '2026-10-24' || date > '2026-10-31') throw new AppError('이번 캠페인 일지는 2026-10-24부터 2026-10-31까지만 작성합니다.');
  if (date > seoulDate(now)) throw new AppError('미래 날짜의 일지를 만들 수 없습니다.');
}

export function recordDaily(original, { now = new Date().toISOString(), date = seoulDate(now), note = '' } = {}) {
  validateDate(date, now);
  if (typeof note !== 'string' || note.length > 4000) throw new AppError('운영 메모는 4000자 이하의 문자열이어야 합니다.');
  const state = dailySnapshot(original, date, now);
  state.dailyJournal ||= [];
  const snapshot = state.dailySnapshots.find(item => item.date === date);
  const cutoff = Math.min(Date.parse(now), Date.parse(`${date}T23:59:59.999+09:00`));
  const campaignStart = Date.parse(snapshot.cumulative.window.startAt);
  const feedback = state.feedback.filter(item => !item.isTest && Date.parse(item.createdAt) >= campaignStart && Date.parse(item.createdAt) <= cutoff);
  const historicalDecision = state.strategyHistory?.filter(item => Date.parse(item.createdAt) <= cutoff).at(-1);
  const strategy = date === seoulDate(now) ? state.strategy ?? {} : historicalDecision?.after ?? {};
  const previous = state.dailyJournal.filter(item => item.date === date).at(-1);
  const latestDecision = historicalDecision;
  const decisionsToday = (state.strategyHistory || []).filter(item => seoulDate(item.createdAt) === date && Date.parse(item.createdAt) <= cutoff);
  const changedPolicy = item => Boolean(item.before) && (JSON.stringify(item.before.topTargets?.map(target => target.leadId)) !== JSON.stringify(item.after.topTargets?.map(target => target.leadId)) || item.before.messageHypothesis?.id !== item.after.messageHypothesis?.id);
  const improvements = (state.strategyHistory || []).filter(item => Date.parse(item.createdAt) <= cutoff && changedPolicy(item));
  const actualFeedbackIds = new Set(feedback.filter(item => ['customer', 'partner'].includes(item.sourceKind)).map(item => item.id));
  const copyChanges = state.runs.filter(run => seoulDate(run.createdAt) === date && Date.parse(run.createdAt) <= cutoff).flatMap(run => run.changes || []).filter(change => change.before && change.before.copy !== change.after?.copy && change.feedbackIds?.some(id => actualFeedbackIds.has(id)));
  const improvementReason = decisionsToday.length === 0 ? '해당 일자에 새로 기록된 전략 판단이 없습니다. 기존 타깃과 문구 가설을 유지하며 추가 근거를 기다립니다.'
    : typeof strategy.reason === 'string' ? strategy.reason
    : typeof strategy.rationale === 'string' ? strategy.rationale
    : typeof latestDecision?.reason === 'string' ? latestDecision.reason
    : '확인된 고객 상태와 실제 증빙을 기준으로 다음 대상을 검토합니다. 새 성과가 없으면 기존 판단을 유지합니다.';
  const nextAction = typeof strategy.nextAction === 'string' ? strategy.nextAction
    : !strategy.topTargets?.length ? '새 실제 문의에서 배송·구매 가능 조건을 확인해 다음 영업 대상을 검토합니다. 기존 연락 중단 요청은 유지합니다.'
    : strategy.messageHypothesis?.concern && strategy.messageHypothesis.concern !== 'none' ? '우선 대상에게 공통 우려를 해결하는 문구 가설을 검토·전달하고 실제 응답과 결제 결과를 다음 회차에 비교합니다.'
    : '선정된 대상의 배송 가능 여부와 구매 의사를 확인하고, 사람이 실제로 전달한 제안과 받은 응답을 기록합니다.';
  const entry = {
    date, strategyVersion: count(strategy.version), improvementReason, nextAction,
    metrics: metrics(snapshot.cumulative), daily: metrics(snapshot.daily),
    evidenceCounts: {
      customerResponses: feedback.filter(item => item.sourceKind === 'customer').length,
      partnerResponses: feedback.filter(item => item.sourceKind === 'partner').length,
      orders: count(snapshot.cumulative.validOrders)
    },
    targetCount: Array.isArray(strategy.topTargets) ? strategy.topTargets.length : 0,
    policyChangesToday: decisionsToday.filter(changedPolicy).length, totalPolicyChanges: improvements.length,
    copyChangesToday: copyChanges.length,
    actionTransitions: copyChanges.map(change => ({ before: change.before.kind, after: change.after.kind })),
    feedbackCount: feedback.length, note,
    topTargets: structuredClone(strategy.topTargets || []),
    messageAngle: strategy.messageHypothesis?.id ?? null,
    campaignWindow: { startAt: snapshot.cumulative.window.startAt, deadline: snapshot.cumulative.window.deadline, timezone: 'Asia/Seoul' }
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  if (previous?.fingerprint === fingerprint) return { state, entry: previous, changed: false };
  const saved = { id: randomUUID(), revision: (previous?.revision || 0) + 1, createdAt: now, runId: state.runs.at(-1)?.id ?? null, ...entry, fingerprint };
  state.dailyJournal.push(saved);
  state.updatedAt = now;
  return { state, entry: saved, changed: true };
}

const safeSegments = {
  'ready-to-buy': '구매 조건 확인 완료 고객', 'qualify-delivery': '배송 조건 확인 중인 고객', 'partner-review': '요리 클래스 협업 후보',
  ready: '구매 조건 확인 완료 고객', ready_to_buy: '구매 조건 확인 완료 고객',
  qualify: '구매 조건 확인 중인 고객', qualification: '구매 조건 확인 중인 고객',
  support: '현재 보유 제품 활용 고객', partner: '요리 클래스 협업 후보',
  closed: '연락 중단', ineligible: '현재 배송 불가'
};
function safeReason(value) {
  // Reasons are code-generated policy explanations. Never publish notes, names,
  // evidence URLs or feedback bodies; redact accidental contact-like strings.
  return String(value || '').replace(/https?:\/\/\S+/g, '[근거 비공개]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[연락처 비공개]').replace(/(?:\+?\d[\d ()-]{8,}\d)/g, '[식별자 비공개]').replace(/[<>|\r\n]/g, ' ').slice(0, 800);
}
export function publicDaily(entry) {
  const segments = {};
  for (const target of entry.topTargets || []) {
    const label = safeSegments[target.segment] || '확인된 사실에 따른 우선 검토';
    segments[label] = (segments[label] || 0) + 1;
  }
  return {
    date: entry.date, revision: entry.revision, createdAt: entry.createdAt,
    goalOrders: 10, strategyVersion: entry.strategyVersion,
    metrics: metrics(entry.metrics), daily: metrics(entry.daily),
    evidenceCounts: {
      customerResponses: count(entry.evidenceCounts?.customerResponses), partnerResponses: count(entry.evidenceCounts?.partnerResponses), orders: count(entry.evidenceCounts?.orders)
    }, targetCount: count(entry.targetCount), targetSegments: segments,
    policyChangesToday: count(entry.policyChangesToday), totalPolicyChanges: count(entry.totalPolicyChanges),
    copyChangesToday: count(entry.copyChangesToday),
    actionTransitions: (entry.actionTransitions || []).map(item => ({ before: ['qualify', 'support', 'partner', 'close'].includes(item.before) ? item.before : 'unknown', after: ['qualify', 'support', 'partner', 'close'].includes(item.after) ? item.after : 'unknown' })),
    improvementReason: safeReason(entry.improvementReason), nextAction: safeReason(entry.nextAction),
    verification: 'operator_attested_not_payment_api',
    note: '직접 확인해 입력한 활동·결제 증빙 기준의 집계입니다. 개인별 원장과 운영자 메모는 공개하지 않습니다.'
  };
}

export function dailyMarkdown(entry) {
  const report = publicDaily(entry);
  const rate = value => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `# KMINGO 일별 성과 · ${report.date}`, '',
    `목표: **2026-10-31 18:00 KST까지 실제 주문 10건** · 현재 **${report.metrics.validOrders}/10건**`, '',
    '| 지표 | 당일 확인 등록 | 누적 |', '| --- | ---: | ---: |',
    `| 유효 결제 주문 | ${report.daily.validOrders} | ${report.metrics.validOrders} |`,
    `| 확인 결제액(취소·환불 제외, 원) | ${report.daily.netRevenueKRW} | ${report.metrics.netRevenueKRW} |`,
    `| 실제 전달한 제안 | ${report.daily.sent} | ${report.metrics.sent} |`,
    `| 적합 고객에게 전달한 제안 | ${report.daily.qualifiedProposals} | ${report.metrics.qualifiedProposals} |`,
    `| 구매로 연결된 적합 제안 | ${report.daily.convertedProposals} | ${report.metrics.convertedProposals} |`,
    `| 적합 제안의 구매 전환율 | ${rate(report.daily.conversionRate)} | ${rate(report.metrics.conversionRate)} |`, '',
    '## 이번 판단과 다음 행동', '',
    `- 전략 버전: ${report.strategyVersion} · 일지 수정본: ${report.revision}`,
    `- 실제 타깃·문구 가설 변경: 당일 ${report.policyChangesToday}회 / 누적 ${report.totalPolicyChanges}회. 초기 설정과 근거 없는 재실행은 제외합니다.`,
    `- 실제 피드백에 따른 개별 문구 변경: ${report.copyChangesToday}건. 행동 변화: ${report.actionTransitions.map(item => `${item.before} → ${item.after}`).join(' / ') || '없음'}. 원문과 개인 식별자는 비공개입니다.`,
    `- 개선·유지 이유: ${report.improvementReason}`,
    `- 다음 행동: ${report.nextAction}`,
    `- 누적 근거: 직접 고객 피드백 ${report.evidenceCounts.customerResponses}건, 파트너 피드백 ${report.evidenceCounts.partnerResponses}건, 유효 주문 ${report.evidenceCounts.orders}건.`,
    `- 다음 우선 대상: ${report.targetCount}개. ${Object.entries(report.targetSegments).map(([label, total]) => `${label} ${total}개`).join(' / ') || '아직 선정하지 않음'}`, '',
    '## 집계 범위', '',
    '일별 주문·금액은 결제 확인을 원장에 등록한 날짜를 기준으로 표시합니다. 목표 기간 포함 여부는 실제 결제 시각으로 판정합니다. 취소·환불은 누적 유효 주문·금액에서 제외하며 이전 일지 수정본은 개인 기록에 보존합니다.', '',
    '활동을 기록한 시점에 배송 가능이 확인되고 구매 의사가 있거나 보충이 필요한 고객에게 보낸 제안을 적합 제안으로 계산합니다. 같은 제안에서 주문이 여러 건 발생해도 전환 분자는 한 번만 셉니다.', '',
    `누적 제외 주문 ${report.metrics.excludedOrders}건(테스트 ${report.metrics.testOrders}, 취소 ${report.metrics.cancelledOrders}, 환불 ${report.metrics.refundedOrders}, 미결제 ${report.metrics.pendingOrders}, 결제 증빙 미확인 ${report.metrics.unverifiedOrders}).`, '',
    report.note, '',
    'AI 호출 성공이나 자동 발송을 뜻하는 기록이 아닙니다. 성과가 없으면 0으로 남기며, 새 근거 없는 반복 실행을 개선 실적으로 세지 않습니다.', '',
    '[실행·집계 방법](../README.md) · [7일 운영 지침](../ROUTINE.md)', ''
  ];
  return lines.join('\n');
}

export async function writePublicDaily(baseDir, entry) {
  validateDate(entry.date, new Date().toISOString());
  const base = await realpath(baseDir);
  const folder = join(base, 'daily');
  await mkdir(folder, { recursive: true });
  const realFolder = await realpath(folder);
  const part = relative(base, realFolder);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new AppError('공개 일지 경로가 저장소 밖으로 연결되어 있습니다.');
  const outputPath = join(realFolder, `${entry.date}.md`);
  const content = dailyMarkdown(entry);
  try { if (await readFile(outputPath, 'utf8') === content) return outputPath; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(dirname(outputPath), `.${entry.date}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, outputPath);
  return outputPath;
}

export function campaignView(state, now = new Date().toISOString()) {
  return { summary: campaignSummary(state, now), strategy: state.strategy ?? null, dailyReports: state.dailyJournal ?? [] };
}
