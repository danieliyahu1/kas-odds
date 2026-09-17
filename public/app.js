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
import { GAME_STAGE, actionErrorCopy, covenantClock, createLatestRequestGate, createPollController, formatWait, gameSignature, gameStage, isTerminalGameStatus, lobbyStage, terminalNotice } from '/app-controller.js';
import { LOBBY_MODE, LOBBY_PHASE, createLobbyController } from './lobby-controller.js';
import { loadRuntimeConfig, runtimeConfig } from '/runtime-config.js';

const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const KASWARE_DOWNLOAD = 'https://chromewebstore.google.com/detail/kasware-wallet/hklhheigdmpoolooomdihmhlpjjdbklf';

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

// A reveal preparation can wait on the other player's lead reveal to confirm
// before it can settle. The client retries quietly for a while; the player only
// ever sees that their own reveal is in progress.
const REVEAL_WAITING_RETRY_MS = 1500;
const REVEAL_WAITING_TIMEOUT_MS = 60_000;
let revealInFlight = false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function prepareRevealWithRetry(gameId, body) {
  const deadline = nowMs() + REVEAL_WAITING_TIMEOUT_MS;
  for (;;) {
    try {
      return await api(`/api/games/${gameId}/reveal/prepare`, { method: 'POST', body });
    } catch (error) {
      if (error.code !== 'REVEAL_WAITING' || nowMs() >= deadline) throw error;
      await delay(REVEAL_WAITING_RETRY_MS);
    }
  }
}

export async function boot() {
  try {
    // Warm the covenant artifact now so the first lock never waits on it.
    void loadCovenantTemplate().catch(() => {});
    cachedConfig = await loadRuntimeConfig();
    applyNetworkLabel(cachedConfig.network);
    initWalletButton();
    initFeedback();
    if (location.pathname === '/join') {
      const room = params.get('room');
      if (isRoomId(room)) return renderLobby({ mode: 'guest', roomId: room });
      return renderBackendError('That invite link doesn\u2019t look right.');
    }
    if (location.pathname === '/game') return renderGame(params.get('id') ?? params.get('game'));
    if (location.pathname === '/host') return renderLobby({ mode: 'host', roomId: isRoomId(params.get('room')) ? params.get('room') : null });
    if (location.pathname === '/rival') return renderLobby({ mode: 'public' });
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

function renderLobby({ mode, roomId = null }) {
  const controller = createLobbyController({
    mode,
    roomId,
    api,
    connect: connectWallet,
    sign: signWithKasware,
    createSecret: createRevealSecret,
    verifyCreation,
    verifyPrepared: verifyPreparedTransaction,
    bindSecret: bindSecretToGame,
    gameFeePublicKey,
    addressPrefix: () => runtimeConfig().addressPrefix,
    remember: rememberAddress,
    navigate: (path) => { location.href = path; },
    replaceUrl: (path) => history.replaceState(null, '', path),
    render: paintLobby,
    logger: { info: logInfo, warn: logWarn, error: logError },
    step: timedStep,
  });
  controller.start();
  return controller;
}

// Thin DOM view for the lobby controller. The controller owns the phase; this
// renders exactly one panel per phase, so the heading and body cannot drift from
// the step the player is actually on. Every action is delegated back to the
// controller.
function paintLobby(snapshot, actions) {
  const { mode, phase, match, number, draft, busy, note, error } = snapshot;
  const label = mode === LOBBY_MODE.PUBLIC ? 'Play someone new' : 'Play with a friend';
  const progress = lobbyStage({ phase, mode, match });
  const stageTitle = progress ? progress.title : '';
  const notice = `<div id="lobby-notice">${lobbyNoticeHtml(note)}</div>`;
  const startButton = `<div class="actions"><button type="button" class="primary" id="lobby-start"${busy ? ' disabled' : ''}>`;
  const cancelButton = '<div class="actions"><button type="button" class="outline" id="lobby-leave">Cancel</button></div>';
  const paint = (title, body) => {
    app.innerHTML = `
      <a class="back" href="/">Back</a>
      <section class="panel" aria-label="${label}">
        <div class="panel-head"><h2>${escapeHtml(title)}</h2>${stageRailHtml(progress?.rail)}</div>
        ${body}
      </section>`;
  };
  const bindStart = (handler) => document.querySelector('#lobby-start').addEventListener('click', handler);

  if (phase === LOBBY_PHASE.LIMIT) {
    paint('Play someone new', `
      <p class="lead">Set the most you'll play. We match you with one player &mdash; the lower of your two limits is the stake.</p>
      <div class="stake-block">
        <div class="stake-label-row"><label for="match-limit">Play up to (KAS)</label></div>
        <input id="match-limit" type="number" min="1" max="1000000" step="1" value="${escapeHtml(draft ?? '1')}" class="stake-input" aria-label="Play up to in KAS">
        <p class="fate">You'll never play for more than this.</p>
      </div>
      ${notice}
      ${startButton}Find a player</button></div>`);
    bindStart(() => void actions.connectLimit(document.querySelector('#match-limit').value));
    return;
  }

  if (phase === LOBBY_PHASE.HOST_FORM) {
    paint('Play with a friend', `
      <p class="lead">Set the stake, then share the link. You'll both pick a number once your friend joins.</p>
      <div class="stake-block">
        <div class="stake-label-row"><label for="host-stake">Stake (KAS)</label></div>
        <input id="host-stake" type="number" min="1" max="1000000" step="1" value="${escapeHtml(draft ?? '1')}" class="stake-input" aria-label="Stake in KAS">
        <p class="fate">Winner takes the <span id="host-pot">2 KAS</span> pot.</p>
      </div>
      ${notice}
      ${startButton}Create invite</button></div>`);
    const stakeInput = document.querySelector('#host-stake');
    stakeInput.addEventListener('input', () => {
      const shown = Math.min(1000000, Math.max(1, Math.floor(Number(stakeInput.value) || 1)));
      document.querySelector('#host-pot').textContent = `${shown * 2} KAS`;
    });
    bindStart(() => void actions.connectHost(stakeInput.value));
    return;
  }

  if (phase === LOBBY_PHASE.GUEST_ENTRY) {
    paint('Joining your friend', `
      <p class="lead">Connect your wallet to take the second seat.</p>
      ${notice}
      ${startButton}Connect wallet</button></div>`);
    bindStart(() => void actions.connectGuest());
    return;
  }

  if (phase === LOBBY_PHASE.RESUME) {
    paint('Play with a friend', `
      <p class="lead">Reconnect your wallet to return to your game.</p>
      ${notice}
      ${startButton}Reconnect</button></div>`);
    bindStart(() => void actions.resume());
    return;
  }

  if (phase === LOBBY_PHASE.WAITING) {
    if (mode === LOBBY_MODE.PUBLIC) {
      paint('Searching a player', `
        <div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Your limit: up to ${escapeHtml(match.myLimitKas)} KAS.</span></div>
        <p class="muted-note">You'll pick your number when we match.</p>
        ${cancelButton}`);
    } else {
      const link = roomInviteUrl(match.matchId);
      paint('Waiting for your friend', `
        <p class="lead">Share this link. You'll both pick a number once they join.</p>
        <div class="invite-box" id="invite-box">
          <p class="muted-note">${escapeHtml(link)}</p>
          <button class="share-button" data-action="copy-link">Copy link</button>
        </div>
        <p class="fate">Stake: ${escapeHtml(match.stakeKas)} KAS each &mdash; winner takes the ${escapeHtml(match.stakeKas * 2)} KAS pot.</p>
        ${cancelButton}`);
      bindShare(link);
    }
    document.querySelector('#lobby-leave').addEventListener('click', () => void actions.leave());
    return;
  }

  if (phase === LOBBY_PHASE.PICK) {
    const selected = (value) => number === value;
    paint(stageTitle, `
      ${matchSummaryHtml(match.side, match.stakeKas)}
      <fieldset class="choice-group">
        <legend>Pick your number</legend>
        <div class="choice-row">
          <button type="button" class="choice num${selected(1) ? ' selected' : ''}" data-match-number="1" aria-pressed="${selected(1)}"><span class="num-big">1</span></button>
          <button type="button" class="choice num${selected(0) ? ' selected' : ''}" data-match-number="0" aria-pressed="${selected(0)}"><span class="num-big">2</span></button>
        </div>
      </fieldset>
      <div id="match-number-notice"></div>
      <div class="actions"><button type="button" class="primary" id="match-play"${number === null ? ' disabled' : ''}>Play for ${escapeHtml(match.stakeKas)} KAS</button></div>`);
    document.querySelectorAll('[data-match-number]').forEach((button) => button.addEventListener('click', () => actions.selectNumber(Number(button.dataset.matchNumber))));
    document.querySelector('#match-play').addEventListener('click', () => void actions.play());
    return;
  }

  if (phase === LOBBY_PHASE.PREPARING) {
    const waitingOnOpponent = progress.stage === GAME_STAGE.VOTE_WAIT;
    paint(stageTitle, `
      <div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">${waitingOnOpponent ? "They haven't voted yet." : 'Preparing your transaction.'}</span></div>`);
    return;
  }

  if (phase === LOBBY_PHASE.WALLET) {
    paint(stageTitle, `
      <p class="lead">Approve <strong>${escapeHtml(lockKas(match.stakeKas))} KAS</strong>.</p>
      <p class="muted-note">Your stake stays locked until the game ends.</p>`);
    return;
  }

  if (phase === LOBBY_PHASE.ABANDONED) {
    if (mode === LOBBY_MODE.PUBLIC) {
      paint('Your opponent left', `
        <div class="notice"><strong>No KAS was locked.</strong></div>
        <div class="actions"><a class="primary home-button" href="/rival">Find another player</a></div>`);
    } else {
      paint('Your friend left', `
        <div class="notice"><strong>No KAS was locked.</strong></div>
        <div class="actions"><a class="primary home-button" href="/host">Start a new game</a></div>`);
    }
    return;
  }

  const retry = error?.action === 'start' ? actions.retryStart : error?.action === 'lobby' ? actions.retry : null;
  paint(error?.title ?? 'Please try again', `
    <div class="notice error"><strong>${escapeHtml(error?.message ?? 'Something went wrong.')}</strong></div>
    ${retry
      ? '<div class="actions"><button type="button" class="primary" id="lobby-retry">Try again</button></div>'
      : '<div class="actions"><a class="primary home-button" href="/">Back to start</a></div>'}`);
  if (retry) document.querySelector('#lobby-retry').addEventListener('click', () => void retry());
}

function lobbyNoticeHtml(note) {
  if (!note) return '';
  if (note.kind === 'kasware') {
    return `<div class="notice error"><strong>Install KasWare to play</strong>Even/Odd needs the KasWare wallet extension in your browser to play.<div class="actions"><a class="primary" href="${KASWARE_DOWNLOAD}" target="_blank" rel="noopener noreferrer">Install KasWare</a></div></div>`;
  }
  const kind = note.kind === 'error' ? 'error' : '';
  return `<div class="notice ${kind}"><strong>${escapeHtml(note.title)}</strong> ${escapeHtml(note.message ?? '')}</div>`;
}

function roomInviteUrl(matchId) {
  return `${location.origin}/join?room=${matchId}`;
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

function paintGameHeader(game, role, progress) {
  if (game.status === 'settled') {
    if (role === 'creator' || role === 'joiner') return { rail: null, title: winnerIsYou(game, role) ? 'You won.' : 'You lost.', loading: false };
    return { rail: null, title: `${capitalize(winnerSideName(game))} took the pot.`, loading: false };
  }
  if (role === 'viewer') return { rail: null, title: 'You are watching this game.', loading: false };
  if (isGameOver(game.status)) return { rail: null, title: 'Game over.', loading: false };
  return { rail: progress?.rail ?? null, title: progress?.title ?? 'Game over.', loading: progress?.loading ?? false };
}

function isGameOver(status) {
  return isTerminalGameStatus(status) || status === 'refund_partial';
}

async function paintGame(gameId, game) {
  const role = detectRole(game);
  const active = !['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status);
  void forgetRevealSecret(gameId, !active);
  const myPendingReveal = (game.pendingReveals ?? []).find((item) => item.role === role) ?? null;
  const myPendingSafety = (game.pendingSafety ?? []).find((item) => item.role === role) ?? null;
  const progress = gameStage(game, role);
  const revealMine = progress?.stage === GAME_STAGE.REVEAL;
  const header = paintGameHeader(game, role, progress);

  app.innerHTML = `
    <a class="back" href="/" data-action="exit">Exit</a>
    <section class="panel" aria-label="Game">
      <div class="panel-head">
        ${header.loading ? `<div class="header-loading"><span class="spinner large confirm" aria-hidden="true"></span><h2>${escapeHtml(header.title)}</h2></div>` : `<h2>${escapeHtml(header.title)}</h2>`}
        ${stageRailHtml(header.rail)}
      </div>
      <div class="game-body">
        ${gameSummary(game, role)}
        ${active ? inviteBox(game) + (revealMine ? revealSection(game, myPendingReveal) : '') : ''}
        ${resultOverlay(game, role)}
        ${safetySection(game, myPendingSafety)}
        ${terminalSection(game, role)}
      </div>
    </section>`;

  bindReveal(gameId);
  bindShare();
  bindSafety(gameId, game, myPendingSafety);
  bindExit(gameId, game, role, myPendingSafety);
  bindGameClock(gameId);
  bindPlayAgain();
  if (!active || isTerminalGameStatus(game.status)) stopGameRefresh();
}

function stageRailHtml(rail) {
  if (!rail || rail.length === 0) return '';
  const nodes = rail.map((node) => {
    const current = node.state === 'current';
    return `<li class="stage-node ${node.state}"${current ? ' aria-current="step"' : ''}><span class="sr-only">${escapeHtml(node.label)}</span></li>`;
  }).join('');
  return `<ol class="stage-rail" aria-label="Game progress">${nodes}</ol>`;
}

function inviteBox(game) {
  if (['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status)) return '';
  if (game.matchmaking) return '';
  return `
    <div class="invite-box" id="invite-box">
      <button class="share-button" data-action="copy-link">Copy link</button>
    </div>`;
}

function gameSummary(game, role) {
  return matchSummaryHtml(playerSide(game, role), game.stakeKas);
}

// One sentence for who the player is, the stake, and a highlighted take. Shared
// by the pick screen and the game screen so the two never drift.
function matchSummaryHtml(side, stakeKas) {
  const sideLine = side ? `You're <strong>${escapeHtml(capitalize(side))}</strong>` : 'Even vs Odd';
  const fee = platformFeeKas(stakeKas);
  const feeNote = fee === 0 ? '' : '<p class="muted-note">After the 1% fee.</p>';
  return `
    <div class="game-summary">
      <p class="game-side">${sideLine}</p>
      <p class="game-stake"><strong>${escapeHtml(stakeKas)} KAS</strong> each</p>
      <p class="game-prize"><span>Winner takes</span> <strong>${escapeHtml(winnerKas(stakeKas))} KAS</strong></p>
      ${feeNote}
    </div>`;
}

function playerSide(game, role) {
  if (role === 'creator') return game.creator?.side ?? null;
  if (role === 'joiner') return game.creator?.side === 'even' ? 'odd' : 'even';
  return null;
}

function revealSection(game, pending) {
  const waiting = pending && !pending.retryable;
  const control = waiting
    ? revealWaitingHtml('Revealing...')
    : `<div class="actions"><button type="button" class="primary" data-action="reveal">${pending ? 'Try again' : 'Reveal number'}</button></div>`;
  return revealBlockHtml(control);
}

function revealBlockHtml(control) {
  return `
    <div id="game-action" class="reveal-block">
      <p class="lead">Reveal your number</p>
      <div id="reveal-notice"></div>
      ${control}
    </div>`;
}

function revealWaitingHtml(label) {
  return `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">${label}</span></div>`;
}

// The reveal control while a preparation retries or a signature is pending. It
// replaces the button so a second reveal cannot fire, and survives poll repaints
// (see refreshGame) until the reveal resolves or fails.
function showRevealInFlight() {
  const block = document.querySelector('#game-action');
  if (!block) return;
  block.outerHTML = revealBlockHtml(revealWaitingHtml('Revealing...'));
}

// The in-flight control replaced the button, so repaint the live state to restore
// a fresh control before explaining the failure in place.
async function renderRevealFailure(gameId, error) {
  window.__gameStatus = undefined;
  await refreshGame(gameId);
  if (error.code === 'KASWARE_UNAVAILABLE') return renderKaswareShortfall('#reveal-notice');
  if (error.code === 'REVEAL_SECRET_MISSING') return showNotice('#reveal-notice', 'Reveal unavailable', 'This browser does not have your unrevealed number for this game. Play the game in the browser you used to start it, and keep this site\'s data.', 'error');
  if (error.code === 'INVALID_REVEAL') return showNotice('#reveal-notice', 'Reveal did not match', 'The saved number no longer matches the locked commitment. You may have started this game in another browser.', 'error');
  return showActionError('#reveal-notice', error);
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
    revealInFlight = true;
    showRevealInFlight();
    try {
      const { provider, account } = await connectKasware('#reveal-notice');
      rememberAddress(account.address);
      const secret = await loadSecretForGame(gameId);
      if (!secret) {
        const error = new Error('This browser does not have the unrevealed number for this game');
        error.code = 'REVEAL_SECRET_MISSING';
        throw error;
      }
      const prepared = await timedStep('prepare_reveal', () => prepareRevealWithRetry(gameId, {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
        choice: secret.choice,
        nonceHex: secret.nonceHex,
      }));
      const verified = await timedStep('verify_reveal', () => Promise.resolve(verifyPreparedTransaction(prepared, 'reveal')));
      showNotice('#reveal-notice', 'Confirm in KasWare', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson, verified.signInputs);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/reveal/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      revealInFlight = false;
      await refreshGame(gameId);
    } catch (error) {
      revealInFlight = false;
      logError('reveal_failed', { code: error.code, message: error.message });
      await renderRevealFailure(gameId, error);
    }
  });
}

function bindShare(url = location.href) {
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
  const clock = covenantClock(game, { isFirstRevealer: isFirstRevealer(game) });
  if (!clock) return '';
  const note = clock.remainingSeconds == null && !clock.ready ? `Checking the timeout. ${clock.note}` : clock.note;
  return `<p class="lead">${clockLeadHtml(clock)}</p><p class="muted-note">${escapeHtml(note)}</p>`;
}

// The clock element carries only the time; the lead carries the covenant entry.
function clockLeadHtml(clock) {
  if (clock.ready) return `${escapeHtml(clock.label)} now`;
  if (clock.remainingSeconds == null) return escapeHtml(clock.label);
  const time = escapeHtml(formatWait(clock.remainingSeconds));
  return `${escapeHtml(clock.label)} in <span class="clock" data-game-clock data-remaining="${clock.remainingSeconds}">${time}</span>`;
}

function isFirstRevealer(game) {
  const address = connectedAddress();
  return Boolean(address) && address === game.firstRevealer;
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
  return '';
}

function terminalSection(game, role) {
  const notice = terminalNotice(game, role);
  if (!notice) return '';
  const proof = onChainProofHtml(game);
  return `<div class="notice"><strong>${escapeHtml(notice.title)}</strong>${escapeHtml(notice.message)}${proof}</div>`;
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
      ${onChainProofHtml(game)}
      ${role === 'creator' || role === 'joiner' ? '<button type="button" class="primary" data-action="play-again">Play again</button>' : ''}
    </div>`;
}

// The on-chain proof is deliberately quiet: one line per settled transaction, a
// plain-language label, and a shortened id that opens the network explorer. It
// answers "can I check this myself?" without competing with the result.
function onChainProofHtml(game) {
  const transactions = game.transactions ?? [];
  if (transactions.length === 0) return '';
  const explorer = runtimeConfig().explorerUrl;
  const rows = transactions.map((transaction) => `
    <div class="proof-row">
      <span class="proof-label">${escapeHtml(onChainLabel(transaction.action))}</span>
      ${explorer ? `<a class="proof-tx" href="${escapeHtml(`${explorer}/${transaction.transactionId}`)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(transaction.transactionId)}">${escapeHtml(shortTransactionId(transaction.transactionId))}</a>`
        : `<span class="proof-tx">${escapeHtml(shortTransactionId(transaction.transactionId))}</span>`}
    </div>`).join('');
  return `<div class="proof"><span class="proof-heading">Verify on-chain</span>${rows}</div>`;
}

function onChainLabel(action) {
  if (action === 'settlement') return 'Winner payout';
  if (action === 'fallback_claim') return 'Claim payout';
  return 'Refund';
}

function shortTransactionId(transactionId) {
  return transactionId.length > 18 ? `${transactionId.slice(0, 8)}\u2026${transactionId.slice(-6)}` : transactionId;
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

// The clock reads its remaining time from the element it writes to, so a poll
// can re-anchor it without restarting the ticker.
function bindGameClock(gameId) {
  clearInterval(window.__gameClockTicker);
  if (!document.querySelector('[data-game-clock]')) return;
  window.__gameClockTicker = setInterval(() => {
    const element = document.querySelector('[data-game-clock]');
    if (!element) {
      clearInterval(window.__gameClockTicker);
      return;
    }
    const remaining = Math.max(0, (Number(element.dataset.remaining) || 0) - 1);
    element.dataset.remaining = String(remaining);
    element.textContent = formatWait(remaining);
    if (remaining === 0) {
      clearInterval(window.__gameClockTicker);
      void refreshGame(gameId);
    }
  }, 1000);
}

// The poll is authoritative: when nothing else changed, re-anchor the running
// clock to the server's fresh covenant-derived remaining time.
function syncGameClock(game) {
  const element = document.querySelector('[data-game-clock]');
  if (!element || game.automaticRemainingSeconds == null) return;
  const remaining = Number(game.automaticRemainingSeconds);
  const shown = Number(element.dataset.remaining);
  if (Number.isFinite(shown) && Math.abs(shown - remaining) < 2) return;
  element.dataset.remaining = String(remaining);
  element.textContent = formatWait(remaining);
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
    // A reveal in flight owns the reveal control; a status flip caused by the
    // other player's reveal must not repaint it away. The reveal resolves itself
    // with its own repaint once it settles or fails.
    if (revealInFlight && !isTerminalGameStatus(game.status)) {
      syncGameClock(game);
      return;
    }
    const signature = gameSignature(game);
    if (window.__gameStatus === signature) {
      syncGameClock(game);
      return;
    }
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

// Wallet connection with no DOM side effects, for the lobby controller.
async function connectWallet() {
  const provider = globalThis.kasware;
  if (!provider) {
    logError('kasware_missing', { download: KASWARE_DOWNLOAD });
    const error = new Error('KasWare wallet extension is not installed');
    error.code = 'KASWARE_UNAVAILABLE';
    throw error;
  }
  const { kaswareNetwork, addressPrefix, network: configuredNetwork } = runtimeConfig();
  logInfo('kasware_connect_start');
  const startedAt = nowMs();
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

// The game page connects inline, so it keeps the in-place notice and install
// prompt; the lobby renders the same states through its controller.
async function connectKasware(selector) {
  showNotice(selector, 'Connecting to KasWare', 'Confirm the connection in your wallet.', '');
  try {
    return await connectWallet();
  } catch (error) {
    if (error?.code === 'KASWARE_UNAVAILABLE') renderKaswareShortfall(selector);
    throw error;
  }
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
function isRoomId(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? ''); }
function formatKas(sompi) { return (Number(sompi) / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
function lockKas(stakeKas) { return Number(stakeKas); }
function winnerKas(stakeKas) { const pot = Number(stakeKas) * 2; return pot - platformFeeKas(stakeKas); }
// The covenant charges `gross_pot / 100` with integer division, so the fee is a
// floored percent of the pot; the app must floor too or it will promise more
// than the winner actually receives.
function platformFeeKas(stakeKas) { const pot = Number(stakeKas) * 2; return pot >= 100 ? Math.floor(pot / 100) : 0; }
let cachedConfig = null;
async function gameFeePublicKey() {
  if (!cachedConfig) cachedConfig = await api('/api/config');
  return cachedConfig.gameFeePublicKey;
}
