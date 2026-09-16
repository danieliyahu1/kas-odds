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
import { actionErrorCopy, createLatestRequestGate, createPollController, isTerminalGameStatus } from '/app-controller.js';
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
  const notice = `<div id="lobby-notice">${lobbyNoticeHtml(note)}</div>`;
  const startButton = `<div class="actions"><button type="button" class="primary" id="lobby-start"${busy ? ' disabled' : ''}>`;
  const cancelButton = '<div class="actions"><button type="button" class="outline" id="lobby-leave">Cancel</button></div>';
  const paint = (title, body) => {
    app.innerHTML = `
      <a class="back" href="/">Back</a>
      <section class="panel" aria-label="${label}">
        <div class="panel-head"><h2>${escapeHtml(title)}</h2></div>
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
    paint('Join your friend', `
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
      paint('Looking for a player', `
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
    paint("You're matched", `
      <p class="lead">You're <strong class="side-strong">${escapeHtml(capitalize(match.side))}</strong>. <strong>${escapeHtml(match.stakeKas)} KAS</strong> each.</p>
      <p class="fate">${winnerSummary(match.stakeKas)}</p>
      <fieldset class="choice-group">
        <legend>Your number</legend>
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
    paint('Getting your game ready', `
      <div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">This only takes a moment.</span></div>`);
    return;
  }

  if (phase === LOBBY_PHASE.WALLET) {
    paint('Confirm in your wallet', `
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

function paintGameHeader(status, role, game, revealMine) {
  if (status === 'settled') {
    if (role === 'creator' || role === 'joiner') return { title: winnerIsYou(game, role) ? 'You won.' : 'You lost.', loading: false };
    return { title: `${capitalize(winnerSideName(game))} took the pot.`, loading: false };
  }
  if (role === 'viewer') return { title: 'You are watching this game.', loading: false };
  if (role === 'creator' && game.status === 'waiting_for_player_b') return { title: 'Your game is ready.', loading: false };
  if (game.status === 'joined' || game.status === 'first_revealed' || game.status === 'reveal_broadcast' || game.status === 'settlement_broadcast') {
    return { title: revealMine ? 'Your turn to reveal.' : `Waiting for your ${game.matchmaking ? 'opponent' : 'friend'}.`, loading: false };
  }
  return { title: 'Getting your game ready.', loading: true };
}

async function paintGame(gameId, game) {
  const role = detectRole(game);
  const active = !['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status);
  void forgetRevealSecret(gameId, !active);
  const myPendingReveal = (game.pendingReveals ?? []).find((item) => item.role === role) ?? null;
  const myPendingSafety = (game.pendingSafety ?? []).find((item) => item.role === role) ?? null;
  const revealMine = (game.canReveal || Boolean(myPendingReveal)) && (role === 'creator' || role === 'joiner') && !isMyReveal(game, role);
  const header = paintGameHeader(game.status, role, game, revealMine);
  const isPlayer = role === 'creator' || role === 'joiner';
  const waiting = active && isPlayer && !revealMine;

  app.innerHTML = `
    <a class="back" href="/" data-action="exit">Exit</a>
    <section class="panel" aria-label="Game">
      <div class="panel-head">
        ${header.loading ? `<div class="header-loading"><span class="spinner large confirm" aria-hidden="true"></span><h2>${escapeHtml(header.title)}</h2></div>` : `<h2>${escapeHtml(header.title)}</h2>`}
      </div>
      <div class="game-body">
        ${gameDetails(game)}
        ${active ? inviteBox(game, waiting) + (revealMine ? revealSection(game, myPendingReveal) : '') : ''}
        ${resultOverlay(game, role)}
        ${safetySection(game, myPendingSafety)}
        ${terminalSection(game)}
      </div>
    </section>`;

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
