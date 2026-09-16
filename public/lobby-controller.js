// Headless state machine for the find-a-player / play-a-friend lobby.
//
// It owns the lobby transitions, the polling lifecycle, and the parallel
// creation/join orchestration, and reaches the outside world only through
// injected capabilities (api, wallet connect/sign, secret and verification
// helpers, and a render callback). Nothing here touches the DOM, so the
// controller imports and runs under Node for tests. The DOM rendering lives in
// public/app.js.
import { MATCH_GAME_WAIT, MATCH_VIEW, actionErrorCopy, createPollController, matchGameWaitState, resolveMatchView, shouldRerenderMatch } from './app-controller.js';

export const LOBBY_MODE = Object.freeze({ PUBLIC: 'public', HOST: 'host', GUEST: 'guest' });

export const LOBBY_PHASE = Object.freeze({
  LIMIT: 'limit',
  HOST_FORM: 'host-form',
  GUEST_ENTRY: 'guest-entry',
  RESUME: 'resume',
  WAITING: 'waiting',
  PICK: 'pick',
  PREPARING: 'preparing',
  WALLET: 'wallet',
  ABANDONED: 'abandoned',
  ERROR: 'error',
});

const MATCH_WAIT_TIMEOUT_MS = 60_000;
const MATCH_POLL_INTERVAL_MS = 1000;
const MIN_STAKE_KAS = 1;
const MAX_STAKE_KAS = 1_000_000;

export function createLobbyController({
  mode,
  roomId = null,
  api,
  connect,
  sign,
  createSecret,
  verifyCreation,
  verifyPrepared,
  bindSecret,
  gameFeePublicKey,
  addressPrefix,
  remember = () => {},
  navigate = () => {},
  replaceUrl = () => {},
  render,
  logger = {},
  step = (name, run) => run(),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setIntervalFn,
  clearIntervalFn,
  waitTimeoutMs = MATCH_WAIT_TIMEOUT_MS,
  pollIntervalMs = MATCH_POLL_INTERVAL_MS,
}) {
  const { info = () => {}, warn = () => {}, error: logError = () => {} } = logger;

  let provider = null;
  let account = null;
  let match = null;
  let number = null;
  let selected = null;
  let draft = null;
  let phase = initialPhase();
  let note = null;
  let error = null;
  let busy = false;
  let started = false;
  let picking = false;

  const poller = createPollController({ onPoll: () => refreshMatch(), intervalMs: pollIntervalMs, setIntervalFn, clearIntervalFn });

  const actions = Object.freeze({
    connectLimit, connectHost, connectGuest, resume, selectNumber, play, retry, retryStart, leave, stop,
  });

  function initialPhase() {
    if (mode === LOBBY_MODE.GUEST) return LOBBY_PHASE.GUEST_ENTRY;
    if (mode === LOBBY_MODE.HOST && roomId) return LOBBY_PHASE.RESUME;
    if (mode === LOBBY_MODE.HOST) return LOBBY_PHASE.HOST_FORM;
    return LOBBY_PHASE.LIMIT;
  }

  function snapshot() {
    return { mode, phase, match, number: selected, draft, busy, note, error };
  }

  function emit() {
    render(snapshot(), actions);
  }

  function start() {
    phase = initialPhase();
    emit();
  }

  function stop() {
    poller.stop();
  }

  function connectLimit(limitKas) {
    draft = String(limitKas ?? '');
    const amount = normalizeKas(limitKas);
    if (amount === null) return rejectNote('Enter a limit', 'Use a whole number from 1 to 1,000,000 KAS.');
    return begin((player) => api('/api/matchmaking/join', { method: 'POST', body: { address: player.address, publicKey: player.publicKey, limitKas: amount } }));
  }

  function connectHost(stakeKas) {
    draft = String(stakeKas ?? '');
    const amount = normalizeKas(stakeKas);
    if (amount === null) return rejectNote('Enter a stake', 'Use a whole number from 1 to 1,000,000 KAS.');
    return begin((player) => api('/api/matchmaking/room', { method: 'POST', body: { address: player.address, publicKey: player.publicKey, stakeKas: amount } }));
  }

  function connectGuest() {
    return begin((player) => api(`/api/matchmaking/${roomId}/join`, { method: 'POST', body: { address: player.address, publicKey: player.publicKey } }));
  }

  function resume() {
    return begin((player) => api(`/api/matchmaking/${roomId}?address=${encodeURIComponent(player.address)}`));
  }

  async function begin(request) {
    if (busy) return undefined;
    busy = true;
    error = null;
    note = { kind: 'info', title: 'Connecting to KasWare', message: 'Confirm the connection in your wallet.' };
    emit();
    try {
      const connected = await connect();
      provider = connected.provider;
      account = connected.account;
      remember(account.address);
      match = await request(account);
      busy = false;
      enterMatch();
    } catch (caught) {
      busy = false;
      logError('lobby_failed', { code: caught?.code, message: caught?.message });
      handleLobbyError(caught);
    }
    return undefined;
  }

  function enterMatch() {
    if (mode === LOBBY_MODE.HOST && match?.matchId) replaceUrl(`/host?room=${match.matchId}`);
    transitionForMatch();
    poller.start();
    void refreshMatch();
  }

  function transitionForMatch() {
    const view = resolveMatchView(match);
    if (view === MATCH_VIEW.REOPEN) { poller.stop(); navigate(`/game?id=${match.gameId}`); return; }
    if (view === MATCH_VIEW.ABANDONED) poller.stop();
    picking = view === MATCH_VIEW.PLAY;
    phase = view === MATCH_VIEW.FINDING ? LOBBY_PHASE.WAITING
      : view === MATCH_VIEW.ABANDONED ? LOBBY_PHASE.ABANDONED
        : LOBBY_PHASE.PICK;
    emit();
  }

  function selectNumber(value) {
    selected = value;
    emit();
  }

  function play() {
    if (!picking || selected === null) return undefined;
    number = selected;
    started = true;
    poller.stop();
    // Both players press the same button; only the signed transaction differs.
    return match.role === 'creator' ? startCreation() : startJoin();
  }

  async function refreshMatch() {
    if (started || !match) return;
    try {
      const previous = match;
      match = await api(`/api/matchmaking/${match.matchId}?address=${encodeURIComponent(account.address)}`);
      if (shouldRerenderMatch(previous, match, { picking })) transitionForMatch();
    } catch (caught) {
      if (caught?.code !== 'MATCH_NOT_FOUND') return;
      poller.stop();
      handleLobbyError(caught);
    }
  }

  async function startCreation() {
    try {
      phase = LOBBY_PHASE.PREPARING;
      emit();
      const secret = await createSecret(number, { operationKey: `creation:${match.matchId}` });
      const prepared = await step('prepare_creation', () => api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side: match.side,
        stakeKas: match.stakeKas,
        matchId: match.matchId,
      } }));
      await step('verify_creation', async () => verifyCreation({ txJson: prepared.txJson, creatorPublicKey: account.publicKey, creatorCommitment: secret.commitment, side: match.side, stakeKas: match.stakeKas, deadlineDaa: prepared.deadlineDaa, gameFeePublicKey: await gameFeePublicKey(), feeSompi: prepared.feeSompi, changeScriptPublicKey: prepared.changeScriptPublicKey, addressPrefix: addressPrefix() }));
      phase = LOBBY_PHASE.WALLET;
      emit();
      const signedTxJson = await sign(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson, matchId: match.matchId } });
      await bindSecret(game.gameId, secret.secretId);
      navigate(`/game?id=${game.gameId}`);
    } catch (caught) {
      handleStartError(caught);
    }
  }

  async function startJoin() {
    try {
      phase = LOBBY_PHASE.PREPARING;
      emit();
      const gameId = match.gameId ?? await waitForMatchGameId();
      // The creation is already on the network by the time the match exposes its
      // game id, so the join is prepared and signed without waiting for a block.
      const secret = await createSecret(number, { operationKey: `join:${gameId}` });
      await bindSecret(gameId, secret.secretId);
      const prepared = await step('prepare_join', () => api(`/api/games/${gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
        matchId: match.matchId,
      } }));
      const verified = await step('verify_join', () => Promise.resolve(verifyPrepared(prepared, 'join')));
      phase = LOBBY_PHASE.WALLET;
      emit();
      const signedTxJson = await sign(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      navigate(`/game?id=${gameId}`);
    } catch (caught) {
      handleStartError(caught);
    }
  }

  // The joiner can pick immediately; the creator's game id arrives a moment
  // later. Poll for it, abort if the opponent leaves, and time out with a retry.
  async function waitForMatchGameId() {
    const startedAt = now();
    for (;;) {
      const state = matchGameWaitState(match, { elapsedMs: now() - startedAt, timeoutMs: waitTimeoutMs });
      if (state === MATCH_GAME_WAIT.READY) return match.gameId;
      if (state === MATCH_GAME_WAIT.CANCELLED) throw matchWaitError('MATCH_CANCELLED', 'Your opponent left before the game was created.');
      if (state === MATCH_GAME_WAIT.TIMEOUT) throw matchWaitError('MATCH_TIMEOUT', 'The game was not created in time.');
      await sleep(pollIntervalMs);
      try {
        match = await api(`/api/matchmaking/${match.matchId}?address=${encodeURIComponent(account.address)}`);
      } catch (caught) {
        if (caught?.code === 'MATCH_NOT_FOUND') throw matchWaitError('MATCH_CANCELLED', 'This match is no longer available.');
        warn('match_wait_failed', { code: caught?.code, message: caught?.message });
      }
    }
  }

  function handleLobbyError(caught) {
    if (caught?.code === 'KASWARE_UNAVAILABLE') {
      note = { kind: 'kasware', title: 'Install KasWare to play', message: '' };
      return emit();
    }
    // A missing or used friend invite is not retryable: the link itself is dead.
    if (caught?.code === 'MATCH_NOT_FOUND' || caught?.code === 'MATCH_FULL') {
      const full = caught.code === 'MATCH_FULL';
      return showError(
        full ? 'This invite was already used' : 'This invite has expired',
        full ? 'Someone else took the second seat.' : 'Ask your friend for a new link.',
        null,
      );
    }
    const copy = actionErrorCopy(caught);
    return showError(copy.title, copy.message, 'lobby');
  }

  function handleStartError(caught) {
    started = false;
    logError('match_start_failed', { code: caught?.code, message: caught?.message });
    if (caught?.code === 'MATCH_CANCELLED') {
      phase = LOBBY_PHASE.ABANDONED;
      return emit();
    }
    const copy = actionErrorCopy(caught);
    return showError(copy.title, copy.message, 'start');
  }

  function showError(title, message, action) {
    error = { title, message, action };
    phase = LOBBY_PHASE.ERROR;
    emit();
  }

  function rejectNote(title, message) {
    note = { kind: 'error', title, message };
    emit();
  }

  function retry() {
    note = null;
    error = null;
    draft = null;
    picking = false;
    phase = initialPhase();
    emit();
  }

  function retryStart() {
    if (!match) return retry();
    error = null;
    started = true;
    return match.role === 'creator' ? startCreation() : startJoin();
  }

  async function leave() {
    poller.stop();
    if (match && account) {
      await api(`/api/matchmaking/${match.matchId}/leave`, { method: 'POST', body: { address: account.address } }).catch(() => {});
    }
    navigate('/');
  }

  return { start, stop, snapshot, actions };
}

export function matchWaitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeKas(value) {
  const amount = Math.floor(Number(value));
  return Number.isInteger(amount) && amount >= MIN_STAKE_KAS && amount <= MAX_STAKE_KAS ? amount : null;
}
