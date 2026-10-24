import { createServer as createHttpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError, addLead, recordFeedback, runLoop, validateLoop } from './lib/engine.mjs';
import { generateActions } from './lib/openai.mjs';
import { createStore } from './lib/store.mjs';
import { campaignSummary, recordActivity, recordOrder } from './lib/campaign.mjs';
import { campaignView, recordDaily, seoulDate, writePublicDaily } from './lib/journal.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const envPath = join(root, '.env.local');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}
function syncMetrics(state) {
  const summary = campaignSummary(state);
  state.metrics = { ...state.metrics, sent: summary.sent, orders: summary.validOrders };
  return state;
}
function validateRequest(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { throw new AppError('유효하지 않은 Host입니다.', 403); }
  if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.username || host.password || host.pathname !== '/' || Number(host.port || 80) !== req.socket.localPort) throw new AppError('로컬 Host만 허용합니다.', 403);
  if (req.headers.origin && req.headers.origin !== host.origin) throw new AppError('다른 출처의 요청은 허용하지 않습니다.', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('다른 사이트의 요청은 허용하지 않습니다.', 403);
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new AppError('Content-Type: application/json이 필요합니다.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new AppError('요청은 16KB 이하여야 합니다.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('JSON 형식이 올바르지 않습니다.'); }
}

export function createApp({ baseDir = root, store = createStore(join(baseDir, 'data', 'state.json'), join(baseDir, 'seed.json')), generate = generateActions } = {}) {
  const publicDir = resolve(baseDir, 'public');
  return createHttpServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      validateRequest(req);
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { aiAvailable: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_MODEL || 'gpt-5-mini' });
      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, await store.read());
      if (req.method === 'GET' && pathname === '/api/campaign') return json(res, 200, campaignView(await store.read()));
      if (req.method === 'GET' && pathname === '/api/export') return json(res, 200, await store.read(), { 'Content-Disposition': 'attachment; filename="kmingo-loop-state.json"' });
      if (req.method === 'POST' && ['/api/feedback', '/api/loop', '/api/leads', '/api/activity', '/api/orders', '/api/daily'].includes(pathname)) {
        const body = await readBody(req);
        if (pathname === '/api/feedback') return json(res, 200, await store.mutate(state => recordFeedback(state, body)));
        if (pathname === '/api/leads') return json(res, 201, await store.mutate(state => addLead(state, body)));
        if (pathname === '/api/activity') return json(res, 200, await store.mutate(state => syncMetrics(recordActivity(state, body))));
        if (pathname === '/api/orders') return json(res, 200, await store.mutate(state => syncMetrics(recordOrder(state, body))));
        if (pathname === '/api/daily') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['date', 'note', 'mode'].includes(key))) throw new AppError('일지 입력 필드가 올바르지 않습니다.');
          const mode = validateLoop({ mode: body.mode ?? 'rules' });
          const now = new Date().toISOString();
          let journal;
          const state = await store.mutate(async current => {
            const next = syncMetrics(await runLoop(current, { mode, generate, now }));
            journal = recordDaily(next, { date: body.date ?? seoulDate(now), note: body.note ?? '', now });
            return journal.state;
          });
          let outputPath;
          try { outputPath = await writePublicDaily(baseDir, journal.entry); }
          catch { throw new AppError('개인 일지는 저장됐지만 공개 보고서 파일 생성은 실패했습니다. 같은 일지 요청을 다시 실행하세요.', 500); }
          return json(res, 200, { ...campaignView(state), outputPath });
        }
        const mode = validateLoop(body);
        return json(res, 200, await store.mutate(async state => syncMetrics(await runLoop(state, { mode, generate }))));
      }
      if (pathname.startsWith('/api/')) throw new AppError('API 경로 또는 메서드를 찾을 수 없습니다.', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('지원하지 않는 메서드입니다.', 405);
      let relative;
      try { relative = decodeURIComponent(pathname); } catch { throw new AppError('유효하지 않은 경로입니다.'); }
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => part.startsWith('.') && part.length > 0)) throw new AppError('허용되지 않은 경로입니다.', 403);
      const file = resolve(publicDir, `.${relative === '/' ? '/index.html' : relative}`);
      if (!file.startsWith(`${publicDir}${sep}`)) throw new AppError('허용되지 않은 경로입니다.', 403);
      let info;
      try { info = await stat(file); } catch { throw new AppError('파일을 찾을 수 없습니다.', 404); }
      if (!info.isFile() || !mime[extname(file)]) throw new AppError('파일을 찾을 수 없습니다.', 404);
      res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-cache', 'Content-Length': info.size });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '서버가 요청을 완료하지 못했습니다. 저장 파일과 서버 상태를 확인하세요.' });
      else res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1–65535여야 합니다.');
  const app = createApp();
  app.on('error', error => { console.error(`서버 시작 실패: ${error.code || 'UNKNOWN'}`); process.exitCode = 1; });
  app.listen(port, '127.0.0.1', () => console.log(`KMINGO Loop: http://127.0.0.1:${port}`));
}
