// Browser client for Even/Odd.
//
// The browser is deliberately thin: it owns the hidden number and nonce
// (created and stored locally in IndexedDB), verifies the prepared creation
// against its own intent, and signs with KasWare. All Kaspa chain communication
// — fee estimation, transaction preparation, broadcast, and confirmation — is
// delegated to the app server, which only ever sees the commitment hash (not
// the number) until the reveal makes it public on-chain.
import { bindSecretToGame, createRevealSecret, deleteSecretForGame, loadSecretForGame } from '/secrets.js';
import { verifyCreation } from '/verify.js';
import { logDebug, logInfo, logWarn, logError } from '/log.js';
import { signWithKasware as kaswareSignPskt } from '/kasware-signing.js';

const NETWORK = 'testnet-10';
const KASWARE_NETWORK = 'kaspa_testnet_10';
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const KASWARE_DOWNLOAD = 'https://chromewebstore.google.com/detail/kasware-wallet/hklhheigdmpoolooomdihmhlpjjdbklf';

boot();

async function boot() {
  try {
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

function renderHome() {
  app.innerHTML = `
    <section class="panel home-panel" aria-label="Play Even Odd">
      <div class="panel-head">
        <h1>Even / Odd</h1>
        <p class="lead">A quick game of chance on Kaspa.</p>
      </div>
      <div class="home-actions">
        <a class="primary home-button" href="/rival">Find a rival</a>
        <a class="outline home-button" href="/host">Play with a friend</a>
      </div>
    </section>`;
}

function renderMatchmaking() {
  app.innerHTML = `
    <a class="back" href="/">Back</a>
    <section class="panel" aria-label="Find a rival">
      <div class="panel-head"><h2>Find a rival</h2><p class="lead">Your limit &mdash; the most you're comfortable playing. We match you with anyone; the lower limit sets the game.</p></div>
      <div id="matchmaking-content">
        <div class="stake-block">
          <div class="stake-label-row">
            <label for="match-limit">Play up to (KAS)</label>
          </div>
          <input id="match-limit" type="number" min="1" max="1000000" step="1" value="1" class="stake-input" aria-label="Play up to in KAS">
          <p class="fate">Up to <span id="match-limit-fate">1 KAS</span> &mdash; matched with anyone.</p>
        </div>
        <div class="actions"><button type="button" class="primary" id="match-start">Find a rival</button></div>
      </div>
    </section>`;

  const content = document.querySelector('#matchmaking-content');
  let provider;
  let account;
  let match;
  let pollTimer;
  let number = null;
  let started = false;

  const limitInput = document.querySelector('#match-limit');
  const limitFate = document.querySelector('#match-limit-fate');
  const rawLimit = () => Math.floor(Number(limitInput.value) || 1);
  const syncLimit = () => { limitFate.textContent = `${Math.min(1000000, Math.max(1, rawLimit()))} KAS`; };
  limitInput.addEventListener('input', syncLimit);
  syncLimit();

  async function startMatchmaking() {
    const button = document.querySelector('#match-start');
    const typed = Number(limitInput.value);
    if (!Number.isInteger(typed) || typed < 1 || typed > 1000000) {
      return showNotice('#matchmaking-content', 'Enter a limit', 'Use a whole number from 1 to 1,000,000 KAS.', 'error');
    }
    button.disabled = true;
    try {
      ({ provider, account } = await connectKasware('#matchmaking-content'));
      rememberAddress(account.address);
      match = await api('/api/matchmaking/join', { method: 'POST', body: { address: account.address, publicKey: account.publicKey, limitKas: rawLimit() } });
      renderMatchState();
      pollTimer = setInterval(() => { void refreshMatch(); }, 2500);
      await refreshMatch();
    } catch (error) {
      button.disabled = false;
      logError('matchmaking_failed', { code: error.code, message: error.message });
      if (guardKaswareShortfall('#matchmaking-content', error)) return;
      showNotice('#matchmaking-content', 'Could not find a rival', error.message, 'error');
    }
  }

  document.querySelector('#match-start').addEventListener('click', startMatchmaking);

  function renderMatchState() {
    if (match.status === 'waiting') {
      content.innerHTML = `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Finding your rival</span></div><p class="muted-note">Up to ${escapeHtml(match.myLimitKas)} KAS. You'll pick your number once we match.</p><button type="button" class="outline" id="match-leave">Cancel</button>`;
      document.querySelector('#match-leave').addEventListener('click', leave);
      return;
    }
    if (match.status === 'cancelled' || !match.opponentConnected) {
      content.innerHTML = '<div class="notice error"><strong>Your rival left.</strong>No KAS was locked.</div><div class="actions"><a class="primary home-button" href="/rival">Find another rival</a></div>';
      return;
    }
    // The creator starts the game by signing; the matched rival joins once the
    // on-chain game appears (the join transaction spends the creator output).
    if (match.role === 'creator' && match.gameId) {
      location.href = `/game?id=${match.gameId}`;
      return;
    }
    if ((match.role === 'creator' && !match.gameId) || (match.role === 'joiner' && match.gameId)) {
      renderMatchPlay();
      return;
    }
    content.innerHTML = `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for your rival to create the game</span></div><button type="button" class="outline" id="match-leave">Cancel</button>`;
    document.querySelector('#match-leave').addEventListener('click', leave);
  }

  function renderMatchPlay() {
    const isCreator = match.role === 'creator';
    content.innerHTML = `
      <div class="notice"><strong>Rival found.</strong>You're ${escapeHtml(capitalize(match.side))}. The game is <strong>${escapeHtml(match.stakeKas)} KAS each</strong>.</div>
      <p class="muted-note">You were in for up to ${escapeHtml(match.myLimitKas)} KAS. Your rival up to ${escapeHtml(match.rivalLimitKas)}. The lower limit wins.</p>
      <div class="summary">
        <div class="sum-item"><small>Stake</small><strong>${escapeHtml(match.stakeKas)} KAS</strong></div>
        <div class="sum-item"><small>Pot</small><strong>${escapeHtml(match.stakeKas * 2)} KAS</strong></div>
      </div>
      <fieldset class="choice-group">
        <legend>Your number</legend>
        <div class="choice-row">
          <button type="button" class="choice num" data-match-number="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
          <button type="button" class="choice num" data-match-number="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
        </div>
      </fieldset>
      <div id="match-number-notice"></div>
      <div class="actions"><button type="button" class="primary" id="match-play" disabled>${isCreator ? 'Create' : 'Join'} for ${escapeHtml(match.stakeKas)} KAS</button></div>`;
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
      clearInterval(pollTimer);
      if (isCreator) void startCreation();
      else void startJoin();
    });
  }

  async function refreshMatch() {
    if (started) return;
    try {
      const previous = match;
      match = await api(`/api/matchmaking/${match.matchId}?address=${encodeURIComponent(account.address)}`);
      const changed = previous.status !== match.status
        || previous.opponentConnected !== match.opponentConnected
        || previous.gameId !== match.gameId
        || previous.stakeKas !== match.stakeKas;
      if (changed) renderMatchState();
    } catch (error) {
      if (error.code === 'MATCH_NOT_FOUND') clearInterval(pollTimer);
    }
  }

  async function startCreation() {
    try {
      content.innerHTML = `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Preparing your ${escapeHtml(match.stakeKas)} KAS game</span></div>`;
      const secret = await createRevealSecret(number);
      const prepared = await api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side: match.side,
        stakeKas: match.stakeKas,
        matchId: match.matchId,
      } });
      await verifyCreation({ txJson: prepared.txJson, creatorPublicKey: account.publicKey, creatorCommitment: secret.commitment, side: match.side, stakeKas: match.stakeKas, deadlineDaa: prepared.deadlineDaa, gameFeePublicKey: await gameFeePublicKey() });
      showNotice('#matchmaking-content', 'Confirm in KasWare', `Approve ${lockKas(match.stakeKas)} KAS (your full stake).`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
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
      content.innerHTML = `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Preparing your ${escapeHtml(match.stakeKas)} KAS game</span></div>`;
      await waitForJoinableGame(match.gameId);
      const secret = await createRevealSecret(number);
      await bindSecretToGame(match.gameId, secret.secretId);
      const prepared = await api(`/api/games/${match.gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
        matchId: match.matchId,
      } });
      showNotice('#matchmaking-content', 'Confirm in KasWare', `Approve ${lockKas(match.stakeKas)} KAS (your full stake).`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${match.gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      location.href = `/game?id=${match.gameId}`;
    } catch (error) {
      showMatchStartError(error);
    }
  }

  async function waitForJoinableGame(gameId) {
    while (true) {
      const game = await api(`/api/games/${gameId}`);
      if (game.canJoin) return;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  function showMatchStartError(error) {
    started = false;
    logError('match_start_failed', { code: error.code, message: error.message });
    const copy = actionErrorCopy(error);
    content.innerHTML = `<div class="notice error"><strong>${escapeHtml(copy.title)}</strong>${escapeHtml(copy.message)}</div><div class="actions"><button type="button" class="primary" id="match-retry">Try again</button></div>`;
    document.querySelector('#match-retry').addEventListener('click', () => {
      started = true;
      if (match.role === 'creator') void startCreation();
      else void startJoin();
    });
  }

  async function leave() {
    clearInterval(pollTimer);
    await api(`/api/matchmaking/${match.matchId}/leave`, { method: 'POST', body: { address: account.address } }).catch(() => {});
    location.href = '/';
  }
}

function renderCreate() {
  app.innerHTML = `
    <section class="panel" aria-label="Start a game">
      <div class="panel-head">
        <h1>Even / Odd</h1>
      </div>
      <form class="form" id="create-form">
        <fieldset class="choice-group">
          <legend>Your side</legend>
          <div class="choice-row">
            <button type="button" class="choice selected" data-side="even" aria-pressed="true">Even</button>
            <button type="button" class="choice" data-side="odd" aria-pressed="false">Odd</button>
          </div>
        </fieldset>
        <fieldset class="choice-group">
          <legend>Your number</legend>
          <div class="choice-row">
            <button type="button" class="choice num" data-commit-number="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
            <button type="button" class="choice num" data-commit-number="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
          </div>
        </fieldset>
        <div class="stake-block">
          <div class="stake-label-row">
            <label for="stake">Your stake (KAS)</label>
          </div>
          <input id="stake" type="number" min="1" max="1000000" step="1" value="1" aria-label="Stake in KAS" class="stake-input">
          <p class="fate">Winner takes the pot &mdash; <span id="stake-fate">2 KAS</span>.</p>
        </div>
        <div id="create-notice"></div>
        <p class="muted-note">Your number is saved only in this browser. Clearing site data before you reveal forfeits your stake.</p>
        <div class="actions">
          <button type="submit" class="primary" id="create-submit">Play for 1 KAS</button>
        </div>
      </form>
    </section>`;

  let side = 'even';
  let number = null;

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

  const stakeState = () => {
    const raw = Math.floor(Number(stakeInput.value) || 1);
    return Math.min(1000000, Math.max(1, raw));
  };
  const syncStake = () => {
    const stake = stakeState();
    submit.textContent = `Play for ${stake} KAS`;
    stakeFate.textContent = `${stake * 2} KAS`;
  };
  stakeInput.addEventListener('input', syncStake);
  syncStake();

  document.querySelector('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const stake = stakeState();
    if (!Number.isInteger(Number(stakeInput.value)) || Number(stakeInput.value) < 1 || Number(stakeInput.value) > 1000000) {
      return showNotice('#create-notice', 'Enter a stake', 'Use a whole number from 1 to 1,000,000 KAS.', 'error');
    }
    if (number === null) return showNotice('#create-notice', 'Pick a number', 'Choose 1 or 2 before you play.', 'error');
    submit.disabled = true;
    try {
      const { provider, account } = await connectKasware('#create-notice');
      rememberAddress(account.address);
      const secret = await createRevealSecret(number);
      const prepared = await api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side,
        stakeKas: stake,
      } });
      await verifyCreation({ txJson: prepared.txJson, creatorPublicKey: account.publicKey, creatorCommitment: secret.commitment, side, stakeKas: stake, deadlineDaa: prepared.deadlineDaa, gameFeePublicKey: await gameFeePublicKey() });
      showNotice('#create-notice', 'Confirm in KasWare', `Approve ${lockKas(stake)} KAS (your full stake). Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await bindSecretToGame(game.gameId, secret.secretId);
      location.href = `/game?id=${game.gameId}`;
    } catch (error) {
      submit.disabled = false;
      logError('create_game_failed', { code: error.code, message: error.message });
      if (guardKaswareShortfall('#create-notice', error)) return;
      showNotice('#create-notice', 'Game was not created', error.message, 'error');
    }
  });
}

async function renderJoinEntry(gameId) {
  if (!isGameId(gameId)) return renderBackendError('That game link doesn\u2019t look right.');
  return renderGame(gameId);
}

async function renderGame(gameId) {
  if (!isGameId(gameId)) return renderBackendError('That game link doesn\u2019t look right.');
  scheduleGameRefresh(gameId);
  try {
    const game = await api(`/api/games/${gameId}`);
    paintGame(gameId, game);
  } catch (error) {
    renderBackendError(error.message);
  }
}

function paintGameHeader(status, role, game) {
  if (status === 'settled') {
    const won = winnerIsYou(game, role);
    return { title: won ? 'You won.' : game.winner === 'creator' ? `${capitalize(game.creator?.side)} took it.` : 'Game over.', loading: false };
  }
  if (role === 'creator' && game.status === 'waiting_for_player_b') return { title: 'Your game is ready.', loading: false };
  if (game.status === 'joined' || game.status === 'first_revealed' || game.status === 'reveal_broadcast' || game.status === 'settlement_broadcast') return { title: "It's on.", loading: false };
  if (game.canJoin) return { title: "You're in.", loading: false };
  return { title: 'Locking it in.', loading: true };
}

async function paintGame(gameId, game) {
  const role = detectRole(game);
  const yourSide = role === 'creator' ? game.creator?.side : role === 'joiner' ? (game.creator?.side === 'even' ? 'odd' : 'even') : null;
  const header = paintGameHeader(game.status, role, game);
  const joinerView = role === 'joiner' || (role === 'viewer' && game.canJoin);
  const active = !['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status);
  void forgetRevealSecret(gameId, !active);
  const myPendingReveal = (game.pendingReveals ?? []).find((item) => item.role === role) ?? null;
  const myPendingSafety = (game.pendingSafety ?? []).find((item) => item.role === role) ?? null;
  const revealMine = (game.canReveal || Boolean(myPendingReveal)) && (role === 'creator' || role === 'joiner') && !isMyReveal(game, role);
  const waiting = active && !joinerView && !revealMine;

  app.innerHTML = `
    <a class="back" href="/">Exit</a>
    <section class="panel" aria-label="Game">
      <div class="panel-head">
        ${header.loading ? '<div class="header-loading"><span class="spinner large confirm" aria-hidden="true"></span><h2>Locking it in</h2></div>' : `<h2>${header.title}</h2>`}
      </div>
      <div class="game-body">
        ${gameDetails(game)}
        ${active ? (joinerView ? joinSection(game, yourSide ?? (game.creator?.side === 'even' ? 'odd' : 'even')) : '') + inviteBox(game, waiting) + (revealMine ? revealSection(game, myPendingReveal) : '') : ''}
        ${resultOverlay(game, role)}
        ${safetySection(game, role, myPendingSafety)}
        ${terminalSection(game)}
      </div>
    </section>`;

  await bindJoin(gameId, game);
  bindReveal(gameId);
  bindShare();
  bindSafety(gameId, game, myPendingSafety);
  bindRecoveryCountdown(recoveryFromGame(game), () => refreshGame(gameId));
  bindPlayAgain();
  if (!active) stopGameRefresh();
}

function recoveryFromGame(game) {
  if (!game.safetyAction && !game.automaticAction) return null;
  return { ready: game.automaticAction ? game.automaticReady : game.safetyReady, remainingSeconds: game.automaticAction ? game.automaticRemainingSeconds : game.safetyRemainingSeconds };
}

function inviteBox(game, waiting) {
  if (['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status)) return '';
  const waitingRow = waiting
    ? `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for your ${game.matchmaking ? 'rival' : 'friend'}</span></div>`
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
      <div class="sum-item"><small>Lock</small><strong>${escapeHtml(lockKas(amount))} KAS</strong></div>
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
            <button type="button" class="choice num" data-join-number="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
            <button type="button" class="choice num" data-join-number="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
          </div>
        </fieldset>
        <p class="fate">Each player locks ${escapeHtml(theirStake)} KAS. ${winnerSummary(theirStake)}</p>
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
      const secret = await createRevealSecret(number);
      await bindSecretToGame(gameId, secret.secretId);
      const prepared = await api(`/api/games/${gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
      } });
      showNotice('#join-notice', 'Confirm in KasWare', `Lock ${lockKas(theirStake)} KAS. Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
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
      const prepared = await api(`/api/games/${gameId}/reveal/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
        choice: secret.choice,
        nonceHex: secret.nonceHex,
      } });
      showNotice('#reveal-notice', 'Confirm in KasWare', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
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

function safetySection(game, role, pending) {
  if (game.automaticAction && ['waiting_for_player_b', 'refund_open_broadcast', 'joined', 'first_revealed'].includes(game.status)) {
    const label = game.automaticAction === 'fallback_claim' ? 'Automatic fallback claim' : 'Automatic refund';
    const remaining = game.automaticRemainingSeconds == null ? 'checking the timeout' : game.automaticReady ? 'ready; the backend will relay it' : `in about ${game.automaticRemainingSeconds}s`;
    return `<div id="game-safety" class="safety"><p class="lead">${label}</p><p class="muted-note">${escapeHtml(remaining)}. No wallet signature is required.</p></div>`;
  }
  if (pending) {
    const labels = { creator_refund: 'Cancel game' };
    const label = labels[pending.action] ?? 'Try again';
    const pendingControl = pending.retryable
      ? `<div class="actions"><button type="button" class="outline" data-action="safety" data-safety-action="${escapeHtml(pending.action)}">${escapeHtml(label)}</button></div>`
      : '<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for confirmation</span></div>';
    return `<div id="game-safety" class="safety">${pendingControl}</div>`;
  }
  const control = (label) => recoveryControlHtml(recoveryFromGame(game), label, 'safety');
  const isParticipant = role === 'creator' || role === 'joiner';
  if (game.safetyAction === 'fallback_claim' && game.status === 'first_revealed') {
    if (connectedAddress() !== game.firstRevealer) return '';
    return `
      <div id="game-safety" class="safety">
        <p class="lead">If your ${game.matchmaking ? 'rival' : 'friend'} never reveals</p>
        <p class="muted-note">You can claim the pot after the wait. ${feeSummary(game.stakeKas)}</p>
        ${control('Claim pot')}
      </div>`;
  }
  if (game.safetyAction === 'creator_refund' && game.status === 'waiting_for_player_b') {
    if (role !== 'creator') return '';
    return `
      <div id="game-safety" class="safety">
        ${control('Cancel game')}
      </div>`;
  }
  return '';
}

function terminalSection(game) {
  if (game.status === 'fallback_claimed') return `<div class="notice"><strong>Pot claimed.</strong>Your ${game.matchmaking ? 'rival' : 'friend'} never revealed, so you took the pot.</div>`;
  if (game.status === 'refunded' || game.status === 'creator_refunded') return '<div class="notice"><strong>Canceled.</strong>Your stake was returned.</div>';
  if (game.status === 'refund_partial') return '<div class="notice"><strong>Partial refund.</strong>One stake was returned. The other player can still refund theirs.</div>';
  return '';
}

function bindSafety(gameId, game, pending) {
  const safetyButton = document.querySelector('[data-action="safety"]');
  if (!safetyButton || safetyButton.disabled) return;
  const safetyAction = pending?.action ?? game.safetyAction;
  safetyButton.addEventListener('click', async () => {
    safetyButton.disabled = true;
    try {
      const { provider, account } = await connectKasware('#game-safety');
      const prepared = await api(`/api/games/${gameId}/${safetyAction}/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
      } });
      showNotice('#game-safety', 'Confirm in KasWare', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/${safetyAction}/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      safetyButton.disabled = false;
      logError('safety_action_failed', { code: error.code, message: error.message });
      if (guardKaswareShortfall('#game-safety', error)) return;
      showActionError('#game-safety', error);
    }
  });
}

function showActionError(selector, error) {
  const copy = actionErrorCopy(error);
  showNotice(selector, copy.title, copy.message, 'error');
}

function actionErrorCopy(error) {
  const copy = {
    STORAGE_MASS_EXCEEDED: ['Transaction not ready', 'Your wallet needs a smaller available coin. Receive a small separate payment, then try again. Your game funds remain safe.'],
    NO_UTXOS: ['Network fee unavailable', 'This wallet needs a small separate balance to pay the network fee.'],
    NO_ORDINARY_UTXOS: ['Network fee unavailable', 'This wallet needs a small separate balance to pay the network fee.'],
    INSUFFICIENT_UTXOS: ['Not enough KAS for the network fee', 'Add a small amount of KAS to this wallet, then try again.'],
    FEE_REPRICING_FAILED: ['Network fee changed', 'The network fee changed while preparing this action. Please try again.'],
    TRANSACTION_REJECTED: ['Transaction not accepted', 'The network did not accept this action. Wait a few seconds, then try again. Your game funds remain safe.'],
  }[error.code] ?? ['Please try again', 'Something went wrong. Please try again in a few seconds. Your game funds remain safe.'];
  return { title: copy[0], message: copy[1] };
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
  return Promise.resolve(kaswareSignPskt(provider, txJson))
    .then((signed) => {
      logInfo('kasware_sign_result', { returned: typeof signed === 'string' && signed.length > 0 });
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
  const body = address.startsWith('kaspatest:') ? address.slice('kaspatest:'.length) : address;
  return `${body.slice(0, 6)}\u2026${body.slice(-4)}`;
}

function capitalize(word) { return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''; }

function scheduleGameRefresh(gameId) {
  if (!window.__gameRefreshStarted) {
    window.__gameRefreshStarted = true;
    window.__gameRefreshTimer = setInterval(() => { void refreshGame(gameId); }, 3500);
  }
  window.__gameStatus = undefined;
}

function stopGameRefresh() {
  if (window.__gameRefreshTimer) clearInterval(window.__gameRefreshTimer);
  window.__gameRefreshTimer = undefined;
  window.__gameRefreshStarted = false;
}

async function refreshGame(gameId) {
  try {
    if (!(location.pathname === '/game' || location.pathname === '/join')) return;
    if ((params.get('id') ?? params.get('game')) !== gameId) return;
    const game = await api(`/api/games/${gameId}`);
    const signature = gameSignature(game);
    if (window.__gameStatus === signature) return;
    window.__gameStatus = signature;
    await paintGame(gameId, game);
  } catch {
    // A transient refresh may race a broadcast; the next tick retries.
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
  logInfo('kasware_connect_start', { selector });
  showNotice(selector, 'Connecting to KasWare', 'Confirm the connection in your wallet.', '');
  const accounts = await provider.requestAccounts().catch((error) => {
    logError('kasware_request_accounts_failed', { message: error?.message });
    return null;
  });
  const address = Array.isArray(accounts) ? accounts[0] : accounts;
  if (!address) {
    logWarn('kasware_connection_rejected');
    throw new Error('KasWare connection was not approved');
  }
  let publicKey = await provider.getPublicKey();
  let network = await provider.getNetwork();
  logDebug('kasware_session', { network, hasPublicKey: Boolean(publicKey) });
  if (network !== KASWARE_NETWORK) {
    if (typeof provider.switchNetwork !== 'function') {
      logError('kasware_network_unsupported', { network, expected: KASWARE_NETWORK });
      throw new Error(`Switch KasWare to ${NETWORK}`);
    }
    logInfo('kasware_switch_network', { from: network, to: KASWARE_NETWORK });
    await provider.switchNetwork(KASWARE_NETWORK);
    network = await provider.getNetwork();
    if (network !== KASWARE_NETWORK) {
      logError('kasware_network_switch_failed', { network, expected: KASWARE_NETWORK });
      throw new Error(`Switch KasWare to ${NETWORK}`);
    }
  }
  if (!address.startsWith('kaspatest:') || !/^[0-9a-f]{64}$|^(02|03)[0-9a-f]{64}$/i.test(publicKey ?? '')) {
    logError('kasware_invalid_account', { testnet: address.startsWith('kaspatest:'), publicKeyLength: publicKey?.length });
    throw new Error('KasWare did not return a valid testnet account');
  }
  if (publicKey.length === 66) publicKey = publicKey.slice(2);
  if (typeof provider.signPskt !== 'function') {
    logError('kasware_signing_unavailable');
    throw new Error('KasWare transaction signing is unavailable');
  }
  logInfo('kasware_connected', { network: KASWARE_NETWORK });
  watchKasware(provider);
  return { provider, account: { address, publicKey } };
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
  node.innerHTML = `<div class="notice ${kind}"><strong>${escapeHtml(title)}</strong>${body}</div>`;
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
