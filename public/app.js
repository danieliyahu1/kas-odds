// Browser client for Even/Odd.
//
// The browser is deliberately thin: it owns the hidden number and nonce
// (created and stored locally in IndexedDB), verifies the prepared creation
// against its own intent, and signs with KasWare. All Kaspa chain communication
// — fee estimation, transaction preparation, broadcast, and confirmation — is
// delegated to the app server, which only ever sees the commitment hash (not
// the number) until the reveal makes it public on-chain.
import { bindSecretToGame, createRevealSecret, deleteSecretForGame, loadSecretForGame } from '/secrets.js';
import { loadCovenantTemplate, verifyCreation, verifyPreparedTransaction } from '/verify.js';
import { logDebug, logInfo, logWarn, logError } from '/log.js';
import { signWithKasware as kaswareSignPskt } from '/kasware-signing.js';
import { connectKaswareAccount } from '/kasware-connect.js';
import { createLatestRequestGate, createPollController, isTerminalGameStatus, MATCH_GAME_WAIT, MATCH_VIEW, matchGameWaitState, resolveMatchView, shouldRerenderMatch } from '/app-controller.js';
import { loadRuntimeConfig, runtimeConfig } from '/runtime-config.js';

const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const KASWARE_DOWNLOAD = 'https://chromewebstore.google.com/detail/kasware-wallet/hklhheigdmpoolooomdihmhlpjjdbklf';
const MATCH_GAME_WAIT_TIMEOUT_MS = 60_000;
const MATCH_POLL_INTERVAL_MS = 1000;

// Client-side timing for the pre-signature pipeline. The backend prepares in a
// few hundred milliseconds; everything after that until KasWare opens is either
// our own verification or the wallet extension. These marks make the split
// visible in the console (`?debug=1`) so a slow lock can be attributed.
function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

async function timedStep(step, run) {
  const startedAt = nowMs();
  try {
    return await run();
  } finally {
    logInfo('lock_step_timing', { step, ms: Math.round(nowMs() - startedAt) });
  }
}

const gamePoller = createPollController({ onPoll: (gameId) => refreshGame(gameId), intervalMs: 3500 });
const gameRequestGate = createLatestRequestGate();

export async function boot() {
  try {
    // Warm the covenant artifact now so the first lock never waits on it.
    void loadCovenantTemplate().catch(() => {});
    cachedConfig = await loadRuntimeConfig();
    applyNetworkLabel(cachedConfig.network);
    initWalletButton();
    initFeedback();
    if (location.pathname === '/join') return renderJoinEntry(params.get('game'));
    if (location.pathname === '/game') return renderGame(params.get('id') ?? params.get('game'));
    if (location.pathname === '/host') return renderCreate();
    if (location.pathname === '/rival') return renderMatchmaking();
    renderHome();
  } catch (error) {
    logError('boot_failed', { code: error.code, message: error.message });
    renderBackendError(error.message);
  }
}

function applyNetworkLabel(network) {
  const label = document.querySelector('#network-label');
  if (label) label.textContent = network;
}

function renderHome() {
  app.innerHTML = `
    <section class="panel home-panel" aria-label="Play Even Odd">
      <div class="panel-head">
        <h1>Even / Odd</h1>
        <p class="lead">Two players. Two secret numbers. The total decides who takes the pot.</p>
      </div>
      <div class="home-actions">
        <a class="primary home-button" href="/rival">Play someone new</a>
        <a class="outline home-button" href="/host">Play with a friend</a>
      </div>
    </section>`;
}

function renderMatchmaking() {
  let provider;
  let account;
  let match;
  const matchPoller = createPollController({ onPoll: () => refreshMatch(), intervalMs: MATCH_POLL_INTERVAL_MS });
  let number = null;
  let started = false;
  let picking = false;

  // The whole panel — title included — is owned by the current state, so the
  // heading always describes the step the player is actually on.
  function paint(title, body) {
    app.innerHTML = `
      <a class="back" href="/">Back</a>
      <section class="panel" aria-label="Play someone new">
        <div class="panel-head"><h2>${escapeHtml(title)}</h2></div>
        ${body}
      </section>`;
  }

  renderSearch();

  function renderSearch() {
    picking = false;
    paint('Play someone new', `
      <p class="lead">Set the most you'll play. We match you with one player &mdash; the lower of your two limits is the stake.</p>
      <div class="stake-block">
        <div class="stake-label-row"><label for="match-limit">Play up to (KAS)</label></div>
        <input id="match-limit" type="number" min="1" max="1000000" step="1" value="1" class="stake-input" aria-label="Play up to in KAS">
        <p class="fate">You'll never play for more than this.</p>
      </div>
      <div id="match-notice"></div>
      <div class="actions"><button type="button" class="primary" id="match-start">Find a player</button></div>`);
    document.querySelector('#match-start').addEventListener('click', startMatchmaking);
  }

  async function startMatchmaking() {
    const button = document.querySelector('#match-start');
    const typed = Number(document.querySelector('#match-limit').value);
    if (!Number.isInteger(typed) || typed < 1 || typed > 1000000) {
      return showNotice('#match-notice', 'Enter a limit', 'Use a whole number from 1 to 1,000,000 KAS.', 'error');
    }
    button.disabled = true;
    try {
      ({ provider, account } = await connectKasware('#match-notice'));
      rememberAddress(account.address);
      match = await api('/api/matchmaking/join', { method: 'POST', body: { address: account.address, publicKey: account.publicKey, limitKas: Math.floor(typed) } });
      renderMatchState();
      matchPoller.start();
      await refreshMatch();
    } catch (error) {
      button.disabled = false;
      logError('matchmaking_failed', { code: error.code, message: error.message });
      if (guardKaswareShortfall('#match-notice', error)) return;
      showNotice('#match-notice', matchmakingErrorTitle(error), error.message, 'error');
    }
  }

  function renderMatchState() {
    const view = resolveMatchView(match);
    if (view === MATCH_VIEW.FINDING) return renderFinding();
    if (view === MATCH_VIEW.ABANDONED) return renderOpponentLeft();
    // A creator who already published the game returns straight to it; both
    // players otherwise share the same number-picking screen.
    if (view === MATCH_VIEW.REOPEN) { location.href = `/game?id=${match.gameId}`; return; }
    renderMatchPlay();
  }

  function renderFinding() {
    picking = false;
    paint('Looking for a player', `
      <div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Your limit: up to ${escapeHtml(match.myLimitKas)} KAS.</span></div>
      <p class="muted-note">You'll pick your number when we match.</p>
      <div class="actions"><button type="button" class="outline" id="match-leave">Cancel</button></div>`);
    document.querySelector('#match-leave').addEventListener('click', leave);
  }

  function renderOpponentLeft() {
    picking = false;
    paint('Your opponent left', `
      <div class="notice"><strong>No KAS was locked.</strong></div>
      <div class="actions"><a class="primary home-button" href="/rival">Find another player</a></div>`);
  }

  function renderMatchPreparing() {
    paint('Getting your game ready', `
      <div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">This only takes a moment.</span></div>`);
  }

  function renderMatchWallet() {
    paint('Confirm in your wallet', `
      <p class="lead">Approve <strong>${escapeHtml(lockKas(match.stakeKas))} KAS</strong>.</p>
      <p class="muted-note">Your stake stays locked until the game ends.</p>`);
  }

  function renderMatchPlay() {
    picking = true;
    paint("You're matched", `
      <p class="lead">You're <strong class="side-strong">${escapeHtml(capitalize(match.side))}</strong>. <strong>${escapeHtml(match.stakeKas)} KAS</strong> each.</p>
      <p class="fate">${winnerSummary(match.stakeKas)}</p>
      <fieldset class="choice-group">
        <legend>Your number</legend>
        <div class="choice-row">
          <button type="button" class="choice num" data-match-number="1" aria-pressed="false"><span class="num-big">1</span></button>
          <button type="button" class="choice num" data-match-number="0" aria-pressed="false"><span class="num-big">2</span></button>
        </div>
        <p class="fate">Only you know it until you reveal.</p>
      </fieldset>
      <div id="match-number-notice"></div>
      <div class="actions"><button type="button" class="primary" id="match-play" disabled>Play for ${escapeHtml(match.stakeKas)} KAS</button></div>`);
    document.querySelectorAll('[data-match-number]').forEach((button) => button.addEventListener('click', () => {
      number = Number(button.dataset.matchNumber);
      document.querySelectorAll('[data-match-number]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      document.querySelector('#match-play').disabled = false;
    }));
    document.querySelector('#match-play').addEventListener('click', () => {
      started = true;
      matchPoller.stop();
      // Both players press the same button; only the signed transaction differs.
      if (match.role === 'creator') void startCreation();
      else void startJoin();
    });
  }

  async function refreshMatch() {
    if (started) return;
    try {
      const previous = match;
      match = await api(`/api/matchmaking/${match.matchId}?address=${encodeURIComponent(account.address)}`);
      if (shouldRerenderMatch(previous, match, { picking })) renderMatchState();
    } catch (error) {
      if (error.code === 'MATCH_NOT_FOUND') matchPoller.stop();
    }
  }

  async function startCreation() {
    try {
      renderMatchPreparing();
      const secret = await createRevealSecret(number, { operationKey: `creation:${match.matchId}` });
      const prepared = await timedStep('prepare_creation', () => api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side: match.side,
        stakeKas: match.stakeKas,
        matchId: match.matchId,
      } }));
      const verified = await timedStep('verify_creation', async () => verifyCreation({ txJson: prepared.txJson, creatorPublicKey: account.publicKey, creatorCommitment: secret.commitment, side: match.side, stakeKas: match.stakeKas, deadlineDaa: prepared.deadlineDaa, gameFeePublicKey: await gameFeePublicKey(), feeSompi: prepared.feeSompi, changeScriptPublicKey: prepared.changeScriptPublicKey, addressPrefix: runtimeConfig().addressPrefix }));
      renderMatchWallet();
      const signedTxJson = await signWithKasware(provider, prepared.txJson, verified.signInputs);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson, matchId: match.matchId } });
      await bindSecretToGame(game.gameId, secret.secretId);
      location.href = `/game?id=${game.gameId}`;
    } catch (error) {
      showMatchStartError(error);
    }
  }

  async function startJoin() {
    try {
      renderMatchPreparing();
      const gameId = match.gameId ?? await waitForMatchGameId();
      // The creation is already on the network by the time the match exposes its
      // game id, so the join is prepared and signed without waiting for a block.
      const secret = await createRevealSecret(number, { operationKey: `join:${gameId}` });
      await bindSecretToGame(gameId, secret.secretId);
      const prepared = await timedStep('prepare_join', () => api(`/api/games/${gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
        matchId: match.matchId,
      } }));
      const verified = await timedStep('verify_join', () => Promise.resolve(verifyPreparedTransaction(prepared, 'join')));
      renderMatchWallet();
      const signedTxJson = await signWithKasware(provider, prepared.txJson, verified.signInputs);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      location.href = `/game?id=${gameId}`;
    } catch (error) {
      showMatchStartError(error);
    }
  }

  // The joiner can pick immediately; the creator's game id arrives a moment
  // later. Poll for it, abort if the opponent leaves, and time out with a retry.
  async function waitForMatchGameId() {
    const startedAt = Date.now();
    while (true) {
      const state = matchGameWaitState(match, { elapsedMs: Date.now() - startedAt, timeoutMs: MATCH_GAME_WAIT_TIMEOUT_MS });
      if (state === MATCH_GAME_WAIT.READY) return match.gameId;
      if (state === MATCH_GAME_WAIT.CANCELLED) throw matchWaitError('MATCH_CANCELLED', 'Your opponent left before the game was created.');
      if (state === MATCH_GAME_WAIT.TIMEOUT) throw matchWaitError('MATCH_TIMEOUT', 'The game was not created in time.');
      await new Promise((resolve) => setTimeout(resolve, MATCH_POLL_INTERVAL_MS));
      try {
        match = await api(`/api/matchmaking/${match.matchId}?address=${encodeURIComponent(account.address)}`);
      } catch (error) {
        if (error.code === 'MATCH_NOT_FOUND') throw matchWaitError('MATCH_CANCELLED', 'This match is no longer available.');
        logWarn('match_wait_failed', { code: error.code, message: error.message });
      }
    }
  }

  function showMatchStartError(error) {
    started = false;
    logError('match_start_failed', { code: error.code, message: error.message });
    if (error.code === 'MATCH_CANCELLED') return renderOpponentLeft();
    const copy = actionErrorCopy(error);
    paint(copy.title, `
      <div class="notice error"><strong>${escapeHtml(copy.message)}</strong></div>
      <div class="actions"><button type="button" class="primary" id="match-retry">Try again</button></div>`);
    document.querySelector('#match-retry').addEventListener('click', () => {
      started = true;
      if (match.role === 'creator') void startCreation();
      else void startJoin();
    });
  }

  async function leave() {
    matchPoller.stop();
    await api(`/api/matchmaking/${match.matchId}/leave`, { method: 'POST', body: { address: account.address } }).catch(() => {});
    location.href = '/';
  }
}

function renderCreate() {
  let side = 'even';
  let number = null;
  let stake = 1;
  let stage = 'form';

  // The panel title follows the current step, so it never stays on an earlier
  // question while the player is locking funds.
  function paint(title, body) {
    app.innerHTML = `
      <section class="panel" aria-label="Play with a friend">
        <div class="panel-head"><h2>${escapeHtml(title)}</h2></div>
        ${body}
      </section>`;
  }

  function renderForm() {
    stage = 'form';
    paint('Play with a friend', `
      <p class="lead">You each pick a number. Add them up &mdash; even or odd decides the winner.</p>
      <form class="form" id="create-form">
        <fieldset class="choice-group">
          <legend>Which side do you back?</legend>
          <div class="choice-row">
            <button type="button" class="choice${side === 'even' ? ' selected' : ''}" data-side="even" aria-pressed="${side === 'even'}">Even</button>
            <button type="button" class="choice${side === 'odd' ? ' selected' : ''}" data-side="odd" aria-pressed="${side === 'odd'}">Odd</button>
          </div>
          <p class="fate">Even wins if the total is even.</p>
        </fieldset>
        <fieldset class="choice-group">
          <legend>Your number</legend>
          <div class="choice-row">
            <button type="button" class="choice num${number === 1 ? ' selected' : ''}" data-commit-number="1" aria-pressed="${number === 1}"><span class="num-big">1</span></button>
            <button type="button" class="choice num${number === 0 ? ' selected' : ''}" data-commit-number="0" aria-pressed="${number === 0}"><span class="num-big">2</span></button>
          </div>
          <p class="fate">Only you know it until you reveal.</p>
        </fieldset>
        <div class="stake-block">
          <div class="stake-label-row"><label for="stake">Stake (KAS)</label></div>
          <input id="stake" type="number" min="1" max="1000000" step="1" value="${stake}" class="stake-input" aria-label="Stake in KAS">
          <p class="fate">Winner takes the <span id="stake-fate">${stake * 2} KAS</span> pot.</p>
        </div>
        <div id="create-notice"></div>
        <p class="muted-note">Your number is saved only in this browser. Clearing site data before you reveal forfeits your stake.</p>
        <div class="actions"><button type="submit" class="primary" id="create-submit">Play for ${stake} KAS</button></div>
      </form>`);

    document.querySelectorAll('[data-side]').forEach((button) => {
      button.addEventListener('click', () => {
        side = button.dataset.side;
        document.querySelectorAll('[data-side]').forEach((item) => {
          const selected = item === button;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
      });
    });
    document.querySelectorAll('[data-commit-number]').forEach((button) => {
      button.addEventListener('click', () => {
        number = Number(button.dataset.commitNumber);
        document.querySelectorAll('[data-commit-number]').forEach((item) => {
          const selected = item === button;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
      });
    });

    const stakeInput = document.querySelector('#stake');
    const stakeFate = document.querySelector('#stake-fate');
    const submit = document.querySelector('#create-submit');
    stakeInput.addEventListener('input', () => {
      const shown = Math.min(1000000, Math.max(1, Math.floor(Number(stakeInput.value) || 1)));
      submit.textContent = `Play for ${shown} KAS`;
      stakeFate.textContent = `${shown * 2} KAS`;
    });

    document.querySelector('#create-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const typed = Number(stakeInput.value);
      if (!Number.isInteger(typed) || typed < 1 || typed > 1000000) {
        return showNotice('#create-notice', 'Enter a stake', 'Use a whole number from 1 to 1,000,000 KAS.', 'error');
      }
      if (number === null) return showNotice('#create-notice', 'Pick a number', 'Choose 1 or 2 before you play.', 'error');
      stake = Math.floor(typed);
      submit.disabled = true;
      void runPlay();
    });
  }

  function renderWallet() {
    stage = 'wallet';
    paint('Confirm in your wallet', `
      <p class="lead">Approve <strong>${escapeHtml(lockKas(stake))} KAS</strong>.</p>
      <p class="muted-note">Your stake stays locked until the game ends.</p>`);
  }

  function renderCreateError(error) {
    stage = 'error';
    const copy = actionErrorCopy(error);
    paint(copy.title, `
      <div class="notice error"><strong>${escapeHtml(copy.message)}</strong></div>
      <div id="create-notice"></div>
      <div class="actions"><button type="button" class="primary" id="create-retry">Try again</button></div>`);
    document.querySelector('#create-retry').addEventListener('click', () => void runPlay());
  }

  async function runPlay() {
    try {
      const { provider, account } = await connectKasware('#create-notice');
      rememberAddress(account.address);
      const secret = await createRevealSecret(number, { operationKey: `creation:${account.address}:${side}:${stake}` });
      const prepared = await timedStep('prepare_creation', () => api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side,
        stakeKas: stake,
      } }));
      const verified = await timedStep('verify_creation', async () => verifyCreation({ txJson: prepared.txJson, creatorPublicKey: account.publicKey, creatorCommitment: secret.commitment, side, stakeKas: stake, deadlineDaa: prepared.deadlineDaa, gameFeePublicKey: await gameFeePublicKey(), feeSompi: prepared.feeSompi, changeScriptPublicKey: prepared.changeScriptPublicKey, addressPrefix: runtimeConfig().addressPrefix }));
      renderWallet();
      const signedTxJson = await signWithKasware(provider, prepared.txJson, verified.signInputs);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await bindSecretToGame(game.gameId, secret.secretId);
      location.href = `/game?id=${game.gameId}`;
    } catch (error) {
      logError('create_game_failed', { code: error.code, message: error.message });
      if (stage !== 'form') return renderCreateError(error);
      const submit = document.querySelector('#create-submit');
      if (submit) submit.disabled = false;
      if (error.code === 'KASWARE_UNAVAILABLE') { renderKaswareShortfall('#create-notice'); return; }
      showNotice('#create-notice', 'Game was not created', error.message, 'error');
    }
  }

  renderForm();
}

async function renderJoinEntry(gameId) {
  if (!isGameId(gameId)) return renderBackendError('That game link doesn\u2019t look right.');
  return renderGame(gameId);
}

async function renderGame(gameId) {
  if (!isGameId(gameId)) return renderBackendError('That game link doesn\u2019t look right.');
  scheduleGameRefresh(gameId);
  try {
    await refreshGame(gameId, { reportErrors: true });
  } catch (error) {
    renderBackendError(error.message);
  }
}

function paintGameHeader(status, role, game, revealMine) {
  if (status === 'settled') {
    if (role === 'creator' || role === 'joiner') return { title: winnerIsYou(game, role) ? 'You won.' : 'You lost.', loading: false };
    return { title: `${capitalize(winnerSideName(game))} took the pot.`, loading: false };
  }
  if (role === 'creator' && game.status === 'waiting_for_player_b') return { title: 'Your game is ready.', loading: false };
  if (game.status === 'joined' || game.status === 'first_revealed' || game.status === 'reveal_broadcast' || game.status === 'settlement_broadcast') {
    return { title: revealMine ? 'Your turn to reveal.' : `Waiting for your ${game.matchmaking ? 'opponent' : 'friend'}.`, loading: false };
  }
  if (game.canJoin) return { title: 'Join the game.', loading: false };
  return { title: 'Getting your game ready.', loading: true };
}

async function paintGame(gameId, game) {
  const role = detectRole(game);
  const yourSide = role === 'creator' ? game.creator?.side : role === 'joiner' ? (game.creator?.side === 'even' ? 'odd' : 'even') : null;
  const joinerView = role === 'joiner' || (role === 'viewer' && game.canJoin);
  const active = !['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status);
  void forgetRevealSecret(gameId, !active);
  const myPendingReveal = (game.pendingReveals ?? []).find((item) => item.role === role) ?? null;
  const myPendingSafety = (game.pendingSafety ?? []).find((item) => item.role === role) ?? null;
  const revealMine = (game.canReveal || Boolean(myPendingReveal)) && (role === 'creator' || role === 'joiner') && !isMyReveal(game, role);
  const header = paintGameHeader(game.status, role, game, revealMine);
  const waiting = active && !joinerView && !revealMine;

  app.innerHTML = `
    <a class="back" href="/" data-action="exit">Exit</a>
    <section class="panel" aria-label="Game">
      <div class="panel-head">
        ${header.loading ? `<div class="header-loading"><span class="spinner large confirm" aria-hidden="true"></span><h2>${escapeHtml(header.title)}</h2></div>` : `<h2>${escapeHtml(header.title)}</h2>`}
      </div>
      <div class="game-body">
        ${gameDetails(game)}
        ${active ? (joinerView ? joinSection(game, yourSide ?? (game.creator?.side === 'even' ? 'odd' : 'even')) : '') + inviteBox(game, waiting) + (revealMine ? revealSection(game, myPendingReveal) : '') : ''}
        ${resultOverlay(game, role)}
        ${safetySection(game, myPendingSafety)}
        ${terminalSection(game)}
      </div>
    </section>`;

  await bindJoin(gameId, game);
  bindReveal(gameId);
  bindShare();
  bindSafety(gameId, game, myPendingSafety);
  bindExit(gameId, game, role, myPendingSafety);
  bindRecoveryCountdown(recoveryFromGame(game), () => refreshGame(gameId));
  bindPlayAgain();
  if (!active || isTerminalGameStatus(game.status)) stopGameRefresh();
}

function recoveryFromGame(game) {
  if (!game.safetyAction && !game.automaticAction) return null;
  return { ready: game.automaticAction ? game.automaticReady : game.safetyReady, remainingSeconds: game.automaticAction ? game.automaticRemainingSeconds : game.safetyRemainingSeconds };
}

function inviteBox(game, waiting) {
  if (['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status)) return '';
  const waitingRow = waiting
    ? `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for your ${game.matchmaking ? 'opponent' : 'friend'}</span></div>`
    : '';
  if (game.matchmaking) return `<div class="invite-box" id="invite-box">${waitingRow}</div>`;
  return `
    <div class="invite-box" id="invite-box">
      ${waitingRow}
      <button class="share-button" data-action="copy-link">Copy link</button>
    </div>`;
}

function gameDetails(game) {
  const amount = game.stakeKas;
  const pot = game.stakeKas * 2;
  return `
    <div class="summary">
      <div class="sum-item"><small>Stake</small><strong>${escapeHtml(amount)} KAS</strong></div>
      <div class="sum-item"><small>Pot</small><strong>${escapeHtml(pot)} KAS</strong></div>
    </div>`;
}

function joinSection(game, yourSide) {
  if (!game.canJoin) return '';
  const theirStake = game.stakeKas;
  return `
    <div class="hero-card" id="join-card">
      <p class="lead">You're <strong class="side-strong">${capitalize(yourSide)}</strong>.</p>
      <form class="form" id="join-form">
        <fieldset class="choice-group">
          <legend>Your number</legend>
          <div class="choice-row">
            <button type="button" class="choice num" data-join-number="1" aria-pressed="false"><span class="num-big">1</span></button>
            <button type="button" class="choice num" data-join-number="0" aria-pressed="false"><span class="num-big">2</span></button>
          </div>
          <p class="fate">Only you know it until you reveal.</p>
        </fieldset>
        <p class="fate">Each player stakes ${escapeHtml(theirStake)} KAS. ${winnerSummary(theirStake)}</p>
        <div id="join-notice"></div>
        <p class="muted-note">Your number is saved only in this browser. Clearing site data before you reveal forfeits your stake.</p>
        <div class="actions">
          <button type="submit" class="primary" id="join-submit" disabled>Join for ${escapeHtml(theirStake)} KAS</button>
        </div>
      </form>
    </div>`;
}

async function bindJoin(gameId, game) {
  const form = document.querySelector('#join-form');
  if (!form) return;
  const theirStake = game.stakeKas;
  const submit = form.querySelector('button[type="submit"]');
  let number = null;
  document.querySelectorAll('[data-join-number]').forEach((button) => {
    button.addEventListener('click', () => {
      number = Number(button.dataset.joinNumber);
      document.querySelectorAll('[data-join-number]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      submit.disabled = false;
    });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (number === null) return showNotice('#join-notice', 'Pick a number', 'Choose 1 or 2 before you join.', 'error');
    submit.disabled = true;
    try {
      const { provider, account } = await connectKasware('#join-notice');
      rememberAddress(account.address);
      const secret = await createRevealSecret(number, { operationKey: `join:${gameId}` });
      await bindSecretToGame(gameId, secret.secretId);
      const prepared = await api(`/api/games/${gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
      } });
      const verified = verifyPreparedTransaction(prepared, 'join');
      showNotice('#join-notice', 'Confirm in KasWare', `Lock ${lockKas(theirStake)} KAS. Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson, verified.signInputs);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      submit.disabled = false;
      logError('join_game_failed', { code: error.code, message: error.message });
      if (guardKaswareShortfall('#join-notice', error)) return;
      showNotice('#join-notice', error.message, '', 'error');
    }
  });
}

function revealSection(game, pending) {
  const waiting = pending && !pending.retryable;
  const control = waiting
    ? '<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for confirmation</span></div>'
    : `<div class="actions"><button type="button" class="primary" data-action="reveal">${pending ? 'Try again' : 'Reveal number'}</button></div>`;
  return `
    <div id="game-action" class="reveal-block">
      <p class="lead">Reveal your number</p>
      <div id="reveal-notice"></div>
      ${control}
    </div>`;
}

function isMyReveal(game, role) {
  if (role !== 'creator' && role !== 'joiner') return false;
  return game.revealedPicks?.[role] !== undefined;
}

// Once the game is over the reveal nonce is public on-chain, so drop the local
// copy rather than keep a stale secret in IndexedDB indefinitely.
async function forgetRevealSecret(gameId, terminal) {
  if (!terminal) return;
  try {
    await deleteSecretForGame(gameId);
    logInfo('reveal_secret_forgotten', { gameId });
  } catch (error) {
    logWarn('reveal_secret_forget_failed', { gameId, message: error?.message });
  }
}

function bindReveal(gameId) {
  const reveal = document.querySelector('[data-action="reveal"]');
  if (!reveal) return;
  reveal.addEventListener('click', async () => {
    reveal.disabled = true;
    try {
      const { provider, account } = await connectKasware('#reveal-notice');
      rememberAddress(account.address);
      const secret = await loadSecretForGame(gameId);
      if (!secret) {
        showNotice('#reveal-notice', 'Reveal unavailable', 'This browser does not have your unrevealed number for this game. Play the game in the browser you used to start it, and keep this site\'s data.', 'error');
        reveal.disabled = false;
        return;
      }
      const prepared = await timedStep('prepare_reveal', () => api(`/api/games/${gameId}/reveal/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
        choice: secret.choice,
        nonceHex: secret.nonceHex,
      } }));
      const verified = await timedStep('verify_reveal', () => Promise.resolve(verifyPreparedTransaction(prepared, 'reveal')));
      showNotice('#reveal-notice', 'Confirm in KasWare', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson, verified.signInputs);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/reveal/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      reveal.disabled = false;
      logError('reveal_failed', { code: error.code, message: error.message });
      if (error.code === 'KASWARE_UNAVAILABLE') {
        renderKaswareShortfall('#reveal-notice');
      } else if (error.code === 'INVALID_REVEAL') {
        showNotice('#reveal-notice', 'Reveal did not match', 'The saved number no longer matches the locked commitment. You may have started this game in another browser.', 'error');
      } else {
        showActionError('#reveal-notice', error);
      }
    }
  });
}

function bindShare() {
  const url = location.href;
  const copy = document.querySelector('[data-action="copy-link"]');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await copyLink(url);
        flashCopy(copy);
      } catch { /* ignore */ }
    });
  }
}

async function copyLink(url) {
  await navigator.clipboard.writeText(url);
}

function flashCopy(button) {
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1600);
}

function automaticNoticeHtml(game) {
  if (!game.automaticAction || !['waiting_for_player_b', 'refund_open_broadcast', 'joined', 'first_revealed'].includes(game.status)) return '';
  const label = game.automaticAction === 'fallback_claim' ? 'Automatic fallback claim' : 'Automatic refund';
  const remaining = game.automaticRemainingSeconds == null ? 'checking the timeout' : game.automaticReady ? 'ready; the backend will relay it' : `in about ${game.automaticRemainingSeconds}s`;
  return `<p class="lead">${label}</p><p class="muted-note">${escapeHtml(remaining)}. No wallet signature is required.</p>`;
}

function safetySection(game, pending) {
  const autoNote = automaticNoticeHtml(game);
  if (autoNote) return `<div id="game-safety" class="safety">${autoNote}</div>`;
  // An unmatched game is cancelled through the Exit link, so it never shows the
  // generic recovery control.
  if (game.status === 'waiting_for_player_b') return '';
  if (pending) {
    const pendingControl = pending.retryable
      ? `<div class="actions"><button type="button" class="outline" data-action="safety" data-safety-action="${escapeHtml(pending.action)}">Try again</button></div>`
      : '<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for confirmation</span></div>';
    return `<div id="game-safety" class="safety">${pendingControl}</div>`;
  }
  const control = (label) => recoveryControlHtml(recoveryFromGame(game), label, 'safety');
  if (game.safetyAction === 'fallback_claim' && game.status === 'first_revealed') {
    if (connectedAddress() !== game.firstRevealer) return '';
    return `
      <div id="game-safety" class="safety">
        <p class="lead">If your ${game.matchmaking ? 'opponent' : 'friend'} never reveals</p>
        <p class="muted-note">You can claim the pot after the wait. ${feeSummary(game.stakeKas)}</p>
        ${control('Claim pot')}
      </div>`;
  }
  return '';
}

function terminalSection(game) {
  if (game.status === 'fallback_claimed') return `<div class="notice"><strong>Pot claimed.</strong>Your ${game.matchmaking ? 'opponent' : 'friend'} never revealed, so you took the pot.</div>`;
  if (game.status === 'refunded' || game.status === 'creator_refunded') return '<div class="notice"><strong>Canceled.</strong>Your stake was returned.</div>';
  if (game.status === 'refund_partial') return '<div class="notice"><strong>Partial refund.</strong>One stake was returned. The other player can still refund theirs.</div>';
  return '';
}

async function runSafetyAction(gameId, action) {
  const { provider, account } = await connectKasware('#game-safety');
  const prepared = await api(`/api/games/${gameId}/${action}/prepare`, { method: 'POST', body: {
    playerAddress: account.address,
    playerPublicKey: account.publicKey,
  } });
  const verified = verifyPreparedTransaction(prepared, 'refund');
  showNotice('#game-safety', 'Confirm in KasWare', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
  const signedTxJson = await signWithKasware(provider, prepared.txJson, verified.signInputs);
  if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
  await api(`/api/games/${gameId}/${action}/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
}

function renderSafetyFailure(error) {
  if (guardKaswareShortfall('#game-safety', error)) return;
  showActionError('#game-safety', error);
}

function bindSafety(gameId, game, pending) {
  const safetyButton = document.querySelector('[data-action="safety"]');
  if (!safetyButton || safetyButton.disabled) return;
  const safetyAction = pending?.action ?? game.safetyAction;
  safetyButton.addEventListener('click', async () => {
    safetyButton.disabled = true;
    try {
      await runSafetyAction(gameId, safetyAction);
      await refreshGame(gameId);
    } catch (error) {
      safetyButton.disabled = false;
      logError('safety_action_failed', { code: error.code, message: error.message });
      renderSafetyFailure(error);
    }
  });
}

function bindExit(gameId, game, role, pending) {
  const exit = document.querySelector('[data-action="exit"]');
  if (!exit) return;
  const cancelInFlight = pending?.action === 'creator_refund' && !pending.retryable;
  const cancelsOpenGame = game.status === 'waiting_for_player_b' && game.canCancel && role === 'creator';
  if (!cancelsOpenGame || cancelInFlight) return;
  exit.addEventListener('click', async (event) => {
    event.preventDefault();
    exit.classList.add('disabled');
    try {
      await runSafetyAction(gameId, 'creator_refund');
      stopGameRefresh();
      location.href = '/';
    } catch (error) {
      exit.classList.remove('disabled');
      logError('cancel_game_failed', { code: error.code, message: error.message });
      renderSafetyFailure(error);
    }
  });
}

function showActionError(selector, error) {
  const copy = actionErrorCopy(error);
  showNotice(selector, copy.title, copy.message, 'error');
}

function matchmakingErrorTitle(error) {
  const code = error?.code ?? '';
  return code.startsWith('WALLET_') || code === 'KASWARE_UNAVAILABLE' ? 'Wallet not ready' : 'Could not find a player';
}

function actionErrorCopy(error) {
  const copy = {
    STORAGE_MASS_EXCEEDED: ['Transaction not ready', 'Your wallet needs a smaller available coin. Receive a small separate payment, then try again. Your game funds remain safe.'],
    NO_UTXOS: ['Network fee unavailable', 'This wallet needs a small separate balance to pay the network fee.'],
    NO_ORDINARY_UTXOS: ['Network fee unavailable', 'This wallet needs a small separate balance to pay the network fee.'],
    INSUFFICIENT_UTXOS: ['Not enough KAS for the network fee', 'Add a small amount of KAS to this wallet, then try again.'],
    FEE_REPRICING_FAILED: ['Network fee changed', 'The network fee changed while preparing this action. Please try again.'],
    TRANSACTION_REJECTED: ['Transaction not accepted', 'The network did not accept this action. Wait a few seconds, then try again. Your game funds remain safe.'],
    MATCH_TIMEOUT: ['Still waiting for your opponent', 'They did not create the game in time. Try again in a moment.'],
    CREATION_PENDING: ['Almost there', "Your opponent's game is still reaching the network. Try again in a moment."],
    CREATION_FAILED: ['The game did not start', "Your opponent's game did not reach the network. No KAS was locked."],
    GAME_EXPIRED: ['This game expired', 'The joining window closed. No KAS was locked.'],
  }[error.code] ?? ['Please try again', 'Something went wrong. Please try again in a few seconds. Your game funds remain safe.'];
  return { title: copy[0], message: copy[1] };
}

function matchWaitError(code, message) { const error = new Error(message); error.code = code; return error; }

function winnerIsYou(game, role) {
  if (role !== 'creator' && role !== 'joiner') return false;
  return game.winner === role;
}

function resultOverlay(game, role) {
  if (game.status !== 'settled') return '';
  const won = winnerIsYou(game, role);
  const creatorPick = displayPick(game.revealedPicks?.creator);
  const joinerPick = displayPick(game.revealedPicks?.joiner);
  const resultTitle = role === 'creator' || role === 'joiner'
    ? `${won ? 'You won ' : 'You lost '}<strong>${escapeHtml(game.stakeKas * 2)} KAS</strong>.`
    : `<strong>${capitalize(winnerSideName(game))}</strong> took the pot.`;
  return `
    <div class="result ${won ? 'winner' : 'loser'}">
      <p class="result-title">${resultTitle}</p>
      <div class="result-side">
        <span class="result-side-name">Creator &middot; ${capitalize(game.creator?.side)}</span>
        <span class="result-pick">${creatorPick}</span>
      </div>
      <div class="result-side">
        <span class="result-side-name">Joiner &middot; ${capitalize(game.creator?.side === 'even' ? 'odd' : 'even')}</span>
        <span class="result-pick">${joinerPick}</span>
      </div>
      ${role === 'creator' || role === 'joiner' ? '<button type="button" class="primary" data-action="play-again">Play again</button>' : ''}
    </div>`;
}

function displayPick(choice) {
  if (choice === undefined) return '\u00b7';
  return choice === 1 ? 1 : 2;
}

function winnerSideName(game) {
  return game.winner === 'creator' ? (game.creator?.side === 'even' ? 'Even' : 'Odd') : (game.creator?.side === 'even' ? 'Odd' : 'Even');
}

function bindPlayAgain() {
  const again = document.querySelector('[data-action="play-again"]');
  if (again) again.addEventListener('click', () => { location.href = '/'; });
}

function detectRole(game) {
  const address = connectedAddress();
  if (address && game.creator?.address === address) return 'creator';
  if (address && game.joiner?.address === address) return 'joiner';
  return 'viewer';
}

// Tri-state readiness: `true` = available, `false` + countdown = wait, `null` =
// unknown (chain unreachable; keep the button disabled with a note until the
// next refresh can confirm readiness).
function recoveryControlState(recovery) {
  if (!recovery || recovery.ready === true) return { disabled: false, wait: null, unknown: false };
  if (recovery.ready === false && recovery.remainingSeconds != null) {
    return { disabled: true, wait: Number(recovery.remainingSeconds), unknown: false };
  }
  return { disabled: true, wait: null, unknown: true };
}

function recoveryControlHtml(recovery, label, action) {
  const state = recoveryControlState(recovery);
  const note = state.wait != null
    ? `<p class="muted-note" data-recovery-wait data-remaining="${state.wait}">Available in ${formatWait(state.wait)}</p>`
    : state.unknown
      ? '<p class="muted-note">Can\'t reach the chain right now; the covenant still enforces the wait.</p>'
      : '';
  return `<div class="actions"><button type="button" class="outline" data-action="${action}" data-recovery-button ${state.disabled ? 'disabled' : ''}>${label}</button></div>${note}`;
}

function bindRecoveryCountdown(recovery, refresh) {
  clearInterval(window.__recoveryTicker);
  const element = document.querySelector('[data-recovery-wait]');
  const button = document.querySelector('[data-recovery-button]');
  if (!element || !button || !recovery || recovery.ready) return;
  let remaining = Number(element.dataset.remaining ?? '0');
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  window.__recoveryTicker = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(window.__recoveryTicker);
      element.textContent = 'Available now';
      void refresh();
      return;
    }
    element.textContent = `Available in ${formatWait(remaining)}`;
  }, 1000);
}

function formatWait(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function signWithKasware(provider, txJson) {
  logInfo('kasware_sign_request');
  const startedAt = nowMs();
  return Promise.resolve(kaswareSignPskt(provider, txJson))
    .then((signed) => {
      logInfo('kasware_sign_result', { returned: typeof signed === 'string' && signed.length > 0, ms: Math.round(nowMs() - startedAt) });
      return signed;
    })
    .catch((error) => {
      logError('kasware_sign_failed', { code: error?.code, message: error?.message });
      throw error;
    });
}

function rememberAddress(address) {
  if (!address) return;
  window.__connectedAddress = address;
  try { localStorage.setItem('kaspa-connected-address', address); } catch { /* ignore */ }
}

function connectedAddress() {
  if (window.__connectedAddress) return window.__connectedAddress;
  try { return localStorage.getItem('kaspa-connected-address'); } catch { return null; }
}

function initWalletButton() {
  const button = document.querySelector('#wallet-button');
  if (!button) return;
  button.addEventListener('click', onWalletClick);
  renderWalletButton();
}

function renderWalletButton() {
  const button = document.querySelector('#wallet-button');
  if (!button) return;
  const address = connectedAddress();
  if (address) {
    button.classList.add('connected');
    button.setAttribute('aria-label', `Connected ${address}. Click to disconnect.`);
    button.innerHTML = `<span class="wallet-dot" aria-hidden="true"></span>${escapeHtml(shortAddress(address))}`;
  } else {
    button.classList.remove('connected');
    button.removeAttribute('aria-label');
    button.textContent = 'Connect Wallet';
  }
}

async function onWalletClick() {
  if (connectedAddress()) {
    window.__connectedAddress = undefined;
    try { localStorage.removeItem('kaspa-connected-address'); } catch { /* ignore */ }
    clearWalletNotice();
    renderWalletButton();
    return;
  }
  try {
    const { account } = await connectKasware('#wallet-notice');
    rememberAddress(account.address);
    clearWalletNotice();
    renderWalletButton();
  } catch {
    renderWalletButton();
  }
}

function clearWalletNotice() {
  const notice = document.querySelector('#wallet-notice');
  if (notice) notice.innerHTML = '';
}

function initFeedback() {
  const button = document.querySelector('#feedback-button');
  const dialog = document.querySelector('#feedback-dialog');
  const form = document.querySelector('#feedback-form');
  const text = document.querySelector('#feedback-text');
  const note = document.querySelector('#feedback-note');
  const send = document.querySelector('#feedback-send');
  const close = document.querySelector('#feedback-close');
  if (!button || !dialog || !form) return;

  const showNote = (message = '', kind = '') => {
    note.innerHTML = message ? `<div class="notice ${escapeHtml(kind)}"><strong>${escapeHtml(message)}</strong></div>` : '';
  };
  const open = () => { text.value = ''; showNote(); send.disabled = false; dialog.showModal(); text.focus(); };
  const closeDialog = () => dialog.close();

  button.addEventListener('click', open);
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('close', showNote);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = text.value.trim();
    if (!message) { showNote('Write a few words first.', 'error'); return; }
    send.disabled = true;
    showNote();
    try {
      await api('/api/feedback', { method: 'POST', body: { message } });
      closeDialog();
      showToast('Thanks. Your feedback was sent.');
    } catch (error) {
      send.disabled = false;
      logError('feedback_submit_failed', { code: error.code, message: error.message });
      showNote(error.message || 'Could not send feedback. Please try again.', 'error');
    }
  });
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.classList.add('show'); });
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2600);
}

function shortAddress(address) {
  const prefix = `${runtimeConfig().addressPrefix}:`;
  const body = address.startsWith(prefix) ? address.slice(prefix.length) : address;
  return `${body.slice(0, 6)}\u2026${body.slice(-4)}`;
}

function capitalize(word) { return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''; }

function scheduleGameRefresh(gameId) {
  gamePoller.start(gameId);
  window.__gameStatus = undefined;
}

function stopGameRefresh() {
  gamePoller.stop();
  gameRequestGate.next();
}

async function refreshGame(gameId, options = {}) {
  const requestRevision = gameRequestGate.next();
  try {
    if (!(location.pathname === '/game' || location.pathname === '/join')) return;
    if ((params.get('id') ?? params.get('game')) !== gameId) return;
    const game = await api(`/api/games/${gameId}`);
    if (!gameRequestGate.isCurrent(requestRevision)) return;
    const signature = gameSignature(game);
    if (window.__gameStatus === signature) return;
    window.__gameStatus = signature;
    await paintGame(gameId, game);
  } catch (error) {
    // A finished game is readable for a short window, then it is removed. Past
    // that window the link is a dead end, not a transient error to retry.
    if (error.code === 'GAME_NOT_FOUND' && gameRequestGate.isCurrent(requestRevision)) {
      stopGameRefresh();
      renderGameEnded();
      return;
    }
    // A transient refresh may race a broadcast; the next tick retries.
    if (options.reportErrors) throw error;
  }
}

function gameSignature(game) {
  // `safetyRemainingSeconds` is intentionally excluded: it decrements every
  // second, and re-painting on each tick would rebuild the in-progress forms
  // (wiping the joiner's number selection). The countdown note updates itself
  // locally via `bindRecoveryCountdown`, and the flip of `safetyReady` is the
  // authoritative signal that forces a re-paint.
  return [game.status, game.safetyAction, game.safetyReady, game.firstRevealer, game.winner,
    (game.pendingReveals ?? []).map((item) => `${item.role}:${item.retryable}`).join(','),
    (game.pendingSafety ?? []).map((item) => `${item.action}:${item.role}:${item.retryable}`).join(',')].join('|');
}

async function connectKasware(selector) {
  const provider = globalThis.kasware;
  if (!provider) {
    logError('kasware_missing', { download: KASWARE_DOWNLOAD });
    renderKaswareShortfall(selector);
    const error = new Error('KasWare wallet extension is not installed');
    error.code = 'KASWARE_UNAVAILABLE';
    throw error;
  }
  const { kaswareNetwork, addressPrefix, network: configuredNetwork } = runtimeConfig();
  logInfo('kasware_connect_start', { selector });
  const startedAt = nowMs();
  showNotice(selector, 'Connecting to KasWare', 'Confirm the connection in your wallet.', '');
  // Kaspa gives each network its own account address, so the network must be
  // settled before the account is read; the helper owns that ordering.
  let account;
  try {
    account = await connectKaswareAccount({
      provider, kaswareNetwork, addressPrefix, configuredNetwork,
      onSwitch: (from) => logInfo('kasware_switch_network', { from, to: kaswareNetwork }),
    });
  } catch (error) {
    logError('kasware_connect_failed', { code: error?.code, message: error?.message });
    throw error;
  }
  logInfo('kasware_connected', { network: kaswareNetwork, ms: Math.round(nowMs() - startedAt) });
  watchKasware(provider);
  return { provider, account };
}

function watchKasware(provider) {
  if (window.__kaswareWatched || typeof provider.on !== 'function') return;
  window.__kaswareWatched = true;
  const forget = (reason) => () => {
    logWarn('kasware_session_changed', { reason });
    window.__connectedAddress = undefined;
    try { localStorage.removeItem('kaspa-connected-address'); } catch { /* ignore */ }
    clearWalletNotice();
    renderWalletButton();
  };
  provider.on('accountsChanged', forget('accountsChanged'));
  provider.on('networkChanged', forget('networkChanged'));
}

function renderBackendError(message) {
  app.innerHTML = `<a class="back" href="/">Exit</a><section class="panel"><p class="lead">Something went wrong.</p><div class="notice error"><strong>${escapeHtml(message)}</strong></div></section>`;
}

function renderGameEnded() {
  app.innerHTML = `
    <a class="back" href="/">Exit</a>
    <section class="panel">
      <p class="lead">This game has ended.</p>
      <div class="notice"><strong>The result is no longer available.</strong>Every game stays viewable for a short time after it finishes.</div>
      <div class="actions"><a class="primary" href="/">Play again</a></div>
    </section>`;
}

async function api(url, options = {}) {
  const method = options.method ?? 'GET';
  const path = new URL(url, location.origin).pathname;
  let response;
  try {
    response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
  } catch (error) {
    logError('api_unreachable', { method, path, message: error.message });
    throw error;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message ?? body.error ?? 'Backend request failed');
    error.code = body.error;
    logWarn('api_error', { method, path, status: response.status, code: error.code, message: error.message });
    throw error;
  }
  logDebug('api_ok', { method, path, status: response.status });
  return body;
}

function renderKaswareShortfall(selector) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.innerHTML = `
    <div class="notice error">
      <strong>Install KasWare to play</strong>
      Even/Odd needs the KasWare wallet extension in your browser to play.
      <div class="actions"><a class="primary" href="${KASWARE_DOWNLOAD}" target="_blank" rel="noopener noreferrer">Install KasWare</a></div>
    </div>`;
}

function guardKaswareShortfall(selector, error) {
  if (error?.code !== 'KASWARE_UNAVAILABLE') return false;
  renderKaswareShortfall(selector);
  return true;
}

function showNotice(selector, title, message, kind) {
  const node = document.querySelector(selector);
  if (!node) return;
  const body = message ? escapeHtml(message) : '';
  node.innerHTML = `<div class="notice ${kind}"><strong>${escapeHtml(title)}</strong> ${body}</div>`;
}

function isGameId(value) { return /^[0-9a-f]{64}$/i.test(value ?? ''); }
function formatKas(sompi) { return (Number(sompi) / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
function lockKas(stakeKas) { return Number(stakeKas); }
function winnerKas(stakeKas) { const pot = Number(stakeKas) * 2; return pot - platformFeeKas(stakeKas); }
function platformFeeKas(stakeKas) { const pot = Number(stakeKas) * 2; return pot >= 100 ? pot / 100 : 0; }
function feeSummary(stakeKas) {
  const fee = platformFeeKas(stakeKas);
  return fee === 0 ? 'There is no platform fee below a 100 KAS pot.' : `A 1% platform fee (${formatKas(String(Math.round(fee * 100_000_000)))} KAS) applies to this pot.`;
}
function winnerSummary(stakeKas) {
  const fee = platformFeeKas(stakeKas);
  return fee === 0
    ? `The winner receives the full ${escapeHtml(Number(stakeKas) * 2)} KAS pot with no platform fee.`
    : `The winner receives about ${escapeHtml(winnerKas(stakeKas))} KAS after the 1% total-pot fee.`;
}
let cachedConfig = null;
async function gameFeePublicKey() {
  if (!cachedConfig) cachedConfig = await api('/api/config');
  return cachedConfig.gameFeePublicKey;
}
