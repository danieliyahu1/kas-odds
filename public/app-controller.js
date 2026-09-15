export const TERMINAL_GAME_STATUSES = new Set(['settled', 'fallback_claimed', 'refunded', 'creator_refunded']);

export function createPollController({ onPoll, intervalMs, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer;
  let generation = 0;
  let running = false;
  const tick = async (key, currentGeneration) => {
    if (running || currentGeneration !== generation) return;
    running = true;
    try { await onPoll(key, currentGeneration); } finally { running = false; }
  };
  return {
    start(key) { this.stop(); const currentGeneration = generation; void tick(key, currentGeneration); timer = setIntervalFn(() => void tick(key, currentGeneration), intervalMs); },
    stop() { generation += 1; if (timer !== undefined) clearIntervalFn(timer); timer = undefined; running = false; },
    get active() { return timer !== undefined; },
    get generation() { return generation; },
  };
}

export function createLatestRequestGate() {
  let revision = 0;
  return { next() { revision += 1; return revision; }, isCurrent(candidate) { return candidate === revision; } };
}

export function isTerminalGameStatus(status) { return TERMINAL_GAME_STATUSES.has(status); }
