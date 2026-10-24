'use strict';

const $ = (selector) => document.querySelector(selector);
const labels = {
  jar: {unknown:'보유 상태 미확인', full:'많이 남음', low:'거의 다 씀', none:'고추장 없음'},
  intent: {unknown:'구매 의사 미확인', yes:'구매 의사 있음', no:'구매 의사 없음'},
  kind: {support:'활용 지원', qualify:'구매 조건 확인', partner:'협업 제안', wait:'기다리기', close:'연락 종료'},
  source: {customer:'직접 고객 응답', partner:'파트너 응답', peer:'동료 피드백', public:'공개 게시물'}
};
let state = null;
let config = {aiAvailable:false};
let selectedId = null;
let currentFilter = 'priority';
let busy = false;
let currentCopy = '';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function displayDate(value) {
  if (!value) return '게시일 미표시';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function displayTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}
function announce(message, isError = false) {
  const target = $('#global-status');
  target.textContent = message;
  target.classList.toggle('error', isError);
}
async function request(path, options = {}) {
  const response = await fetch(path, {...options, headers:{'Content-Type':'application/json', ...(options.headers || {})}});
  let data;
  try { data = await response.json(); } catch { throw new Error('서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '요청을 처리하지 못했습니다.');
  return data;
}
function acceptState(result) {
  const next = result.state || result;
  if (!Array.isArray(next.leads) || !Array.isArray(next.feedback) || !Array.isArray(next.runs)) throw new Error('저장된 기록 형식을 확인해 주세요.');
  state = next;
  if (!state.leads.some(lead => lead.id === selectedId)) selectedId = state.leads.find(lead => lead.priority === 1)?.id || state.leads[0]?.id || null;
}
function setBusy(value) {
  busy = value;
  $('#run-loop-button').disabled = value || !state;
  $('#save-feedback-button').disabled = value || !selectedId;
  $('#create-lead-button').disabled = value;
  $('#add-lead-button').disabled = value || !state;
  $('#export-button').disabled = value || !state;
  $('#loop-mode').disabled = value;
  $('#feedback-form').setAttribute('aria-busy', String(value));
  $('#run-loop-button').textContent = value ? '처리하고 있어요…' : '다음 루프 실행 ↻';
}
function activeLead() { return state?.leads.find(lead => lead.id === selectedId); }
function filteredLeads() {
  const leads = [...state.leads].sort((a,b) => (a.priority || 999) - (b.priority || 999));
  if (currentFilter === 'priority') return leads.filter(lead => lead.priority && lead.priority <= 3);
  if (currentFilter === 'all') return leads;
  return leads.filter(lead => lead.type === currentFilter);
}
function renderMetrics() {
  const metrics = state.metrics || {};
  const entries = [[state.leads.length,'조사한 기회'],[metrics.customerResponses || 0,'직접 고객 응답'],[metrics.partnerResponses || 0,'파트너 응답'],[metrics.peerFeedback || 0,'동료 피드백'],[metrics.orders || 0,'확인 주문']];
  $('#metrics').replaceChildren(...entries.map(([value,label]) => {const wrap = el('div'); wrap.append(el('strong','',value),el('span','',label)); return wrap;}));
  document.querySelector('[data-filter="all"]').textContent = `전체 ${state.leads.length}`;
  const count = state.leads.filter(lead => lead.priority && lead.priority <= 3).length;
  document.querySelector('[data-filter="priority"]').textContent = `우선 ${count}`;
}
function renderLeads() {
  const list = $('#lead-list');
  const visible = filteredLeads();
  if (!visible.length) { list.replaceChildren(el('div','empty-state','이 조건에 맞는 기회가 아직 없습니다.')); return; }
  list.replaceChildren(...visible.map(lead => {
    const button = el('button', `lead-item${lead.id === selectedId ? ' selected' : ''}`);
    button.type = 'button'; button.dataset.leadId = lead.id;
    button.setAttribute('aria-pressed', String(lead.id === selectedId));
    const meta = el('div','lead-item-meta');
    meta.append(el('span','',`${lead.id} · ${lead.type === 'partner' ? '협업 후보' : '고객 질문'}`));
    if (lead.priority) meta.append(el('span','priority-badge',`PRIORITY ${lead.priority}`));
    const foot = el('div','lead-item-footer');
    foot.append(el('span','',lead.action ? (labels.kind[lead.action.kind] || '제안 준비') : '다음 행동 검토'),el('span','arrow','↗'));
    button.append(meta,el('h3','',lead.name),el('p','',lead.evidence),foot);
    button.addEventListener('click', () => { if (busy) return; selectedId = lead.id; renderLeads(); renderDetail(); resetFeedbackForm(); });
    return button;
  }));
}
function renderDetail() {
  const lead = activeLead();
  if (!lead) return;
  $('#detail-name').textContent = lead.name;
  $('#lead-type').textContent = lead.type === 'partner' ? '협업 후보' : '고객 질문';
  $('#lead-evidence').textContent = lead.evidence || '관찰한 사실이 없습니다.';
  $('#lead-date').textContent = displayDate(lead.sourceDate);
  const source = safeUrl(lead.sourceUrl);
  $('#lead-source').hidden = !source;
  if (source) $('#lead-source').href = source; else $('#lead-source').removeAttribute('href');
  $('#lead-verification').textContent = typeof lead.verification === 'string' ? lead.verification : '공개 자료의 관찰 기록입니다. 현재 구매·협업 의향은 별도 확인이 필요합니다.';
  const chips = [labels.jar[lead.jarStatus] || labels.jar.unknown,labels.intent[lead.purchaseIntent] || labels.intent.unknown,lead.country ? `지역 · ${lead.country}` : '지역 미확인'];
  $('#lead-facts').replaceChildren(...chips.map(text => el('span','fact-chip',text)));
  const action = lead.action;
  $('#action-title').textContent = action?.title || '다음 제안을 기다리고 있어요.';
  $('#action-kind').textContent = action ? (labels.kind[action.kind] || '제안') : '준비';
  $('#action-reason').textContent = action?.reason || '루프를 실행하면 확인된 사실을 바탕으로 다음 행동과 이유가 표시됩니다.';
  currentCopy = action?.copy || lead.draft || '';
  $('#action-copy').textContent = currentCopy || '작성된 문구가 아직 없습니다.';
  $('#copy-draft-button').disabled = !currentCopy;
  $('#next-question-wrap').hidden = !action?.nextQuestion;
  $('#next-question').textContent = action?.nextQuestion || '';
  const feedback = state.feedback.filter(item => item.leadId === lead.id);
  const latest = feedback.at(-1);
  $('#passport-today').textContent = `${labels.jar[lead.jarStatus] || labels.jar.unknown} · ${labels.intent[lead.purchaseIntent] || labels.intent.unknown}${lead.country ? ` · ${lead.country}` : ''}`;
  $('#passport-feedback').textContent = latest ? `${labels.source[latest.sourceKind] || '출처 미확인'}: ${latest.text}` : '아직 직접 기록한 피드백이 없습니다.';
  $('#passport-next').textContent = action ? `${action.title}${action.nextQuestion ? ` · ${action.nextQuestion}` : ''}` : '루프를 실행하면 다음 제안이 이어집니다.';
  const processed = new Set(lead.processedFeedbackIds || []);
  const pending = feedback.filter(item => !processed.has(item.id)).length;
  $('#pending-description').textContent = pending ? `선택한 기회에 새 피드백 ${pending}개가 기다립니다.` : '새로운 사실이 없으면 기존 판단을 유지합니다.';
  renderHistory();
}
function actionTitle(value) {
  if (!value) return '아직 제안 없음';
  if (typeof value === 'string') return value;
  return value.title || value.action?.title || labels.kind[value.kind] || value.stage || '이전 기록';
}
function renderHistory() {
  $('#run-count').textContent = `${state.runs.length} ROUNDS`;
  const runs = [...state.runs].reverse().slice(0,8);
  const target = $('#loop-history');
  if (!runs.length) { target.replaceChildren(el('div','empty-state','첫 루프를 실행하면 이전과 이후의 변화가 여기에 남습니다.')); return; }
  target.replaceChildren(...runs.map(run => {
    const entry = el('article','history-entry');
    const meta = el('div','history-meta');
    meta.append(el('span','',`${run.mode === 'ai' ? 'AI' : '규칙 기반'} · ${displayTime(run.createdAt)}`),el('span','',`변경 ${(run.changes || []).length} · 유지 ${run.unchangedCount || 0}`));
    entry.append(meta);
    const change = (run.changes || []).find(item => item.leadId === selectedId);
    if (change) {
      const comparison = el('div','history-comparison');
      const before = el('div'); before.append(el('small','','BEFORE'),el('p','',actionTitle(change.before)));
      const after = el('div','after'); after.append(el('small','','AFTER'),el('p','',actionTitle(change.after)));
      comparison.append(before,el('span','','→'),after); entry.append(comparison);
      if (change.reason) entry.append(el('p','history-reason',change.reason));
    } else {
      entry.append(el('p','history-unchanged','이 회차에서 선택한 기회의 판단은 바뀌지 않았습니다.'));
    }
    return entry;
  }));
}
function render() { renderMetrics(); renderLeads(); renderDetail(); }
function resetFeedbackForm() {
  const form = $('#feedback-form'); form.reset();
  const lead = activeLead();
  $('#jar-status').value = lead?.jarStatus || 'unknown';
  $('#purchase-intent').value = lead?.purchaseIntent || 'unknown';
  $('#feedback-country').value = lead?.country || '';
  $('#feedback-status').textContent = '';
  $('#stop-contact').disabled = true;
}
function renderConfig() {
  const option = $('#loop-mode option[value="ai"]');
  option.disabled = !config.aiAvailable;
  option.textContent = config.aiAvailable ? 'AI' : 'AI · 연결 필요';
  updateModeDescription();
}
function updateModeDescription() {
  $('#mode-description').textContent = $('#loop-mode').value === 'ai'
    ? `AI · 설정된 ${config.model || '모델'}로 문구를 작성합니다. 호출이 성공해야 결과가 저장됩니다.`
    : '규칙 기반 · 저장된 사실에 따라 다음 행동을 정합니다. 외부 메시지는 발송하지 않습니다.';
}

document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  currentFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => {const active = item === button; item.classList.toggle('active',active); item.setAttribute('aria-pressed',String(active));});
  renderLeads();
}));
$('#feedback-source-kind').addEventListener('change', () => {
  const directCustomer = $('#feedback-source-kind').value === 'customer';
  $('#stop-contact').disabled = !directCustomer;
  if (!directCustomer) $('#stop-contact').checked = false;
});
$('#loop-mode').addEventListener('change', updateModeDescription);
$('#feedback-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !selectedId || !event.currentTarget.reportValidity()) return;
  const text = $('#feedback-text').value.trim();
  if (!text) { $('#feedback-status').textContent = '실제로 들은 내용을 적어 주세요.'; $('#feedback-text').focus(); return; }
  const sourceUrl = $('#feedback-source-url').value.trim();
  if (sourceUrl && !safeUrl(sourceUrl)) { $('#feedback-status').textContent = 'http 또는 https 링크를 입력해 주세요.'; $('#feedback-source-url').focus(); return; }
  const body = {leadId:selectedId,text,sourceKind:$('#feedback-source-kind').value,facts:{jarStatus:$('#jar-status').value,purchaseIntent:$('#purchase-intent').value,objection:$('#feedback-objection').value,stopContact:$('#stop-contact').checked}};
  if (sourceUrl) body.sourceUrl = sourceUrl;
  if ($('#feedback-country').value.trim()) body.facts.country = $('#feedback-country').value.trim();
  setBusy(true);
  try { acceptState(await request('/api/feedback',{method:'POST',body:JSON.stringify(body)})); render(); resetFeedbackForm(); $('#feedback-status').textContent = '기록했어요. 다음 루프를 실행해 주세요.'; announce('피드백을 저장했습니다. 다음 루프를 실행하면 새 기록이 판단에 반영됩니다.'); }
  catch (error) { $('#feedback-status').textContent = error.message; announce(error.message,true); }
  finally { setBusy(false); }
});
$('#run-loop-button').addEventListener('click', async () => {
  if (busy || !state) return;
  setBusy(true); announce('기존 기록과 새 피드백을 읽고 있습니다.');
  try {
    acceptState(await request('/api/loop',{method:'POST',body:JSON.stringify({mode:$('#loop-mode').value})}));
    render();
    if (!$('#feedback-text').value.trim()) resetFeedbackForm();
    const run = state.runs.at(-1);
    announce(`루프를 마쳤습니다. ${run?.changes?.length || 0}개 기회가 변경되고 ${run?.unchangedCount || 0}개는 유지됐습니다. 외부 발송은 하지 않았습니다.`);
  } catch (error) { announce(error.message,true); }
  finally { setBusy(false); }
});
$('#copy-draft-button').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(currentCopy); $('#copy-draft-button').textContent = '복사했어요 ✓'; setTimeout(() => {$('#copy-draft-button').textContent = '복사하기 ↗';},2000); }
  catch { announce('자동 복사 권한이 없습니다. 문구를 선택해 복사해 주세요.',true); }
});
$('#export-button').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/export');
    if (!response.ok) throw new Error('기록을 내보내지 못했습니다.');
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = el('a');
    link.href = url; link.download = `kmingo-loop-${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date())}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
    announce('현재 루프 기록을 JSON 파일로 내보냈습니다.');
  } catch (error) { announce(error.message,true); }
});
$('#add-lead-button').addEventListener('click', () => {$('#add-lead-status').textContent = ''; $('#add-lead-dialog').showModal();});
$('#close-dialog-button').addEventListener('click', () => $('#add-lead-dialog').close());
$('#add-lead-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) {const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();} });
$('#add-lead-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !event.currentTarget.reportValidity()) return;
  const name = $('#new-name').value.trim(), sourceUrl = $('#new-source').value.trim(), evidence = $('#new-evidence').value.trim();
  if (!name || !evidence) {$('#add-lead-status').textContent = '이름과 관찰한 사실을 입력해 주세요.'; return;}
  if (!safeUrl(sourceUrl)) {$('#add-lead-status').textContent = 'http 또는 https 출처 링크를 입력해 주세요.'; $('#new-source').focus(); return;}
  setBusy(true);
  try {acceptState(await request('/api/leads',{method:'POST',body:JSON.stringify({name,type:$('#new-type').value,sourceUrl,evidence})})); selectedId = state.leads.at(-1).id; currentFilter = 'all'; document.querySelectorAll('[data-filter]').forEach(button => {const active = button.dataset.filter === 'all'; button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active));}); render(); resetFeedbackForm(); $('#add-lead-form').reset(); $('#add-lead-dialog').close(); announce('새 기회를 추가했습니다. 루프를 실행해 다음 행동을 검토해 주세요.');}
  catch (error) {$('#add-lead-status').textContent = error.message;}
  finally {setBusy(false);}
});

async function init() {
  setBusy(true);
  try {
    const [stateResult, configResult] = await Promise.allSettled([request('/api/state'),request('/api/config')]);
    if (stateResult.status === 'rejected') throw stateResult.reason;
    acceptState(stateResult.value);
    if (configResult.status === 'fulfilled') config = configResult.value;
    renderConfig(); render(); resetFeedbackForm();
    $('#connection-status').replaceChildren(el('i'),document.createTextNode('기록 연결됨'));
    if (configResult.status === 'rejected') announce('기록을 불러왔습니다. AI 연결 상태는 확인하지 못해 규칙 기반 모드로 시작합니다.');
  } catch (error) {
    $('#connection-status').replaceChildren(document.createTextNode('연결 확인 필요'));
    $('#lead-list').replaceChildren(el('div','empty-state','기록을 불러오지 못했습니다. 서버가 실행 중인지 확인한 뒤 새로고침해 주세요.'));
    announce(error.message,true);
  } finally {setBusy(false);}
}
init();
