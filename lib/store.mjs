import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore(statePath, seedPath) {
  let state;
  let queue = Promise.resolve();
  const ready = (async () => {
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = JSON.parse(await readFile(seedPath, 'utf8'));
      await persist(state);
    }
    if (state.version !== 1 || !Array.isArray(state.leads) || !Array.isArray(state.feedback) || !Array.isArray(state.runs) || !state.metrics) throw new Error('저장된 상태 형식이 올바르지 않습니다. data/state.json을 확인하세요.');
  })();
  async function persist(next) {
    await mkdir(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, statePath);
  }
  return {
    async read() { await ready; await queue; return structuredClone(state); },
    mutate(fn) {
      const task = queue.then(async () => {
        await ready;
        const next = await fn(structuredClone(state));
        await persist(next); state = next;
        return structuredClone(state);
      });
      queue = task.catch(() => {});
      return task;
    }
  };
}
