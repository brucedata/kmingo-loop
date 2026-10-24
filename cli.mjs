import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError, addLead, recordFeedback, runLoop } from './lib/engine.mjs';
import { createStore } from './lib/store.mjs';
import { generateActions } from './lib/openai.mjs';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const usage = {
  commands: [
    'node cli.mjs run [--ai]',
    'node cli.mjs status',
    'node cli.mjs feedback --file <feedback.json>',
    'node cli.mjs add --file <lead.json>',
    'node cli.mjs export [--output <repo-relative.json>]'
  ],
  note: '기본 실행은 규칙 모드입니다. 외부 메시지를 보내지 않습니다. 피드백 저장 후 run을 실행하면 새 근거만 반영합니다.'
};

function parse(argv) {
  const [command = 'status', ...args] = argv;
  if (['help', '--help', '-h'].includes(command) && args.length === 0) return { command: 'help' };
  if (command === 'run' && (args.length === 0 || (args.length === 1 && args[0] === '--ai'))) return { command, mode: args.length ? 'ai' : 'rules' };
  if (command === 'status' && args.length === 0) return { command };
  if (['feedback', 'add'].includes(command) && args.length === 2 && args[0] === '--file' && args[1]) return { command, file: args[1] };
  if (command === 'export' && (args.length === 0 || (args.length === 2 && args[0] === '--output' && args[1]))) return { command, output: args[1] };
  throw new AppError('명령 또는 인자가 올바르지 않습니다. node cli.mjs --help를 확인하세요.');
}

async function readInput(file, baseDir) {
  let buffer;
  try { buffer = await readFile(resolve(baseDir, file)); }
  catch { throw new AppError('입력 파일을 읽지 못했습니다. --file 경로와 읽기 권한을 확인하세요.'); }
  if (buffer.byteLength > 16384) throw new AppError('입력 JSON은 16KB 이하여야 합니다.');
  try { return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new AppError('입력 파일은 유효한 UTF-8 JSON이어야 합니다.'); }
}

function within(base, target) {
  const part = relative(base, target);
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
async function exportFile(baseDir, requested, state) {
  const base = await realpath(baseDir);
  const output = resolve(base, requested);
  if (!within(base, output) || extname(output).toLowerCase() !== '.json') throw new AppError('내보내기 경로는 저장소 내부의 .json 파일이어야 합니다.');
  const reserved = ['seed.json', 'package.json', join('data', 'state.json')].map(path => resolve(base, path).toLowerCase());
  if (reserved.includes(output.toLowerCase())) throw new AppError('앱 원본이나 실행 상태 파일을 내보내기로 덮어쓸 수 없습니다.');
  let ancestor = dirname(output);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const realAncestor = await realpath(ancestor);
  if (realAncestor !== base && !within(base, realAncestor)) throw new AppError('내보내기 경로가 저장소 밖으로 연결되어 있습니다.');
  await mkdir(dirname(output), { recursive: true });
  const realParent = await realpath(dirname(output));
  if (realParent !== base && !within(base, realParent)) throw new AppError('내보내기 경로가 저장소 밖으로 연결되어 있습니다.');
  try { await lstat(output); throw new AppError('출력 파일이 이미 있습니다. 새 파일 이름을 사용하세요.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await writeFile(output, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch { throw new AppError('내보내기 파일을 생성하지 못했습니다. 기존 파일과 쓰기 권한을 확인하세요.'); }
  return output;
}

export async function main(argv = [], { baseDir = projectRoot, stdout = text => process.stdout.write(`${text}\n`), generate = generateActions } = {}) {
  const options = parse(argv);
  if (options.command === 'help') { stdout(JSON.stringify(usage, null, 2)); return usage; }
  baseDir = resolve(baseDir);
  const envPath = join(baseDir, '.env.local');
  if (existsSync(envPath)) {
    try { process.loadEnvFile(envPath); } catch { throw new AppError('.env.local을 읽지 못했습니다. 파일 형식과 권한을 확인하세요.'); }
  }
  const statePath = join(baseDir, 'data', 'state.json');
  const store = createStore(statePath, join(baseDir, 'seed.json'));
  let result;
  if (options.command === 'run') {
    const state = await store.mutate(current => runLoop(current, { mode: options.mode, generate }));
    const run = state.runs.at(-1);
    result = { statePath, runId: run.id, createdAt: run.createdAt, mode: run.mode, aiCalled: run.aiCalled,
      changedCount: run.changes.length, unchangedCount: run.unchangedCount,
      changes: run.changes.map(change => ({ leadId: change.leadId, before: change.before?.kind ?? null, after: change.after.kind,
        title: change.after.title, copy: change.after.copy, nextQuestion: change.after.nextQuestion, reason: change.reason, feedbackIds: change.feedbackIds })) };
  } else if (options.command === 'status') {
    const state = await store.read();
    const processed = new Set(state.leads.flatMap(lead => lead.processedFeedbackIds || []));
    result = { statePath, leadCount: state.leads.length, feedbackCount: state.feedback.length,
      pendingFeedback: state.feedback.filter(event => !processed.has(event.id)).length, runCount: state.runs.length,
      lastRun: state.runs.length ? { id: state.runs.at(-1).id, createdAt: state.runs.at(-1).createdAt, mode: state.runs.at(-1).mode } : null,
      metrics: state.metrics };
  } else if (options.command === 'feedback') {
    const body = await readInput(options.file, baseDir);
    const state = await store.mutate(current => recordFeedback(current, body));
    const event = state.feedback.at(-1);
    result = { statePath, feedbackId: event.id, leadId: event.leadId, sourceKind: event.sourceKind, pending: true, metrics: state.metrics };
  } else if (options.command === 'add') {
    const body = await readInput(options.file, baseDir);
    const state = await store.mutate(current => addLead(current, body));
    result = { statePath, leadId: state.leads.at(-1).id, leadCount: state.leads.length, pending: true };
  } else {
    const state = await store.read();
    result = options.output ? { outputPath: await exportFile(baseDir, options.output, state), leadCount: state.leads.length, runCount: state.runs.length } : state;
  }
  stdout(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const message = error instanceof AppError ? error.message : '명령 실행에 실패했습니다. seed.json·data 경로·파일 권한을 확인하세요.';
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  });
}
