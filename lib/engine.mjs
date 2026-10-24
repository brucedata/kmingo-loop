import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const oneOf = (value, values, label) => {
  if (!values.includes(value)) throw new AppError(`${label}: ${values.join(', ')} 중 하나여야 합니다.`);
  return value;
};
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(`${label} 형식이 올바르지 않습니다.`);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new AppError(`${label}에 허용되지 않은 필드가 있습니다.`);
}
function string(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${label}은 1–${max}자의 문자열이어야 합니다.`);
  return value.trim();
}
function url(value) {
  const text = string(value, '출처 URL', 2048);
  let parsed;
  try { parsed = new URL(text); } catch { throw new AppError('출처 URL이 올바르지 않습니다.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new AppError('출처는 사용자 정보가 없는 HTTP(S) URL이어야 합니다.');
  return parsed.href;
}
export function validateLoop(body) {
  object(body, ['mode'], '반복 실행');
  return oneOf(body.mode, ['rules', 'ai'], '실행 모드');
}
export function recordFeedback(original, body, now = new Date().toISOString()) {
  object(body, ['leadId', 'text', 'sourceKind', 'sourceUrl', 'facts'], '피드백');
  const leadId = string(body.leadId, '대상 ID', 100);
  if (!original.leads.some(lead => lead.id === leadId)) throw new AppError('해당 대상을 찾을 수 없습니다.', 404);
  const sourceKind = oneOf(body.sourceKind, ['customer', 'partner', 'peer', 'public'], '피드백 출처');
  const entry = { id: randomUUID(), leadId, text: string(body.text, '피드백'), sourceKind, sourceUrl: body.sourceUrl ? url(body.sourceUrl) : null, facts: {}, createdAt: now };
  if (body.facts !== undefined) {
    object(body.facts, ['jarStatus', 'purchaseIntent', 'country', 'objection', 'stopContact'], '확인한 사실');
    if (body.facts.jarStatus !== undefined) entry.facts.jarStatus = oneOf(body.facts.jarStatus, ['unknown', 'full', 'low', 'none'], '고추장 보유량');
    if (body.facts.purchaseIntent !== undefined) entry.facts.purchaseIntent = oneOf(body.facts.purchaseIntent, ['unknown', 'yes', 'no'], '구매 의사');
    if (body.facts.country !== undefined) entry.facts.country = string(body.facts.country, '국가', 100);
    if (body.facts.objection !== undefined) entry.facts.objection = oneOf(body.facts.objection, ['none', 'time', 'price', 'heat', 'ingredients'], '우려');
    if (body.facts.stopContact !== undefined) {
      if (typeof body.facts.stopContact !== 'boolean') throw new AppError('연락 중단 여부는 boolean이어야 합니다.');
      entry.facts.stopContact = body.facts.stopContact;
    }
  }
  const state = structuredClone(original);
  state.feedback.push(entry);
  const metric = { customer: 'customerResponses', partner: 'partnerResponses', peer: 'peerFeedback' }[sourceKind];
  if (metric) state.metrics[metric] = (state.metrics[metric] || 0) + 1;
  state.updatedAt = now;
  return state;
}

export function addLead(original, body, now = new Date().toISOString()) {
  object(body, ['name', 'type', 'sourceUrl', 'evidence', 'jarStatus', 'purchaseIntent', 'ownsGochujang'], '새 후보');
  if (body.ownsGochujang !== undefined && body.ownsGochujang !== null && typeof body.ownsGochujang !== 'boolean') throw new AppError('보유 여부는 boolean 또는 null이어야 합니다.');
  const sourceUrl = url(body.sourceUrl);
  const canonical = value => { const u = new URL(value); u.hash = ''; return u.href.replace(/\/$/, ''); };
  if (original.leads.some(lead => canonical(lead.sourceUrl) === canonical(sourceUrl))) throw new AppError('같은 출처의 후보가 이미 있습니다.', 409);
  const lead = {
    id: `L-${randomUUID().slice(0, 8)}`, name: string(body.name, '이름', 200),
    type: oneOf(body.type, ['consumer', 'partner'], '대상 유형'), sourceUrl,
    sourceDate: null, evidence: string(body.evidence, '관찰 근거'), verification: '사용자 입력 · 출처 재확인 필요',
    priority: null, jarStatus: oneOf(body.jarStatus ?? 'unknown', ['unknown', 'full', 'low', 'none'], '고추장 보유량'),
    purchaseIntent: oneOf(body.purchaseIntent ?? 'unknown', ['unknown', 'yes', 'no'], '구매 의사'),
    ownsGochujang: body.ownsGochujang ?? null, country: null, stage: 'new', action: null, draft: '', processedFeedbackIds: [], history: [], createdAt: now
  };
  const state = structuredClone(original);
  state.leads.push(lead); state.updatedAt = now;
  return state;
}

function route(lead, pending) {
  const direct = pending.filter(event => ['customer', 'partner'].includes(event.sourceKind));
  for (const event of direct) {
    for (const key of ['jarStatus', 'purchaseIntent', 'country', 'objection']) {
      if (event.facts[key] !== undefined) lead[key] = event.facts[key];
    }
    // A stop request persists. A later event cannot silently reset consent.
    if (event.facts.stopContact === true) lead.stopContact = true;
  }
  if (lead.stopContact) return { kind: 'close', title: '연락 중단 유지', reason: '직접 받은 연락 중단 요청을 보존합니다.', copy: '추가 제안이나 연락을 진행하지 않습니다.', nextQuestion: '' };
  const observation = pending.filter(event => ['peer', 'public'].includes(event.sourceKind)).at(-1);
  const objection = direct.at(-1)?.facts.objection ?? observation?.facts.objection ?? lead.objection ?? 'none';
  const baseReason = direct.length ? '직접 입력한 응답의 확인 사실을 반영했습니다.' : observation ? `${observation.sourceKind === 'peer' ? '동료 검토' : '공개 관찰'}를 제안 검토에 반영했습니다. 고객 사실은 변경하지 않았습니다.` : '출처에 기록된 초기 관찰을 바탕으로 첫 행동을 정했습니다.';
  let action;
  if (lead.type === 'partner') {
    action = { kind: 'partner', title: '다음 한 끼 카드 검토 제안', reason: baseReason, copy: lead.draft || '안녕하세요. 고추장 브랜드 KMINGO입니다. 수강생이 수업 뒤 집에서도 요리할 수 있도록 영문 다음 한 끼 카드를 함께 검토하고 싶습니다. 예시 한 장을 보내드려도 될까요? 공급·샘플 조건은 별도 협의하겠습니다.', nextQuestion: '카드를 검토할 담당자와 적합한 수업을 확인할 수 있을까요?' };
  } else if (lead.jarStatus === 'full' || lead.purchaseIntent === 'no' || (lead.ownsGochujang === true && lead.jarStatus === 'unknown' && lead.purchaseIntent !== 'yes')) {
    action = { kind: 'support', title: '현재 가진 고추장 활용 지원', reason: `${baseReason} 현재 보유 상태 또는 구매 의사를 고려해 활용 안내를 우선합니다.`, copy: !pending.length && lead.draft ? lead.draft : '지금 가진 고추장으로 다음 한 끼부터 시작해 보세요. 집에 있는 재료 세 가지와 평소 좋아하는 요리를 알려주시면 다음 메뉴를 함께 고르겠습니다.', nextQuestion: '지금 집에 있는 재료 세 가지는 무엇인가요?' };
  } else {
    action = { kind: 'qualify', title: lead.jarStatus === 'low' ? '보충 구매 조건 확인' : '제품 적합성과 구매 조건 확인', reason: `${baseReason} 지역·용도와 확인된 제품 정보를 먼저 맞춰 봅니다.`, copy: lead.draft || '저는 고추장 브랜드 KMINGO 담당자입니다. 주로 어떤 요리에 쓰시고 어느 나라에서 구매하시나요? 제품 정보와 배송 조건을 확인해 적합한 선택인지 안내하겠습니다.', nextQuestion: '어떤 요리에 사용할 예정이며 구매할 국가는 어디인가요?' };
  }
  const refinements = {
    time: ['요리 시간을 줄이는 방향으로 제안 검토', '준비에 쓸 수 있는 시간과 이미 익혀 둔 재료를 알려주세요. 검토된 메뉴 중 간단한 선택부터 함께 고르겠습니다.', '한 끼 준비에 몇 분까지 쓰실 수 있나요?'],
    price: ['가격 우려에 맞춰 조건부터 확인', '예산과 필요한 용량을 알려주시면 현재 가격·배송비를 확인해 총액으로 비교하겠습니다. 할인이나 무료 제공은 아직 약속하지 않겠습니다.', '고추장과 배송비를 합친 예산은 어느 정도인가요?'],
    heat: ['맵기 정보 확인 후 메뉴 제안', '원하는 매운맛 정도를 알려주세요. 제품의 확인된 맵기 정보와 검토된 조리법을 먼저 확인하겠습니다.', '평소 잘 드시는 매운 음식은 무엇인가요?'],
    ingredients: ['원재료 확인을 우선', '확인이 필요한 원재료나 알레르기 정보를 알려주세요. 제품 라벨을 확인한 뒤 적합 여부를 안내하겠습니다.', '특히 확인해야 할 원재료가 있나요?']
  };
  if (refinements[objection]) {
    const [title, copy, nextQuestion] = refinements[objection];
    action = { ...action, title, copy, nextQuestion, reason: `${action.reason} 확인된 우려 또는 검토 의견: ${objection}.` };
  }
  return action;
}

export async function runLoop(original, { mode = 'rules', generate, now = new Date().toISOString() } = {}) {
  oneOf(mode, ['rules', 'ai'], '실행 모드');
  const state = structuredClone(original);
  const candidates = [];
  for (const lead of state.leads) {
    lead.processedFeedbackIds ||= []; lead.history ||= [];
    const pending = state.feedback.filter(event => event.leadId === lead.id && !lead.processedFeedbackIds.includes(event.id));
    if (lead.action && pending.length === 0) continue;
    const before = structuredClone(lead.action);
    const after = route(lead, pending);
    candidates.push({ lead, pending, before, after });
  }
  const editable = candidates.filter(candidate => candidate.after.kind !== 'close');
  if (mode === 'ai' && editable.length) {
    if (!generate) throw new AppError('AI 연결이 구성되지 않았습니다. 규칙 모드로 명시적으로 실행하거나 API 설정을 확인하세요.', 503);
    const generated = await generate({ product: state.product, leads: editable.map(({ lead, pending, after }) => ({ id: lead.id, name: lead.name, type: lead.type, evidence: lead.evidence, sourceUrl: lead.sourceUrl, jarStatus: lead.jarStatus, purchaseIntent: lead.purchaseIntent, country: lead.country, pendingFeedback: pending, prescribedAction: after })) });
    if (!generated || !Array.isArray(generated.actions) || generated.actions.length !== editable.length) throw new AppError('AI가 예상한 개수의 제안을 반환하지 않았습니다. 상태를 저장하지 않았습니다.', 502);
    const seen = new Set();
    for (const result of generated.actions) {
      object(result, ['leadId', 'copy', 'nextQuestion'], 'AI 결과');
      const candidate = editable.find(item => item.lead.id === result.leadId);
      if (!candidate || seen.has(result.leadId)) throw new AppError('AI 결과의 대상 ID가 일치하지 않습니다.', 502);
      seen.add(result.leadId);
      candidate.after.copy = string(result.copy, 'AI 문구', 4000);
      candidate.after.nextQuestion = string(result.nextQuestion, 'AI 다음 질문', 500);
      candidate.after.reason += ' AI가 이 행동 범위 안에서 문구를 작성했습니다.';
    }
  }
  const run = { id: randomUUID(), createdAt: now, mode, aiCalled: mode === 'ai' && editable.length > 0, changes: [], unchangedCount: state.leads.length - candidates.length };
  for (const { lead, pending, before, after } of candidates) {
    lead.action = after; lead.stage = after.kind === 'close' ? 'closed' : 'review';
    lead.processedFeedbackIds.push(...pending.map(event => event.id));
    const change = { leadId: lead.id, before, after: structuredClone(after), reason: after.reason, feedbackIds: pending.map(event => event.id) };
    lead.history.push({ runId: run.id, createdAt: now, ...change });
    run.changes.push(change);
  }
  state.runs.push(run); state.updatedAt = now;
  return state;
}
