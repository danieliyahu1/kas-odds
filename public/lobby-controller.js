// Headless state machine for the find-a-player / play-a-friend lobby.
//
// It owns the lobby transitions, the polling lifecycle, and the parallel
// creation/join orchestration, and reaches the outside world only through
// injected capabilities (api, wallet connect/sign, secret and verification
// helpers, and a render callback). Nothing here touches the DOM, so the
// controller imports and runs under Node for tests. The DOM rendering lives in
// public/app.js.
import { MATCH_GAME_WAIT, MATCH_VIEW, actionErrorCopy, createPollController, matchGameWaitState, resolveMatchView, shouldRerenderMatch } from './app-controller.js';
import { normalizeRoomCode } from '../src/room-code.js';

export const LOBBY_MODE = Object.freeze({ PUBLIC: 'public', HOST: 'host', GUEST: 'guest' });

export const LOBBY_PHASE = Object.freeze({
  LIMIT: 'limit',
  HOST_FORM: 'host-form',
  GUEST_ENTRY: 'guest-entry',
  CODE_ENTRY: 'code-entry',
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
// How long a public search waits before the fallback bot is offered. A real
// opponent always gets the first chance at the seat.
const BOT_OFFER_DELAY_MS = 5_000;
// Explicit, distinct feedback for every way the bot hand-off can be refused, so
// a rejected click never looks like nothing happened.
const BOT_OFFER_FAILURE_COPY = Object.freeze({
  BOT_BUSY: { kind: 'info', title: 'The bot is busy', message: 'It is already playing a game. We will keep looking for a player.' },
  BOT_NOT_READY: { kind: 'info', title: 'Give it a moment', message: 'The bot is offered after a short wait. We will keep looking for a player.' },
  BOT_UNAVAILABLE: { kind: 'info', title: 'The bot is unavailable', message: 'No KasOdds bot is configured right now. We will keep looking for a player.' },
});
const MIN_STAKE_KAS = 1;
const MAX_STAKE_KAS = 1_000_000;
const KAS_DECIMALS = 8;

export function createLobbyController({
  mode,
  roomId = null,
  code = null,
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
  botAvailable = false,
  botStakeKas = null,
  botOfferDelayMs = BOT_OFFER_DELAY_MS,
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
  let gameCancelled = false;
  let botOffer = false;
  let waitStartedAt = null;
  // Bumped whenever this controller writes `match` itself. A poll that resolves
  // after its revision is superseded must not repaint an older snapshot.
  let matchRevision = 0;

  const poller = createPollController({ onPoll: () => refreshMatch(), intervalMs: pollIntervalMs, setIntervalFn, clearIntervalFn });

  const actions = Object.freeze({
    connectLimit, connectHost, connectGuest, connectGuestByCode, resume, selectNumber, play, offerBot, retry, retryStart, leave, stop,
  });

  function initialPhase() {
    // A guest who already has an invite (a room id from a link, or a code from
    // the home screen) goes straight to connecting the wallet; only a guest with
    // no invite is asked to type a code.
    if (mode === LOBBY_MODE.GUEST) return roomId || code ? LOBBY_PHASE.GUEST_ENTRY : LOBBY_PHASE.CODE_ENTRY;
    if (mode === LOBBY_MODE.HOST && roomId) return LOBBY_PHASE.RESUME;
    if (mode === LOBBY_MODE.HOST) return LOBBY_PHASE.HOST_FORM;
    return LOBBY_PHASE.LIMIT;
  }

  function snapshot() {
    return { mode, phase, match, number: selected, draft, busy, note, error, gameCancelled, botOffer, botStakeKas };
  }

  function emit() {
    render(snapshot(), actions);
  }

  function start() {
    phase = initialPhase();
    emit();
    // A guest who already holds an invite should not have to press a button: the
    // wallet prompt opens on arrival. A cancel or failure falls back to the
    // manual "Connect wallet" prompt, which is the only time it is shown.
    if (mode === LOBBY_MODE.GUEST && (roomId || code)) return connectGuest();
    return undefined;
  }

  function stop() {
    poller.stop();
  }

  function connectLimit(limitKas) {
    draft = String(limitKas ?? '');
    const amount = normalizeKas(limitKas);
    if (amount === null) return rejectNote('Enter a limit', 'Use a number from 1 to 1,000,000 KAS.');
    return begin((player) => api('/api/matchmaking/join', { method: 'POST', body: { address: player.address, publicKey: player.publicKey, limitKas: amount } }));
  }

  function connectHost(stakeKas) {
    draft = String(stakeKas ?? '');
    const amount = normalizeKas(stakeKas);
    if (amount === null) return rejectNote('Enter a stake', 'Use a number from 1 to 1,000,000 KAS.');
    return begin((player) => api('/api/matchmaking/room', { method: 'POST', body: { address: player.address, publicKey: player.publicKey, stakeKas: amount } }));
  }

  function joinWithCode(player, codeValue) {
    return api('/api/matchmaking/code', { method: 'POST', body: { address: player.address, publicKey: player.publicKey, code: codeValue } });
  }

  // A guest arriving from a link or the home-screen code joins with whichever
  // invite they already hold; only the standalone code box passes a fresh value.
  function connectGuest() {
    if (code) return begin((player) => joinWithCode(player, code));
    return begin((player) => api(`/api/matchmaking/${roomId}/join`, { method: 'POST', body: { address: player.address, publicKey: player.publicKey } }));
  }

  function connectGuestByCode(value) {
    draft = String(value ?? '');
    const normalized = normalizeRoomCode(value);
    if (!normalized) return rejectNote('Enter a room code', 'Room codes are six characters, like K7PQ2M.');
    return begin((player) => joinWithCode(player, normalized));
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
    if (view === MATCH_VIEW.ABANDONED) {
      poller.stop();
      // A match that carried an on-chain game and is now cancelled means that
      // game is dead, not that the opponent merely walked away.
      if (match?.gameId) gameCancelled = true;
    }
    if (view === MATCH_VIEW.FINDING) {
      if (waitStartedAt === null) waitStartedAt = now();
    } else {
      botOffer = false;
      waitStartedAt = null;
    }
    picking = view === MATCH_VIEW.PLAY;
    phase = view === MATCH_VIEW.FINDING ? LOBBY_PHASE.WAITING
      : view === MATCH_VIEW.ABANDONED ? LOBBY_PHASE.ABANDONED
        : LOBBY_PHASE.PICK;
    emit();
  }

  // The bot is offered only while a public search is still waiting, once the
  // grace period has passed. It never appears for a friend room or a matched game.
  function botOfferReady() {
    if (!botAvailable || mode !== LOBBY_MODE.PUBLIC || phase !== LOBBY_PHASE.WAITING) return false;
    if (waitStartedAt === null) return false;
    return now() - waitStartedAt >= botOfferDelayMs;
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

  // The player explicitly accepts the fallback bot. The server keeps the single
  // lease atomic, so a busy bot just leaves the player waiting for a human.
  async function offerBot() {
    if (busy || !match || !account) return undefined;
    busy = true;
    error = null;
    note = { kind: 'info', title: 'Calling the KasOdds bot', message: 'Taking the second seat.' };
    // Supersede any matchmaking poll already on the wire, so a stale waiting
    // snapshot can never repaint over the claim this POST is about to make.
    matchRevision += 1;
    emit();
    try {
      match = await api(`/api/matchmaking/${match.matchId}/bot`, { method: 'POST', body: { address: account.address } });
      busy = false;
      botOffer = false;
      waitStartedAt = null;
      transitionForMatch();
      poller.start();
      void refreshMatch();
    } catch (caught) {
      busy = false;
      logError('bot_offer_failed', { code: caught?.code, message: caught?.message });
      const botFailure = BOT_OFFER_FAILURE_COPY[caught?.code];
      if (botFailure) {
        botOffer = false;
        waitStartedAt = now();
        note = botFailure;
        return emit();
      }
      handleLobbyError(caught);
    }
    return undefined;
  }

  async function refreshMatch() {
    if (started || !match) return;
    const revision = matchRevision;
    try {
      const previous = match;
      const next = await api(`/api/matchmaking/${match.matchId}?address=${encodeURIComponent(account.address)}`);
      // A bot claim owns `match` from the moment it starts; a poll that began
      // before it must not overwrite the fresh view with an older snapshot.
      if (revision !== matchRevision) return;
      match = next;
      if (shouldRerenderMatch(previous, match, { picking })) transitionForMatch();
      const offer = botOfferReady();
      if (offer !== botOffer) { botOffer = offer; emit(); }
    } catch (caught) {
      if (revision !== matchRevision) return;
      if (caught?.code !== 'MATCH_NOT_FOUND') return;
      poller.stop();
      // A started match that disappears means its on-chain game is gone; the only
      // way that happens before a join is the creator's confirmed refund.
      if (match?.status === 'started') {
        gameCancelled = true;
        phase = LOBBY_PHASE.ABANDONED;
        return emit();
      }
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
    // A cancelled wallet prompt for an invited guest is not an error page: go
    // back to the connect prompt so a single tap retries the connection.
    if (caught?.code === 'WALLET_REJECTED' && mode === LOBBY_MODE.GUEST && (roomId || code)) {
      phase = LOBBY_PHASE.GUEST_ENTRY;
      note = { kind: 'error', title: 'Wallet connection cancelled', message: 'Tap Connect wallet to take the second seat.' };
      return emit();
    }
    // A missing or used friend invite is not retryable: the link itself is dead.
    if (caught?.code === 'MATCH_NOT_FOUND' || caught?.code === 'MATCH_FULL') {
      const full = caught.code === 'MATCH_FULL';
      return showError(
        full ? 'This invite was already used' : 'This invite has expired',
        full ? 'Someone else took the second seat.' : 'Ask your friend for a new code or link.',
        null,
      );
    }
    const copy = actionErrorCopy(caught);
    return showError(copy.title, copy.message, 'lobby');
  }

  function handleStartError(caught) {
    started = false;
    logError('match_start_failed', { code: caught?.code, message: caught?.message });
    if (caught?.code === 'MATCH_CANCELLED' || caught?.code === 'GAME_CANCELLED') {
      if (caught?.code === 'GAME_CANCELLED') gameCancelled = true;
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
    gameCancelled = false;
    botOffer = false;
    waitStartedAt = null;
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
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  if (amount < MIN_STAKE_KAS || amount > MAX_STAKE_KAS) return null;
  if (!hasSompiPrecision(raw)) return null;
  return amount;
}

// 1 KAS = 100,000,000 sompi, so more than eight decimal places has no exact
// on-chain value. Reject it rather than silently rounding the wager.
function hasSompiPrecision(raw) {
  const fraction = raw.split('.')[1] ?? '';
  return fraction.replace(/0+$/, '').length <= KAS_DECIMALS;
}
