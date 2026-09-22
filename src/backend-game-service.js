import { normalizePublicKey, prepareCreateGame } from './create-game.js';
import { verifySignedCreationSafeJson } from './genesis-transaction.js';
import { deriveGameInstance } from './covenant/kasodds.mjs';
import { verifySignedJoinTransaction } from './join-transactions.js';
import { DEFAULT_RELAY_FLOOR_RATE } from './fee-policy.js';
import { prepareRevealTransaction, prepareTerminalTransaction, prepareCovenantOnlyTransaction, prepareOpenRefundTransaction, serializeTerminalTransaction, verifySignedTerminalTransaction } from './terminal-transactions.js';
import { parityOutcome, verifyRevealPreimage } from './reveal.js';
import { createTransactionIntent } from './transaction-intent.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { FALLBACK_CLAIM_DAA_OFFSET, FIVE_MINUTE_DAA_OFFSET, NO_REVEAL_REFUND_DAA_OFFSET, DAA_PER_SECOND, safetyReadiness } from './terminal-actions.js';
import { resolveEconomics, AUTOMATION_FEE_SOMPI, MIN_STAKE_KAS, PROTOCOL_VERSION, ProtocolError, UNCONFIRMED_INPUT_DAA_SCORE, validateGameFeePublicKey, validateGameId } from './protocol.js';
import { DEFAULT_NETWORK_PROFILE } from './network.js';
import { noopMetrics } from './metrics.js';
import { EphemeralPreparations } from './ephemeral-preparations.js';
import { KaspaChainAdapter } from './chain-adapter.js';
import { isMinedDaaScore } from './kaspa-adapter.js';
import { logger } from './logger.js';
import { assertSignedTransactionFee, signedTransactionFeeDiagnostics } from './transaction-mass.js';
import { TerminalFundingSelector } from './terminal-funding.js';
import { deriveAvailableActions, deriveGameStatus, projectTerminalTransactions } from './game-projection.js';
import { assignedSide as matchmakingAssignedSide, findMatchPlayer, MatchmakingService } from './matchmaking-service.js';

// A broadcast transaction that has not been observed on-chain yet keeps the
// player's button locked. After this window we let the player try again while
// keeping the original attempt: the first answer the chain gives wins.
const PENDING_RETRY_MS = 60_000;

// A first-reveal preparation reserves the lead slot while the player is at their
// wallet. If the preparation is never broadcast, the slot returns to the pair so
// the other player can still lead the reveal.
const REVEAL_CLAIM_TTL_MS = 120_000;

// A chained transaction can be rejected for a few seconds until its parent is
// anchored, or right after a reorg. Those rejections are transient, so the same
// signed transaction is retried with backoff before the error reaches the player.
const SUBMISSION_RETRY_ATTEMPTS = 4;
const SUBMISSION_RETRY_BASE_MS = 2_000;
const RETRYABLE_SUBMISSION_PATTERN = /orphan|mempool|double.?spend|reorg|not (?:yet )?(?:synced|finalized)|conflict|out of order/i;

// Creation operation states that gate the join broadcast: the join may only go
// out once the creation reached the node, and must be dropped if it never did.
const CREATION_STATE = Object.freeze({ BROADCAST: 'broadcast', SUBMITTING: 'submitting', FAILED: 'failed' });

// Application use cases for the KasOdds game.
//
// The browser is a thin client: it owns the hidden number and nonce (never sent
// here until reveal) and KasWare signatures, while this service owns chain
// communication. It prepares transactions, verifies signed SafeJSON, and
// broadcasts to the node. The service therefore never learns a player's number
// before both commitments are confirmed on-chain and the number is public.
export class BackendGameService {
  constructor({ rpc, chain, store, metrics = noopMetrics, ephemeral = new EphemeralPreparations(), gameFeePublicKey, network = DEFAULT_NETWORK_PROFILE, submissionRetryBaseMs = SUBMISSION_RETRY_BASE_MS, log = logger, bot = null, roomCodeGenerator }) {
    this.chain = chain ?? new KaspaChainAdapter({ rpc });
    this.funding = null;
    this.network = network;
    this.submissionRetryBaseMs = submissionRetryBaseMs;
    this.log = log;
    this.bot = bot;
    this.matchmaking = new MatchmakingService({ store, metrics, logPlayer: (event, address, fields) => this.#logPlayer(event, address, fields), logger: log, addressPrefix: network.addressPrefix, bot, roomCodeGenerator });
    this.store = store;
    this.metrics = metrics;
    this.ephemeral = ephemeral;
    // Reveal is two ordered on-chain steps that players trigger independently, so
    // the pair is serialised per game: `revealClaims` reserves the lead slot while
    // a player is preparing, and `gameLocks` makes the ordering decision atomic.
    this.revealClaims = new Map();
    this.gameLocks = new Map();
    this.gameFeePublicKey = gameFeePublicKey ? validateGameFeePublicKey(gameFeePublicKey) : null;
  }

  // Static config only: deliberately does not touch the node, so booting the
  // client never blocks on a wRPC round-trip.
  networkStatus() {
    return {
      network: this.network.id, addressPrefix: this.network.addressPrefix, kaswareNetwork: this.network.kaswareNetwork,
      protocolVersion: PROTOCOL_VERSION, gameFeePublicKey: this.gameFeePublicKey, explorerUrl: this.network.explorerUrl,
      botAvailable: Boolean(this.bot), botStakeKas: this.bot ? MIN_STAKE_KAS : null,
    };
  }

  // --- Matchmaking ---------------------------------------------------------

  async joinMatchmaking(input) {
    return this.matchmaking.join(input);
  }

  async offerBot(matchId, input) {
    return this.matchmaking.offerBot(matchId, input);
  }

  async createRoom(input) {
    return this.matchmaking.createRoom(input);
  }

  async joinRoom(matchId, input) {
    return this.matchmaking.joinRoom(matchId, input);
  }

  async joinRoomByCode(code, input) {
    return this.matchmaking.joinRoomByCode(code, input);
  }

  async matchmakingStatus(matchId, address) {
    return this.matchmaking.status(matchId, address);
  }

  async leaveMatchmaking(matchId, address) {
    return this.matchmaking.leave(matchId, address);
  }

  // --- Game lifecycle ------------------------------------------------------

  async prepareCreation(input) {
    if (!this.gameFeePublicKey) throw new ProtocolError('INVALID_GAME_FEE', 'Game fee recipient is not configured yet (GAME_FEE_ADDRESS)');
    if (input.matchId) await this.#validateMatchCreation(input);
    const currentDaaScore = await this.chain.getCurrentDaaScore();
    const request = prepareCreateGame({
      network: this.network.id,
      creatorAddress: input.creatorAddress,
      creatorPublicKey: input.creatorPublicKey,
      creatorCommitment: input.creatorCommitment,
      deadlineDaa: currentDaaScore + FIVE_MINUTE_DAA_OFFSET,
      side: input.side,
      stakeKas: input.stakeKas,
      feeSompi: 0n,
      gameFeePublicKey: this.gameFeePublicKey,
    });
    this.#logPlayer('creation_prepare', request.creatorAddress, { matchId: input.matchId ?? null });
    const prepared = await this.chain.prepareCreation(request);
    logPreparedTransaction('creation', prepared);
    await this.store.savePrepared({
      preparedHash: prepared.preparedHash,
      request: serializeRequest(request),
      prepared: serializePrepared(prepared),
      createdAt: new Date().toISOString(),
      ...(input.matchId ? { matchId: input.matchId } : {}),
    });
    this.metrics.recordGameEvent('creation_prepared');
    return { network: this.network.id, preparedHash: prepared.preparedHash, txJson: prepared.txJson, feeSompi: String(prepared.feeSompi), deadlineDaa: String(request.deadlineDaa), changeScriptPublicKey: prepared.policy?.changeScriptPublicKey };
  }

  async submitCreation({ preparedHash, signedTxJson, matchId }) {
    const record = await this.store.loadPrepared(preparedHash);
    if (!record) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Prepared transaction was not found or has expired');
    const request = deserializeRequest(record.request);
    const prepared = deserializePrepared(record.prepared);
    if (Boolean(record.matchId) !== Boolean(matchId) || (matchId && record.matchId !== matchId)) {
      throw new ProtocolError('MATCH_NOT_READY', 'This creation does not belong to the matchmaking session');
    }
    const operationId = operationKey('creation', preparedHash);
    const existing = await this.store.loadOperation(operationId);
    let transactionId;
    if (existing?.status === 'broadcast') {
      transactionId = existing.transactionId;
    } else {
      verifySignedCreationSafeJson({ preparedTxJson: prepared.txJson, signedTxJson, request, policy: prepared.policy });
      transactionId = await this.#submitOperation({
        operationId, action: 'creation', gameId: null, preparedHash,
        metadata: { matchId: matchId ?? null },
        transactionId: transactionIdFromSafeJson(signedTxJson),
        submit: () => this.#submitSignedTransaction('creation', signedTxJson, prepared.feerate),
      });
    }
    this.#logPlayer('creation_submit', request.creatorAddress, { gameId: transactionId, matchId: matchId ?? null });
    await this.#saveGame({
      gameId: transactionId,
      network: this.network.id,
      protocolVersion: PROTOCOL_VERSION,
      status: 'broadcast',
      request: record.request,
      prepared: record.prepared,
      creationPreparedHash: preparedHash,
      createdAt: new Date().toISOString(),
      ...(matchId ? { matchId } : {}),
    });
    await this.#updateOperation(operationId, { gameId: transactionId });
    if (matchId) await this.#attachMatchGame(matchId, request, transactionId);
    this.metrics.recordGameEvent('creation_submitted');
    return { gameId: transactionId, network: this.network.id, status: 'broadcast' };
  }

  async prepareJoin(gameId, input) {
    const id = validateGameId(gameId);
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    if (gameRecord.join?.transactionId) throw new ProtocolError('GAME_ALREADY_JOINED', 'Another player already joined this game');
    this.#assertJoinable(gameRecord);
    if (gameRecord.matchId && input.matchId !== gameRecord.matchId) throw new ProtocolError('MATCH_NOT_READY', 'This game belongs to a different matchmaking session');
    if (gameRecord.matchId) await this.#validateMatchJoin(gameRecord.matchId, id, input.joinerAddress);
    const request = deserializeRequest(gameRecord.request);
    const creation = deserializePrepared(gameRecord.prepared);
    const joinerPublicKey = normalizePublicKey(input.joinerPublicKey, 'joiner public key');
    const joinerCommitment = normalizeHex(input.joinerCommitment, 32, 'joiner commitment');
    if (typeof input.joinerAddress !== 'string' || !input.joinerAddress.startsWith(`${this.network.addressPrefix}:`)) {
      throw new ProtocolError('INVALID_ADDRESS', 'Player B must use a wallet on the configured network');
    }
    this.#logPlayer('join_prepare', input.joinerAddress, { gameId: id, matchId: input.matchId ?? null });
    // The creation reaches the node before the match exposes its game id, so the
    // join can be built against the creator's output without waiting for a block.
    await this.#assertCreationBroadcast(gameRecord);
    const currentDaaScore = await this.chain.getCurrentDaaScore();
    if (currentDaaScore >= request.deadlineDaa) throw new ProtocolError('GAME_EXPIRED', 'The joining deadline has passed');

    const economics = resolveEconomics(request);
    const joined = deriveGameInstance({
      creatorPubkey: request.creatorPublicKey,
      creatorCommit: request.creatorCommitment,
      joinerPubkey: joinerPublicKey,
      joinerCommit: joinerCommitment,
      stakeSompi: economics.stakeSompi,
      deadlineDaa: request.deadlineDaa,
      creatorEven: request.creatorEven,
         gameWalletHash: request.gameWalletHash,
         settleFee: request.settleFeeSompi,
         status: 1,
    }, { addressPrefix: this.network.addressPrefix });
    const prepared = await this.chain.prepareJoin({
      request: {
        network: this.network.id,
        gameId: id,
        joinerAddress: input.joinerAddress,
        joinerPublicKey,
        joinerCommitment,
      },
      game: {
        stakeSompi: request.stakeSompi,
        currentInput: this.#unconfirmedCreationInput(id, request, creation),
        currentCovenantId: creation.covenantId,
        continuationScriptPublicKey: `0000${joined.p2shScript.toString('hex')}`,
        continuationCovenant: { authorizingInput: 0, covenantId: creation.covenantId },
      },
    });
    logPreparedTransaction('join', prepared);
    await this.store.saveJoinPrepared({
      preparedHash: prepared.preparedHash,
      gameId: id,
      joinerAddress: input.joinerAddress,
      joinerPublicKey,
      joinerCommitment,
      txJson: prepared.txJson,
      feeSompi: String(prepared.feeSompi),
      priorityFeerate: prepared.feerate,
      joinedAddress: joined.address,
      joinedScriptPublicKey: `0000${joined.p2shScript.toString('hex')}`,
      joinedRedeemScript: joined.redeemScript.toString('hex'),
      covenantId: creation.covenantId,
      createdAt: new Date().toISOString(),
      ...(gameRecord.matchId ? { matchId: gameRecord.matchId } : {}),
    });
    this.metrics.recordGameEvent('join_prepared');
    return { gameId: id, preparedHash: prepared.preparedHash, txJson: prepared.txJson, stakeSompi: String(request.stakeSompi), feeSompi: String(prepared.feeSompi), verification: createTransactionIntent({ action: 'join', txJson: prepared.txJson, feeSompi: prepared.feeSompi }) };
  }

  async submitJoin(gameId, input) {
    const id = validateGameId(gameId);
    // A join and a creator refund spend the same creator output, so the two
    // decisions are serialized per game: whichever is accepted first closes the
    // other path deterministically.
    return this.#withGameLock(id, () => this.#submitJoinLocked(id, input));
  }

  async #submitJoinLocked(id, { preparedHash, signedTxJson }) {
    const prepared = await this.store.loadJoinPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Join preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    this.#assertJoinable(gameRecord);
    if (gameRecord.matchId && prepared.matchId !== gameRecord.matchId) throw new ProtocolError('MATCH_NOT_READY', 'This join does not belong to the matchmaking session');
    // A re-signed creation changes the game id; the prepared join must belong to
    // the game the match is currently pointing at.
    if (gameRecord.matchId) await this.#validateMatchJoin(gameRecord.matchId, id, prepared.joinerAddress);
    if (gameRecord.join?.transactionId) throw new ProtocolError('GAME_ALREADY_JOINED', 'Another player already joined this game');
    // Broadcast the join only once its creation is on the network: the chained
    // transaction becomes minable in the DAA score after the creation.
    await this.#assertCreationBroadcast(gameRecord);
    const operationId = operationKey('join', preparedHash);
    const existing = await this.store.loadOperation(operationId);
    let transactionId;
    if (existing?.status === 'broadcast') {
      transactionId = existing.transactionId;
    } else {
      verifySignedJoinTransaction({ preparedTxJson: prepared.txJson, signedTxJson });
      transactionId = await this.#submitOperation({
        operationId, action: 'join', gameId: id, preparedHash,
        metadata: { joinerAddress: prepared.joinerAddress, joinerPublicKey: prepared.joinerPublicKey, joinerCommitment: prepared.joinerCommitment, joinedAddress: prepared.joinedAddress, joinedScriptPublicKey: prepared.joinedScriptPublicKey, joinedRedeemScript: prepared.joinedRedeemScript, covenantId: prepared.covenantId },
        transactionId: transactionIdFromSafeJson(signedTxJson),
        submit: () => this.#submitSignedTransaction('join', signedTxJson, prepared.priorityFeerate),
      });
    }
    this.#logPlayer('join_submit', prepared.joinerAddress, { gameId: id, transactionId });
    await this.#saveGame({
      ...gameRecord,
      status: 'join_broadcast',
      join: {
        transactionId,
        preparedHash,
        joinerAddress: prepared.joinerAddress,
        joinerPublicKey: prepared.joinerPublicKey,
        joinerCommitment: prepared.joinerCommitment,
        joinedAddress: prepared.joinedAddress,
        joinedScriptPublicKey: prepared.joinedScriptPublicKey,
        joinedRedeemScript: prepared.joinedRedeemScript,
        covenantId: prepared.covenantId,
        submittedAt: new Date().toISOString(),
      },
    });
    this.metrics.recordGameEvent('join_submitted');
    return { gameId: id, transactionId, status: 'join_broadcast' };
  }

  // Reveal is two ordered on-chain steps: the first spends the joined escrow and
  // continues the covenant, the second spends that continuation and settles. A
  // player triggers either step on their own, so the pair is serialised here: one
  // caller leads and the other waits for the lead to confirm. The waiting caller
  // never touches the escrow the lead already spent, and never sees the wait.
  async prepareReveal(gameId, input) {
    const id = validateGameId(gameId);
    return this.#withGameLock(id, () => this.#prepareRevealLocked(id, input));
  }

  async #prepareRevealLocked(id, input) {
    let gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    gameRecord = await this.#refreshActionState(gameRecord);
    if (gameRecord.status === 'settled') throw new ProtocolError('GAME_SETTLED', 'This game is already settled');
    const request = deserializeRequest(gameRecord.request);
    const economics = resolveEconomics(request);
    const publicKey = normalizePublicKey(input.playerPublicKey, 'player public key');
    const player = this.#player(gameRecord, request, input.playerAddress, publicKey);
    this.#logPlayer('reveal_prepare', player.address, { gameId: id, role: player.role });
    const choice = Number(input.choice);
    const nonceHex = normalizeHex(input.nonceHex, 32, 'reveal nonce');
    if (!Number.isInteger(choice) || (choice !== 0 && choice !== 1)) throw new ProtocolError('INVALID_REVEAL', 'Choice must be zero or one');
    if (!verifyRevealPreimage({ commitment: player.commitment, choice, nonceHex })) throw new ProtocolError('INVALID_REVEAL', 'Reveal does not match the saved commitment');

    const reveals = gameRecord.reveals ?? [];
    const confirmedReveals = reveals.filter((reveal) => reveal.status === 'confirmed');
    if (confirmedReveals.some((reveal) => reveal.playerAddress === player.address)) throw new ProtocolError('ALREADY_REVEALED', 'This player already revealed');
    const pendingMine = reveals.some((reveal) => reveal.status !== 'confirmed'
      && reveal.playerAddress === player.address && !isPendingRetryable(reveal));
    if (pendingMine) throw new ProtocolError('ACTION_PENDING', 'The previous reveal is still confirming');
    const first = confirmedReveals[0] ?? null;
    if (!first) this.#assertMayLeadReveal(id, reveals, player);
    let current;
    try {
      current = await this.#currentGameUtxo(gameRecord, request, first);
    } catch (error) {
      throw asChainWait(error);
    }
    if (first) logger.info('settlement_reveal_parent', { gameId: id, transactionId: current.transactionId, parentBlockDaaScore: String(current.entry.blockDaaScore ?? 0), currentDaaScore: String(current.currentDaaScore) });
    const state = this.#revealGameState(id, gameRecord, request, current, confirmedReveals);

    const { continuation, winner } = this.#revealContinuation({ request, gameRecord, player, choice, publicKey, first });
    const payoutRole = winner;
    const payoutPublicKey = payoutRole === 'creator' ? request.creatorPublicKey : payoutRole === 'joiner' ? gameRecord.join.joinerPublicKey : publicKey;
    const build = (funding) => prepareRevealTransaction({
      game: state,
      caller: player.address,
      currentDaaScore: current.currentDaaScore,
      secret: { gameId: id, player: player.address, choice, nonceHex },
      gameInput: { ...current.entry, transactionId: current.transactionId, index: 0, covenantId: gameRecord.join.covenantId, redeemScript: current.redeemScript },
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationCovenant: continuation ? { authorizingInput: 0, covenantId: gameRecord.join.covenantId } : undefined,
      recipientScriptPublicKey: winner ? playerScriptPublicKey(payoutPublicKey) : undefined,
      feeScriptPublicKey: economics.gameFeeSompi > 0n ? playerScriptPublicKey(request.gameFeePublicKey) : undefined,
      walletPublicKey: request.gameFeePublicKey,
      feeInputs: funding.inputs,
      feeSompi: funding.feeSompi,
      change: funding.change,
      publicKey,
      payoutPublicKey,
    });
    const funding = await this.#actionFunding(player.address, build);
    const prepared = build(funding);
    const txJson = serializeTerminalTransaction(prepared);
    const preparedHash = Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex');
    logPreparedTransaction('reveal', { ...funding, txJson });
    this.ephemeral.save({
      preparedHash,
      action: 'reveal',
      gameId: id,
      playerAddress: player.address,
      role: player.role,
      choice,
      txJson,
      transaction: prepared.transaction,
      feeSompi: String(funding.feeSompi),
      priorityFeerate: funding.priorityFeerate,
      continuationAddress: continuation?.address,
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationRedeemScript: continuation?.redeemScript.toString('hex'),
      winner,
      payoutAddress: payoutRole === 'creator' ? request.creatorAddress : payoutRole ? gameRecord.join.joinerAddress : undefined,
      createdAt: new Date().toISOString(),
    });
    // Reserve only once a lead reveal is actually built, so a failed preparation
    // never blocks the rival.
    if (!first) this.#reserveRevealClaim(id, player);
    this.metrics.recordGameEvent('reveal_prepared');
    return { gameId: id, preparedHash, txJson, feeSompi: String(funding.feeSompi), stage: first ? 'settlement' : 'first_reveal', verification: createTransactionIntent({ action: 'reveal', txJson, feeSompi: funding.feeSompi }) };
  }

  async submitReveal(gameId, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = this.ephemeral.load(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== 'reveal') throw new ProtocolError('PREPARATION_NOT_FOUND', 'Reveal preparation was not found or has expired');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    const operationId = operationKey('reveal', preparedHash);
    try {
      const existing = await this.store.loadOperation(operationId);
      let transactionId;
      if (existing?.status === 'broadcast') {
        transactionId = existing.transactionId;
      } else {
        verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
        transactionId = await this.#submitOperation({
          operationId, action: 'reveal', gameId: id, preparedHash,
          transactionId: transactionIdFromSafeJson(signedTxJson),
          submit: () => this.#submitSignedTransaction('reveal', signedTxJson, prepared.priorityFeerate),
        });
      }
      const reveal = {
        transactionId,
        preparedHash,
        playerAddress: prepared.playerAddress,
        role: prepared.role,
        choice: prepared.choice,
        status: 'broadcast',
        continuationAddress: prepared.continuationAddress,
        continuationScriptPublicKey: prepared.continuationScriptPublicKey,
        continuationRedeemScript: prepared.continuationRedeemScript,
        winner: prepared.winner,
        payoutAddress: prepared.payoutAddress,
        submittedAt: new Date().toISOString(),
      };
      this.#logPlayer('reveal_submit', prepared.playerAddress, { gameId: id, transactionId, role: prepared.role });
      await this.#saveGame({ ...gameRecord, status: prepared.winner ? 'settlement_broadcast' : 'reveal_broadcast', reveals: [...(gameRecord.reveals ?? []), reveal] });
      this.metrics.recordGameEvent('reveal_submitted');
      return { gameId: id, transactionId, status: prepared.winner ? 'settlement_broadcast' : 'reveal_broadcast' };
    } finally {
      // The broadcast reveal now records who leads; a failed attempt releases the
      // slot so the other player can still lead.
      this.#releaseRevealClaim(id, prepared.playerAddress);
    }
  }

  // Permissionless timeout keeper. Every decision is re-read from the chain
  // immediately before construction, so a competing reveal wins naturally.
  async settleAutomaticGames() {
    if (typeof this.store.listGames !== 'function') return { attempted: 0, skipped: 0 };
    const games = await this.store.listGames();
    let attempted = 0;
    for (const record of games) {
      try {
        const request = deserializeRequest(record.request);
        let current = await this.#refreshActionState(record);
        // A creator who cancelled and left the page stops polling, so the
        // background keeper confirms the refund (and completes the game) here.
        current = await this.#refreshSafetyState(current);
        if (current.automaticSettlement?.status === 'broadcast') {
          await this.#refreshAutomaticSettlement(current, request);
          continue;
        }
        const reveals = (current.reveals ?? []).filter((item) => item.status === 'confirmed');
        if (reveals.length > 1) continue;
        if (['settled', 'creator_refunded', 'refunded', 'fallback_claimed'].includes(current.status)) {
          await this.#completeGame(current, current.status);
          continue;
        }
        if (!current.join) {
          const economics = resolveEconomics(request);
          const open = await this.#openCreationUtxo(current.gameId, request, deserializePrepared(current.prepared));
          if (open.currentDaaScore < request.deadlineDaa) continue;
          const refundPayout = economics.refundOpenPayoutSompi;
          const prepared = prepareOpenRefundTransaction({
            gameInput: { ...open.entry, transactionId: current.gameId, index: 0, amount: economics.lockSompi, covenantId: deserializePrepared(current.prepared).covenantId, redeemScript: request.covenantRedeemScript },
            stakeSompi: request.stakeSompi,
            settleFeeSompi: request.settleFeeSompi,
            deadlineDaa: request.deadlineDaa,
            creatorPublicKey: request.creatorPublicKey,
           });
           const txJson = serializeTerminalTransaction(prepared);
           const feeDiagnostics = await this.#validateAutomaticFee('refund_open', txJson, request.settleFeeSompi);
           const operationId = operationKey('automatic_settlement', Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex'));
           const transactionId = await this.#submitOperation({
             operationId, action: 'automatic_settlement', gameId: record.gameId, preparedHash: operationId,
             metadata: { status: 'refund_open_broadcast', settlement: { action: 'refund_open', txJson, payouts: [{ outputIndex: 0, value: String(refundPayout), scriptPublicKey: playerScriptPublicKey(request.creatorPublicKey), address: request.creatorAddress }] } },
             submit: () => this.chain.submitSafeJson(txJson).then(validateGameId),
           });
          await this.#saveGame({ ...current, status: 'refund_open_broadcast', automaticSettlement: {
            action: 'refund_open', transactionId, txJson, status: 'broadcast', submittedAt: new Date().toISOString(),
            payouts: [{ outputIndex: 0, value: String(refundPayout), scriptPublicKey: playerScriptPublicKey(request.creatorPublicKey), address: request.creatorAddress }],
          } });
          this.metrics.recordGameEvent('refund_open_submitted');
           logger.info('automatic_settlement_submitted', { gameId: record.gameId, action: 'refund_open', transactionId, feeSompi: String(request.settleFeeSompi), mass: feeDiagnostics.mass, requiredFeeSompi: String(feeDiagnostics.requiredFeeSompi), feeRate: feeDiagnostics.effectiveFeeRate });
          attempted += 1;
          continue;
        }
        const economics = resolveEconomics(request);
        const covenant = await this.#currentGameUtxo(current, request, reveals[0] ?? null);
        const age = covenant.currentDaaScore - BigInt(covenant.entry.blockDaaScore);
        let action;
        let args;
        let outputs;
        let payoutAddresses;
        if (reveals.length === 0 && age >= NO_REVEAL_REFUND_DAA_OFFSET) {
          action = 'refund_all';
          args = [request.creatorPublicKey, current.join.joinerPublicKey];
          const refund = economics.refundAllPayoutSompi;
          outputs = [
            { value: refund, scriptPublicKey: playerScriptPublicKey(request.creatorPublicKey) },
            { value: refund, scriptPublicKey: playerScriptPublicKey(current.join.joinerPublicKey) },
          ];
          payoutAddresses = [request.creatorAddress, current.join.joinerAddress];
        } else if (reveals.length === 1 && age >= FALLBACK_CLAIM_DAA_OFFSET) {
          action = 'fallback_claim';
          const first = reveals[0];
          args = [first.role === 'creator' ? request.creatorPublicKey : current.join.joinerPublicKey, request.gameFeePublicKey];
          const winnerKey = args[0];
          outputs = [{ value: economics.automaticFallbackPayoutSompi, scriptPublicKey: playerScriptPublicKey(winnerKey) }];
          if (economics.gameFeeSompi > 0n) outputs.push({ value: economics.gameFeeSompi, scriptPublicKey: playerScriptPublicKey(request.gameFeePublicKey) });
          payoutAddresses = [first.role === 'creator' ? request.creatorAddress : current.join.joinerAddress];
        } else continue;

        const prepared = prepareCovenantOnlyTransaction({
          action,
          gameInput: { ...covenant.entry, transactionId: covenant.transactionId, index: 0, amount: economics.potSompi, covenantId: current.join.covenantId, redeemScript: covenant.redeemScript },
          inputSequence: action === 'fallback_claim' ? FALLBACK_CLAIM_DAA_OFFSET : NO_REVEAL_REFUND_DAA_OFFSET,
          args,
          outputs,
         });
         const txJson = serializeTerminalTransaction(prepared);
          const feeDiagnostics = await this.#validateAutomaticFee(action, txJson, prepared.feeSompi);
          const operationId = operationKey('automatic_settlement', Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex'));
          const transactionId = await this.#submitOperation({
            operationId, action: 'automatic_settlement', gameId: record.gameId, preparedHash: operationId,
            metadata: { status: `${action}_broadcast`, settlement: { action, txJson, payouts: outputs.map((output, outputIndex) => ({ outputIndex, value: String(output.value), scriptPublicKey: output.scriptPublicKey, address: payoutAddresses[outputIndex] })) } },
            submit: () => this.chain.submitSafeJson(txJson).then(validateGameId),
          });
        await this.#saveGame({ ...current, status: `${action}_broadcast`, automaticSettlement: {
          action, transactionId, txJson, status: 'broadcast', submittedAt: new Date().toISOString(),
          payouts: outputs.map((output, outputIndex) => ({ outputIndex, value: String(output.value), scriptPublicKey: output.scriptPublicKey,
            address: payoutAddresses[outputIndex] })),
        } });
        this.metrics.recordGameEvent(`${action}_submitted`);
         logger.info('automatic_settlement_submitted', { gameId: record.gameId, action, transactionId, feeSompi: String(prepared.feeSompi), mass: feeDiagnostics.mass, requiredFeeSompi: String(feeDiagnostics.requiredFeeSompi), feeRate: feeDiagnostics.effectiveFeeRate });
        attempted += 1;
      } catch (error) {
        if (!['ACTION_NOT_CONFIRMED', 'GAME_NOT_FOUND', 'GAME_NOT_OPEN', 'GAME_NOT_CONFIRMED'].includes(error?.code)) {
           logger.warn('automatic_settlement_failed', { gameId: record.gameId, code: error?.code, message: error?.message, ...feeLogFields(error?.transactionDiagnostics) });
        }
      }
    }
    return { attempted, skipped: games.length - attempted };
  }

  // Wait for the earliest known timeout. Once a timeout is due, keep checking
  // every 30 seconds until the chain accepts either the automatic spend or a
  // normal reveal settlement.
  async automaticSettlementDelayMs() {
    if (typeof this.store.listGames !== 'function') return null;
    const games = await this.store.listGames();
    if (games.length === 0) return null;
    const currentDaa = await this.#currentDaaScore();
    let nextDaa = null;
    let pollSoon = false;
    for (const record of games) {
      if (record.automaticSettlement?.status === 'confirmed' || ['settled', 'creator_refunded', 'refunded', 'fallback_claimed'].includes(record.status)) continue;
      if (record.automaticSettlement?.status === 'broadcast') {
        pollSoon = true;
        continue;
      }
      if (!record.join) {
        const readyAt = BigInt(deserializeRequest(record.request).deadlineDaa);
        if (readyAt <= currentDaa) pollSoon = true;
        else if (nextDaa === null || readyAt < nextDaa) nextDaa = readyAt;
        continue;
      }
      const reveals = (record.reveals ?? []).filter((item) => item.status === 'confirmed');
      if (reveals.length > 1) continue;
      let active;
      try {
        active = await this.#currentGameUtxo(record, deserializeRequest(record.request), reveals[0] ?? null);
      } catch (error) {
        if (error?.code === 'ACTION_NOT_CONFIRMED' || error?.code === 'GAME_NOT_FOUND') {
          pollSoon = true;
          continue;
        }
        throw error;
      }
      const readyAt = BigInt(active.entry.blockDaaScore) + (reveals.length === 1 ? FALLBACK_CLAIM_DAA_OFFSET : NO_REVEAL_REFUND_DAA_OFFSET);
      if (readyAt <= currentDaa) pollSoon = true;
      else if (nextDaa === null || readyAt < nextDaa) nextDaa = readyAt;
    }
    if (pollSoon) return 30_000;
    if (nextDaa === null) return 300_000;
    const remainingDaa = nextDaa - currentDaa;
    return Math.max(1_000, Number(remainingDaa) * 1_000 / Number(DAA_PER_SECOND) + 1_000);
  }

  async #validateAutomaticFee(action, txJson, reservedFeeSompi) {
    const estimatedRate = await this.chain.getPriorityFeerate();
    const priorityFeerate = Number.isFinite(estimatedRate) && estimatedRate >= 0 ? estimatedRate : DEFAULT_RELAY_FLOOR_RATE;
    const diagnostics = signedTransactionFeeDiagnostics({ network: this.network.id, signedTxJson: txJson, priorityFeerate });
    if (diagnostics.paidFeeSompi < diagnostics.requiredFeeSompi) {
      const error = new ProtocolError('INSUFFICIENT_TRANSACTION_FEE', 'Embedded automatic settlement fee is below the current network fee.');
      error.transactionDiagnostics = { ...diagnostics, reservedFeeSompi: BigInt(reservedFeeSompi) };
      throw error;
    }
    logger.info('automatic_settlement_fee_validated', { action, mass: diagnostics.mass, paidFeeSompi: String(diagnostics.paidFeeSompi), requiredFeeSompi: String(diagnostics.requiredFeeSompi), feeRate: diagnostics.effectiveFeeRate });
    return diagnostics;
  }

  async #refreshAutomaticSettlement(record, request) {
    const payouts = record.automaticSettlement?.payouts ?? [];
    if (payouts.length === 0) return record;
    try {
      for (const payout of payouts) {
        await this.#expectedUtxo({ transactionId: record.automaticSettlement.transactionId, address: payout.address, scriptPublicKey: payout.scriptPublicKey, outputIndex: payout.outputIndex }, BigInt(payout.value));
      }
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return record;
      throw error;
    }
    const terminalStatus = record.automaticSettlement.action === 'fallback_claim'
      ? 'fallback_claimed'
      : record.automaticSettlement.action === 'refund_open' ? 'creator_refunded' : 'refunded';
    const saved = { ...record, status: terminalStatus, automaticSettlement: { ...record.automaticSettlement, status: 'confirmed', confirmedAt: new Date().toISOString() } };
    await this.#completeGame(saved, terminalStatus);
    return saved;
  }

  async prepareSafetyAction(gameId, action, input) {
    const id = validateGameId(gameId);
    let gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    if (action !== 'creator_refund') {
      throw new ProtocolError('ACTION_UNAVAILABLE', 'Timeout settlement is automatic and permissionless');
    }
    gameRecord = await this.#refreshActionState(gameRecord);
    gameRecord = await this.#refreshSafetyState(gameRecord);
    const request = deserializeRequest(gameRecord.request);
    const publicKey = normalizePublicKey(input.playerPublicKey, 'player public key');
    const player = action === 'creator_refund' && !gameRecord.join
      ? this.#creator(request, input.playerAddress, publicKey)
      : this.#player(gameRecord, request, input.playerAddress, publicKey);
    const pendingMine = (gameRecord.safetyActions ?? []).some((item) => item.status !== 'confirmed'
      && item.action === action && item.playerAddress === player.address && !isPendingRetryable(item));
    if (pendingMine) throw new ProtocolError('ACTION_PENDING', 'The previous recovery action is still confirming');
    this.#logPlayer(`${action}_prepare`, player.address, { gameId: id, role: player.role });
    let current;
    let covenantEntry;
    let sequence = 0n;

    if (action === 'creator_refund') {
      if (gameRecord.join) throw new ProtocolError('ACTION_UNAVAILABLE', 'Player B already joined this game');
      const creation = deserializePrepared(gameRecord.prepared);
      const economics = resolveEconomics(request);
      let open;
      try {
        open = await this.#openCreationUtxo(id, request, creation);
      } catch (error) {
        throw asChainWait(error);
      }
      current = { entry: open.entry, currentDaaScore: open.currentDaaScore, transactionId: id, redeemScript: request.covenantRedeemScript, value: economics.lockSompi };
      covenantEntry = 'refund';
    } else {
      throw new ProtocolError('UNSUPPORTED_ACTION', 'Unsupported safety action');
    }

    let preparedArgs = [publicKey];
    let preparedPayout = resolveEconomics(request).refundPayoutSompi;
    const preparedExtraOutputs = [];
    const build = (funding) => prepareTerminalTransaction({
      action: covenantEntry,
      gameInput: { ...current.entry, transactionId: current.transactionId, index: current.outputIndex ?? 0, amount: current.value, covenantId: gameRecord.join?.covenantId ?? deserializePrepared(gameRecord.prepared).covenantId, redeemScript: current.redeemScript },
      inputSequence: sequence,
      lockTime: 0n,
      args: preparedArgs,
      payoutValue: preparedPayout,
      recipientScriptPublicKey: playerScriptPublicKey(publicKey),
      extraOutputs: preparedExtraOutputs,
      feeInputs: funding.inputs,
      feeSompi: funding.feeSompi,
      change: funding.change,
    });
    const funding = await this.#actionFunding(player.address, build);
    const prepared = build(funding);
    const txJson = serializeTerminalTransaction(prepared);
    const preparedHash = Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex');
    logPreparedTransaction(action, { ...funding, txJson });
    await this.store.saveActionPrepared({
      preparedHash, action, gameId: id, playerAddress: player.address, role: player.role,
      txJson, transaction: prepared.transaction, feeSompi: String(funding.feeSompi), priorityFeerate: funding.priorityFeerate,
      createdAt: new Date().toISOString(),
    });
    this.metrics.recordGameEvent(`${action}_prepared`);
    return { gameId: id, preparedHash, txJson, feeSompi: String(funding.feeSompi), action, verification: createTransactionIntent({ action: 'refund', txJson, feeSompi: funding.feeSompi }) };
  }

  async submitSafetyAction(gameId, action, input) {
    const id = validateGameId(gameId);
    return this.#withGameLock(id, () => this.#submitSafetyActionLocked(id, action, input));
  }

  async #submitSafetyActionLocked(id, action, { preparedHash, signedTxJson }) {
    const prepared = await this.store.loadActionPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== action) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Action preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    const operationId = operationKey(action, preparedHash);
    const existing = await this.store.loadOperation(operationId);
    let transactionId;
    if (existing?.status === 'broadcast') {
      transactionId = existing.transactionId;
    } else {
      verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
      transactionId = await this.#submitOperation({
        operationId, action, gameId: id, preparedHash,
        metadata: { playerAddress: prepared.playerAddress, role: prepared.role, continuationAddress: prepared.continuationAddress, continuationScriptPublicKey: prepared.continuationScriptPublicKey, continuationRedeemScript: prepared.continuationRedeemScript, continuationOutputIndex: prepared.continuationOutputIndex },
        transactionId: transactionIdFromSafeJson(signedTxJson),
        submit: () => this.#submitSignedTransaction(action, signedTxJson, prepared.priorityFeerate),
      });
    }
    this.#logPlayer(`${action}_submit`, prepared.playerAddress, { gameId: id, transactionId, role: prepared.role });
    const terminal = {
      action, transactionId, preparedHash, playerAddress: prepared.playerAddress, role: prepared.role,
      status: 'broadcast', continuationAddress: prepared.continuationAddress,
      continuationScriptPublicKey: prepared.continuationScriptPublicKey,
      continuationRedeemScript: prepared.continuationRedeemScript,
      continuationOutputIndex: prepared.continuationOutputIndex,
      submittedAt: new Date().toISOString(),
    };
    await this.#saveGame({ ...gameRecord, status: `${action}_broadcast`, safetyActions: [...(gameRecord.safetyActions ?? []), terminal] });
    this.metrics.recordGameEvent(`${action}_submitted`);
    return { gameId: id, transactionId, status: `${action}_broadcast` };
  }

  async readGame(gameId) {
    const id = validateGameId(gameId);
    const record = await this.store.loadGame(id);
    if (!record) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not prepared by this backend');
    let refreshed = record.join ? await this.#refreshActionState(record) : record;
    if (refreshed.automaticSettlement?.status === 'broadcast') {
      refreshed = await this.#refreshAutomaticSettlement(refreshed, deserializeRequest(refreshed.request));
    }
    refreshed = await this.#refreshSafetyState(refreshed);
    const request = deserializeRequest(refreshed.request);
    const prepared = deserializePrepared(refreshed.prepared);
    const safetyStatus = ['fallback_claimed', 'refunded', 'creator_refunded', 'refund_partial'].includes(refreshed.status);
    const confirmedReveals = (refreshed.reveals ?? []).filter((reveal) => reveal.status === 'confirmed');
    const pendingReveals = (refreshed.reveals ?? []).filter((reveal) => reveal.status !== 'confirmed');
    const pendingSafety = (refreshed.safetyActions ?? []).filter((item) => item.status !== 'confirmed');
    const automaticBroadcast = refreshed.automaticSettlement?.status === 'broadcast';
    const confirmation = safetyStatus || confirmedReveals.length > 0
      ? { status: 'confirmed' }
      : pendingReveals.length > 0 || pendingSafety.length > 0
      ? { status: 'observed' }
      : refreshed.join
      ? await this.#confirmJoin(refreshed, request)
      // The status endpoint must be a lightweight observation, not the full
      // confirmation wait: the browser polls on its own cadence, so one RPC pass
      // (mined within the current DAA, or merely visible in the mempool) is
      // enough to reflect progress. Keeping this non-blocking is what stops a
      // freshly locked number from hanging the page for up to a minute.
      : await this.chain.confirmCreation({ transactionId: id, request, prepared, attempts: 1 });
    const status = deriveGameStatus({ record: refreshed, confirmation, safetyStatus, automaticBroadcast, confirmedReveals, pendingReveals, pendingSafety });
    if (status !== refreshed.status) {
      // Merge the new status into the latest stored record instead of replacing
      // the whole snapshot: a join, reveal, or safety action saved while this
      // read was on the wire must survive the update. If the stored record moved
      // on while we waited, that newer writer owns the status too; our derived
      // value described an older snapshot, so it must not overwrite it.
      if (typeof this.store.updateGame === 'function') {
        await this.store.updateGame(id, (current) => {
          if (current.status !== refreshed.status) return;
          current.status = status;
          current.confirmation = confirmation;
          current.updatedAt = new Date().toISOString();
        });
      } else {
        await this.#saveGame({ ...refreshed, status, confirmation, updatedAt: new Date().toISOString() });
      }
    }
    const actions = deriveAvailableActions({ status, firstRevealer: confirmedReveals.find((reveal) => !reveal.winner)?.playerAddress });
    const { safetyAction, automaticAction, canCancel } = actions;
    const readiness = await this.#safetyReadiness(refreshed, request, automaticAction ?? safetyAction);
    const chainReady = await this.#chainActionReady(refreshed, request, status, confirmedReveals, confirmation);
    return {
      gameId: id,
      network: this.network.id,
      status,
      confirmationStatus: confirmation.status,
      stakeKas: Number(request.stakeSompi) / 100_000_000,
      creator: { address: request.creatorAddress, side: request.side },
      joiner: refreshed.join ? { address: refreshed.join.joinerAddress } : null,
      deadlineDaa: String(request.deadlineDaa),
       canJoin: status === 'waiting_for_player_b' && !(automaticAction === 'refund_open' && readiness?.ready),
      canCancel,
      joinTransactionId: refreshed.join?.transactionId,
      revealCount: confirmedReveals.length,
       firstRevealer: actions.firstRevealer,
      winner: refreshed.winner,
      winnerAddress: refreshed.winner === 'creator' ? request.creatorAddress : refreshed.winner === 'joiner' ? refreshed.join?.joinerAddress : null,
      matchmaking: Boolean(refreshed.matchId),
      revealedPicks: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.role, reveal.choice])),
      transactions: projectTerminalTransactions({ record: refreshed, confirmedReveals, status }),
       canReveal: actions.canReveal,
      // The one chain fact the interface reflects: the current covenant output
      // can be spent now, so a game action button may be shown. It is not a
      // policy the backend enforces on the player; it is the chain's own
      // one-DAA confirmation rule, surfaced so the screen matches the chain.
      chainReady,
      pendingReveals: pendingReveals.map((reveal) => ({ role: reveal.role, stage: reveal.winner ? 'settlement' : 'first', retryable: isPendingRetryable(reveal) })),
      pendingSafety: pendingSafety.map((item) => ({ action: item.action, role: item.role, retryable: isPendingRetryable(item) })),
       safetyAction,
       safetyReady: readiness?.ready ?? null,
       safetyRemainingSeconds: readiness?.remainingSeconds ?? null,
       automaticAction,
       automaticReady: automaticAction ? (readiness?.ready ?? false) : null,
       automaticRemainingSeconds: automaticAction ? (readiness?.remainingSeconds ?? null) : null,
       automaticSettlement: refreshed.automaticSettlement ? {
         action: refreshed.automaticSettlement.action,
         status: refreshed.automaticSettlement.status,
         transactionId: refreshed.automaticSettlement.transactionId,
       } : null,
     };
  }

  // --- Reveal helpers ------------------------------------------------------

  #revealContinuation({ request, gameRecord, player, choice, publicKey, first }) {
    const economics = resolveEconomics(request);
    if (!first) {
      const firstHash = Buffer.from(blake2b256(Buffer.from(publicKey, 'hex'))).toString('hex');
      return {
        continuation: deriveGameInstance({
          creatorPubkey: request.creatorPublicKey,
          creatorCommit: request.creatorCommitment,
          joinerPubkey: gameRecord.join.joinerPublicKey,
          joinerCommit: gameRecord.join.joinerCommitment,
          stakeSompi: economics.stakeSompi,
          deadlineDaa: request.deadlineDaa,
          creatorEven: request.creatorEven,
          creatorChoice: player.role === 'creator' ? choice : 0,
          joinerChoice: player.role === 'joiner' ? choice : 0,
          firstRevealerHash: firstHash,
           gameWalletHash: request.gameWalletHash,
           settleFee: request.settleFeeSompi,
           status: 2,
        }, { addressPrefix: this.network.addressPrefix }),
        winner: null,
      };
    }
    const creatorChoice = player.role === 'creator' ? choice : first.choice;
    const joinerChoice = player.role === 'joiner' ? choice : first.choice;
    return { continuation: null, winner: parityOutcome({ creatorChoice, joinerChoice, creatorEven: request.creatorEven }) };
  }

  #revealGameState(gameId, record, request, current, confirmedReveals) {
    const first = confirmedReveals[0];
    const economics = resolveEconomics(request);
    return {
      gameId,
      network: this.network.id,
      confirmationStatus: 'confirmed',
      joinedDaaScore: current.joinedDaaScore,
      currentDaaScore: current.currentDaaScore,
      creatorAddress: request.creatorAddress,
      joinerAddress: record.join.joinerAddress,
      creatorEven: request.creatorEven,
      creatorChoice: first?.role === 'creator' ? first.choice : 0,
      joinerChoice: first?.role === 'joiner' ? first.choice : 0,
      stakeSompi: economics.stakeSompi,
      potSompi: economics.potSompi,
      participants: {
        [request.creatorAddress]: { commitment: request.creatorCommitment },
        [record.join.joinerAddress]: { commitment: record.join.joinerCommitment },
      },
      reveals: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.playerAddress, true])),
      firstReveal: first ? { player: first.playerAddress, confirmedDaaScore: first.confirmedDaaScore } : null,
    };
  }

  // --- Chain state ---------------------------------------------------------

  async #currentGameUtxo(record, request, firstReveal) {
    const descriptor = firstReveal
      ? { transactionId: firstReveal.transactionId, address: firstReveal.continuationAddress, scriptPublicKey: firstReveal.continuationScriptPublicKey, redeemScript: firstReveal.continuationRedeemScript }
      : { transactionId: record.join.transactionId, address: record.join.joinedAddress, scriptPublicKey: record.join.joinedScriptPublicKey, redeemScript: record.join.joinedRedeemScript };
    const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, resolveEconomics(request).potSompi);
    return { entry, currentDaaScore, joinedDaaScore: BigInt(entry.blockDaaScore), transactionId: descriptor.transactionId, redeemScript: descriptor.redeemScript };
  }

  // Every player action (join, creator refund, first reveal, settlement reveal)
  // spends the current covenant output, and the chain only accepts that spend
  // once the output it consumes is one DAA score old. This is the single fact
  // the interface mirrors: it is not a rule the backend imposes, only the
  // chain's own confirmation status reported to the screen. Before a join is
  // confirmed the joined escrow is the output; after that the first reveal's
  // continuation is.
  async #chainActionReady(record, request, status, confirmedReveals, confirmation) {
    if (['settled', 'fallback_claimed', 'refunded', 'creator_refunded', 'refund_partial'].includes(status)) return true;
    const first = confirmedReveals.find((reveal) => !reveal.winner) ?? null;
    if (first) {
      try {
        const current = await this.#currentGameUtxo(record, request, first);
        return isDaaConfirmed(current.entry, current.currentDaaScore);
      } catch (error) {
        if (error?.code === 'ACTION_NOT_CONFIRMED') return false;
        throw error;
      }
    }
    return confirmation.status === 'confirmed';
  }

  async #refreshActionState(record) {
    const reveals = [...(record.reveals ?? [])];
    const pending = reveals.filter((reveal) => reveal.status !== 'confirmed');
    if (pending.length === 0) return record;
    const request = deserializeRequest(record.request);
    for (const attempt of pending) {
      const confirmedDaaScore = await this.#revealConfirmation(record, request, attempt);
      if (confirmedDaaScore === null) continue;
      // The chain answered for this step: keep the winner and drop every other
      // unconfirmed attempt for the same step (they can never be accepted).
      const stage = attempt.winner ? 'settlement' : 'first';
      const updated = reveals
        .map((reveal) => {
          if (reveal === attempt) return { ...reveal, status: 'confirmed', confirmedDaaScore: String(confirmedDaaScore) };
          if (reveal.status !== 'confirmed' && (reveal.winner ? 'settlement' : 'first') === stage) return null;
          return reveal;
        })
        .filter(Boolean);
      const settled = updated.find((reveal) => reveal.status === 'confirmed' && reveal.winner);
      const saved = { ...record, reveals: updated, status: settled ? 'settled' : 'first_revealed', ...(settled ? { winner: settled.winner } : {}) };
      if (settled) await this.#completeGame(saved, 'settled');
      else await this.#saveGame(saved);
      return saved;
    }
    return record;
  }

  async #revealConfirmation(record, request, reveal) {
    const economics = resolveEconomics(request);
    const payoutPublicKey = reveal.payoutAddress === request.creatorAddress ? request.creatorPublicKey : record.join.joinerPublicKey;
    const descriptor = reveal.winner
      ? { transactionId: reveal.transactionId, address: reveal.payoutAddress, scriptPublicKey: playerScriptPublicKey(payoutPublicKey), outputIndex: 0 }
      : { transactionId: reveal.transactionId, address: reveal.continuationAddress, scriptPublicKey: reveal.continuationScriptPublicKey, outputIndex: 0 };
    const expected = reveal.winner ? economics.settlementPayoutSompi : economics.potSompi;
    try {
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, expected);
      if (!isDaaConfirmed(entry, currentDaaScore)) return null;
      return currentDaaScore;
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return null;
      throw error;
    }
  }

  async #refreshSafetyState(record) {
    const actions = [...(record.safetyActions ?? [])];
    const pending = actions.filter((item) => item.status !== 'confirmed');
    if (pending.length === 0) return record;
    const request = deserializeRequest(record.request);
    for (const attempt of pending) {
      const confirmedDaaScore = await this.#safetyConfirmation(record, request, attempt);
      if (confirmedDaaScore === null) continue;
      const updated = actions
        .map((item) => {
          if (item === attempt) return { ...item, status: 'confirmed', confirmedDaaScore: String(confirmedDaaScore) };
          if (item.status !== 'confirmed' && item.action === attempt.action && item.playerAddress === attempt.playerAddress) return null;
          return item;
        })
        .filter(Boolean);
      const status = attempt.action === 'creator_refund' ? 'creator_refunded' : record.status;
      const saved = { ...record, safetyActions: updated, status };
       if (status === 'creator_refunded') await this.#completeGame(saved, status);
       else await this.#saveGame(saved);
      return saved;
    }
    return record;
  }

  async #safetyConfirmation(record, request, item) {
    const economics = resolveEconomics(request);
    const publicKey = item.role === 'creator' ? request.creatorPublicKey : record.join?.joinerPublicKey;
    const value = item.action === 'fallback_claim' ? economics.settlementPayoutSompi : economics.refundPayoutSompi;
    const descriptor = item.continuationAddress
      ? { transactionId: item.transactionId, address: item.continuationAddress, scriptPublicKey: item.continuationScriptPublicKey, outputIndex: item.continuationOutputIndex ?? 1 }
      : { transactionId: item.transactionId, address: item.playerAddress, scriptPublicKey: playerScriptPublicKey(publicKey), outputIndex: 0 };
    try {
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, value);
      if (!isDaaConfirmed(entry, currentDaaScore)) return null;
      return currentDaaScore;
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return null;
      throw error;
    }
  }

  async #expectedUtxo(descriptor, valueSompi) {
    return this.chain.findExpectedUtxo(descriptor, valueSompi);
  }

  // Runs game-scoped work one at a time so the reveal ordering decision and the
  // lead claim are atomic. The service is a single process, so a promise tail per
  // game is enough; the entry is dropped once the tail settles.
  #withGameLock(gameId, task) {
    const previous = this.gameLocks.get(gameId) ?? Promise.resolve();
    const current = previous.then(task, task);
    const settled = current.then(() => undefined, () => undefined);
    this.gameLocks.set(gameId, settled);
    settled.then(() => {
      if (this.gameLocks.get(gameId) === settled) this.gameLocks.delete(gameId);
    });
    return current;
  }

  // A caller with no confirmed lead may become the lead revealer, but only one
  // lead may hold the slot: a rival's preparation or already-broadcast lead means
  // wait, never build a second spend of the joined escrow.
  #assertMayLeadReveal(gameId, reveals, player) {
    const rivalLead = reveals.some((reveal) => reveal.status !== 'confirmed' && !reveal.winner
      && reveal.transactionId && reveal.playerAddress !== player.address);
    const claim = this.#activeRevealClaim(gameId);
    if (rivalLead || (claim && claim.playerAddress !== player.address)) {
      throw new ProtocolError('REVEAL_WAITING', 'Waiting for the other reveal to confirm');
    }
  }

  #reserveRevealClaim(gameId, player) {
    this.revealClaims.set(gameId, { playerAddress: player.address, role: player.role, expiresAt: Date.now() + REVEAL_CLAIM_TTL_MS });
  }

  #activeRevealClaim(gameId) {
    const claim = this.revealClaims.get(gameId);
    if (!claim) return null;
    if (claim.expiresAt <= Date.now()) {
      this.revealClaims.delete(gameId);
      return null;
    }
    return claim;
  }

  #releaseRevealClaim(gameId, playerAddress) {
    const claim = this.revealClaims.get(gameId);
    if (claim?.playerAddress === playerAddress) this.revealClaims.delete(gameId);
  }

  // Single description of the creator's covenant output, shared by the on-chain
  // reader and the local builder so both agree on what the deposit looks like.
  #creationOutput(gameId, request, prepared) {
    return {
      transactionId: gameId,
      index: 0,
      amount: resolveEconomics(request).lockSompi,
      scriptPublicKey: prepared.scriptPublicKey,
      covenantId: prepared.covenantId,
      redeemScript: request.covenantRedeemScript,
    };
  }

  // The creation output described as a not-yet-mined parent (chained mempool
  // transaction) so the join can be prepared and signed before one confirmation.
  #unconfirmedCreationInput(gameId, request, prepared) {
    return { ...this.#creationOutput(gameId, request, prepared), blockDaaScore: UNCONFIRMED_INPUT_DAA_SCORE };
  }

  async #openCreationUtxo(gameId, request, prepared) {
    const expected = this.#creationOutput(gameId, request, prepared);
    const [utxos, currentDaaScore] = await Promise.all([
      this.chain.getUtxos(request.covenantAddress),
      this.chain.getCurrentDaaScore(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === expected.transactionId && outpoint.index === expected.index
        && BigInt(candidate.amount) === expected.amount
        && candidate.scriptPublicKey === expected.scriptPublicKey;
    });
    if (!entry) throw new ProtocolError('GAME_NOT_OPEN', 'The game deposit is no longer available');
    if (!isDaaConfirmed(entry, currentDaaScore)) throw new ProtocolError('GAME_NOT_CONFIRMED', 'The game deposit is still confirming');
    return { entry, currentDaaScore };
  }

  // Broadcast ordering: a join is only valid after its creation reached the
  // node. The creation is broadcast inside submitCreation before the match
  // exposes the game id, so this gate orders the pair and drops a join whose
  // creation never made it or is still being broadcast.
  async #assertCreationBroadcast(record) {
    const state = await this.#creationState(record);
    if (state === CREATION_STATE.FAILED) throw new ProtocolError('CREATION_FAILED', 'The game creation did not reach the network; the join was not broadcast');
    if (state === CREATION_STATE.SUBMITTING) throw new ProtocolError('CREATION_PENDING', 'The game creation is still being broadcast; try again');
  }

  async #creationState(record) {
    if (!record?.creationPreparedHash) return CREATION_STATE.BROADCAST;
    const operation = await this.store.loadOperation(operationKey('creation', record.creationPreparedHash));
    return operation?.status ?? CREATION_STATE.BROADCAST;
  }

  async #confirmJoin(record, request) {
    const [utxos, currentDaaScore] = await Promise.all([
      this.chain.getUtxos(record.join.joinedAddress),
      this.chain.getCurrentDaaScore(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === record.join.transactionId && outpoint.index === 0
        && BigInt(candidate.amount) === resolveEconomics(request).potSompi
        && candidate.scriptPublicKey === record.join.joinedScriptPublicKey;
    });
    if (!entry) return { status: 'observed' };
    return { status: isDaaConfirmed(entry, currentDaaScore) ? 'confirmed' : 'observed' };
  }

  async #actionFunding(address, measure) {
    this.funding ??= new TerminalFundingSelector({ chain: this.chain, network: this.network.id });
    return this.funding.select(address, measure);
  }

  async #safetyReadiness(record, request, safetyAction) {
    if (!safetyAction) return null;
    if (safetyAction === 'creator_refund') return { ready: true, remainingSeconds: 0 };
    const currentDaa = await this.#currentDaaScore();
    if (safetyAction === 'refund_open') return safetyReadiness(currentDaa, request.deadlineDaa);
    if (safetyAction === 'fallback_claim') {
      const reveal = (record.reveals ?? []).find((item) => item.status === 'confirmed');
      if (!reveal?.confirmedDaaScore) return { ready: false, remainingSeconds: null };
      return safetyReadiness(currentDaa, BigInt(reveal.confirmedDaaScore) + FALLBACK_CLAIM_DAA_OFFSET);
    }
    const descriptor = this.#refundCurrentOutput(record);
    if (!descriptor?.address) return { ready: false, remainingSeconds: null };
    const anchor = await this.#outputBlockDaaScore(descriptor);
    if (anchor === null) return { ready: false, remainingSeconds: null };
    return safetyReadiness(currentDaa, anchor + NO_REVEAL_REFUND_DAA_OFFSET);
  }

  async #currentDaaScore() {
    return this.chain.getCurrentDaaScore();
  }

  async #outputBlockDaaScore({ address, outputIndex = 0, scriptPublicKey }) {
    const utxos = await this.chain.getUtxos(address);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      const index = outpoint.index ?? candidate.index;
      return index === outputIndex && candidate.scriptPublicKey === scriptPublicKey;
    });
    if (!entry) return null;
    const blockDaaScore = BigInt(entry.blockDaaScore ?? entry.utxo?.blockDaaScore ?? 0);
    // A mempool-only output (DAA score 0) cannot anchor a timeout yet.
    return blockDaaScore > 0n ? blockDaaScore : null;
  }

  #refundCurrentOutput(record) {
    if (record.join) return { address: record.join.joinedAddress, outputIndex: 0, scriptPublicKey: record.join.joinedScriptPublicKey };
    return null;
  }

  // --- Matchmaking internals -----------------------------------------------

  async #attachMatchGame(matchId, request, gameId) {
    const match = await this.store.loadMatch(matchId);
    if (!match) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const creator = findMatchPlayer(match, request.creatorAddress);
    const creatorIndex = match.players.indexOf(creator);
    if (match.status !== 'matched' || creatorIndex !== match.creatorIndex) {
      throw new ProtocolError('MATCH_NOT_READY', 'Only the match creator can publish the game');
    }
    const updated = await this.store.updateMatch(matchId, (current) => {
      current.gameId = gameId;
      current.status = 'started';
      current.creation = {
        gameId,
        creatorPublicKey: request.creatorPublicKey,
        creatorCommitment: request.creatorCommitment,
        side: request.side,
        stakeKas: Number(request.stakeSompi) / 100_000_000,
        deadlineDaa: String(request.deadlineDaa),
        creatorAddress: request.creatorAddress,
      };
    });
    this.#logPlayer('matchmaking_creation', request.creatorAddress, { matchId, gameId });
    return updated;
  }

  async #validateMatchCreation(input) {
    const match = await this.store.loadMatch(input.matchId);
    const player = findMatchPlayer(match, input.creatorAddress);
    const playerIndex = match.players.indexOf(player);
    const assignedSide = matchmakingAssignedSide(match, playerIndex);
    if (match.status !== 'matched' || match.players.length !== 2 || playerIndex !== match.creatorIndex || input.stakeKas !== match.stakeKas || input.side !== assignedSide) {
      throw new ProtocolError('MATCH_NOT_READY', 'This matchmaking game is not ready to start');
    }
  }

  async #validateMatchJoin(matchId, gameId, address) {
    const match = await this.store.loadMatch(matchId);
    const player = findMatchPlayer(match, address);
    const playerIndex = match.players.indexOf(player);
    if (match.status !== 'started' || match.gameId !== gameId || playerIndex === match.creatorIndex) {
      throw new ProtocolError('MATCH_NOT_READY', 'This matchmaking game is not ready for you');
    }
  }

  // The app projects confirmed chain state, it does not decide outcomes. A join
  // is refused only once the creator's refund is confirmed on-chain; a broadcast
  // refund is not truth, so it never blocks a join and the chain arbitrates any
  // live race.
  #assertJoinable(gameRecord) {
    const confirmedRefund = (gameRecord.safetyActions ?? []).some((item) => item.action === 'creator_refund' && item.status === 'confirmed');
    const confirmedAutomaticRefund = gameRecord.automaticSettlement
      && ['refund_open', 'refund_all'].includes(gameRecord.automaticSettlement.action)
      && gameRecord.automaticSettlement.status === 'confirmed';
    if (confirmedRefund || confirmedAutomaticRefund || gameRecord.status === 'creator_refunded') {
      throw new ProtocolError('GAME_CANCELLED', 'The game was canceled');
    }
  }

  async #saveGame(record) {
    await this.store.saveGame(record);
  }

  // Payouts logged on completion. Automatic settlements record theirs at
  // broadcast; a normal reveal settlement derives the single winner payout from
  // the winning reveal so both paths report who received what.
  #settlementPayouts(record) {
    const automatic = record.automaticSettlement?.payouts ?? [];
    if (automatic.length > 0) return automatic;
    const reveal = record.reveals?.find((item) => item.winner);
    if (!reveal?.payoutAddress || !record.join) return [];
    const request = deserializeRequest(record.request);
    const winnerKey = reveal.payoutAddress === request.creatorAddress ? request.creatorPublicKey : record.join.joinerPublicKey;
    return [{
      outputIndex: 0,
      value: String(resolveEconomics(request).settlementPayoutSompi),
      scriptPublicKey: playerScriptPublicKey(winnerKey),
      address: reveal.payoutAddress,
    }];
  }

  async #completeGame(record, status) {
    if (record.completedAt) return;
    const retained = await this.store.completeGame(record);
    if (!retained) return;
    this.log.info('game_completed', {
      gameId: record.gameId,
      status,
      winner: record.winner ?? null,
      revealTransactionId: record.reveals?.find((reveal) => reveal.winner)?.transactionId ?? null,
      automaticTransactionId: record.automaticSettlement?.transactionId ?? null,
      safetyTransactionIds: (record.safetyActions ?? []).map((action) => action.transactionId).filter(Boolean),
      payouts: this.#settlementPayouts(record),
    });
    this.ephemeral.deleteForGame(record.gameId);
    this.revealClaims.delete(record.gameId);
    this.metrics.recordGameEvent('game_completed');
  }

  // Recompute the matchmaking gauge from the store. Called on startup and
  // periodically so the gauge stays correct across restarts.
  async refreshTelemetry() {
    await this.matchmaking.recordBacklog();
  }

  // Removes finished games once their retrieval window has passed, so the store
  // does not grow without bound. Called on startup and periodically by a scheduler.
  async pruneCompletedGames(now) {
    if (typeof this.store.pruneCompletedGames !== 'function') return;
    await this.store.pruneCompletedGames(now);
  }

  async reconcilePendingSubmissions() {
    if (typeof this.store.listOperations !== 'function') return 0;
    let reconciled = 0;
    for (const operation of await this.store.listOperations()) {
      if (operation.status !== 'broadcast' || !operation.transactionId) continue;
      if (operation.action === 'creation') {
        if (await this.store.loadGame(operation.transactionId)) continue;
        const prepared = await this.store.loadPrepared(operation.preparedHash);
        if (!prepared) continue;
        await this.store.saveGame({
          gameId: operation.transactionId, network: this.network.id, protocolVersion: PROTOCOL_VERSION,
          status: 'broadcast', request: prepared.request, prepared: prepared.prepared,
          creationPreparedHash: operation.preparedHash, createdAt: operation.createdAt,
          ...(operation.metadata?.matchId ? { matchId: operation.metadata.matchId } : {}),
        });
        reconciled += 1;
      } else if (operation.action === 'join') {
        const game = await this.store.loadGame(operation.gameId);
        if (!game || game.join) continue;
        await this.store.saveGame({ ...game, status: 'join_broadcast', join: { ...operation.metadata, transactionId: operation.transactionId, preparedHash: operation.preparedHash, submittedAt: operation.updatedAt } });
        reconciled += 1;
      } else if (operation.action === 'creator_refund') {
        const game = await this.store.loadGame(operation.gameId);
        if (!game || (game.safetyActions ?? []).some((item) => item.transactionId === operation.transactionId)) continue;
        await this.store.saveGame({ ...game, status: 'creator_refund_broadcast', safetyActions: [...(game.safetyActions ?? []), { ...operation.metadata, action: operation.action, transactionId: operation.transactionId, preparedHash: operation.preparedHash, status: 'broadcast', submittedAt: operation.updatedAt }] });
        reconciled += 1;
      } else if (operation.action === 'automatic_settlement') {
        const game = await this.store.loadGame(operation.gameId);
        if (!game || game.automaticSettlement?.transactionId === operation.transactionId) continue;
        await this.store.saveGame({ ...game, status: operation.metadata.status, automaticSettlement: { ...operation.metadata.settlement, transactionId: operation.transactionId, status: 'broadcast', submittedAt: operation.updatedAt } });
        reconciled += 1;
      }
    }
    return reconciled;
  }

  async #updateOperation(operationId, change) {
    const operation = await this.store.loadOperation(operationId);
    if (operation) await this.store.saveOperation({ ...operation, ...change, updatedAt: new Date().toISOString() });
  }

  async #submitOperation({ operationId, action, gameId, preparedHash, transactionId, metadata = {}, submit }) {
    const existing = await this.store.loadOperation(operationId);
    if (existing?.status === 'broadcast') return existing.transactionId;
    // A rejection is retryable: the record stays `failed` until an attempt is
    // accepted, so a transient node error must not wedge the operation forever.
    if (existing?.status === 'submitting') throw new ProtocolError('ACTION_PENDING', 'A previous submission is still being reconciled');
    const startedAt = new Date().toISOString();
    const base = { operationId, action, gameId, preparedHash, transactionId, metadata, createdAt: existing?.createdAt ?? startedAt };
    await this.store.saveOperation({ ...base, status: 'submitting', updatedAt: startedAt });
    let lastError;
    for (let attempt = 1; attempt <= SUBMISSION_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const submittedTransactionId = await submit();
        await this.store.saveOperation({ ...base, gameId: gameId ?? submittedTransactionId, transactionId: submittedTransactionId, status: 'broadcast', updatedAt: new Date().toISOString() });
        if (attempt > 1) logger.info('submission_retry_recovered', { operationId, action, attempt, transactionId: submittedTransactionId });
        return submittedTransactionId;
      } catch (error) {
        lastError = error;
        if (attempt === SUBMISSION_RETRY_ATTEMPTS || !isRetryableSubmissionError(error)) break;
        const retryDelayMs = this.submissionRetryBaseMs * attempt;
        logger.warn('submission_retry_scheduled', { operationId, action, attempt, retryDelayMs, code: error?.code, message: error?.message });
        await delay(retryDelayMs);
      }
    }
    await this.store.saveOperation({ ...base, status: 'failed', lastError: publicError(lastError), updatedAt: new Date().toISOString() });
    throw lastError;
  }

  #player(record, request, address, publicKey) {
    if (address === request.creatorAddress && publicKey === request.creatorPublicKey) {
      return { role: 'creator', address, publicKey, commitment: request.creatorCommitment };
    }
    if (address === record.join.joinerAddress && publicKey === record.join.joinerPublicKey) {
      return { role: 'joiner', address, publicKey, commitment: record.join.joinerCommitment };
    }
    throw new ProtocolError('NOT_A_PLAYER', 'The connected KasWare account is not a player in this game');
  }

  #creator(request, address, publicKey) {
    if (address !== request.creatorAddress || publicKey !== request.creatorPublicKey) throw new ProtocolError('NOT_A_PLAYER', 'Only Player A can refund this game');
    return { role: 'creator', address, publicKey, commitment: request.creatorCommitment };
  }

  #logPlayer(event, address, fields = {}) {
    if (process.env.LOG_WALLET_ADDRESSES !== '1') return;
    this.log.info(event, { address, ...fields });
  }

  async #submitSignedTransaction(action, signedTxJson, priorityFeerate) {
    let diagnostics;
    try {
      diagnostics = assertSignedTransactionFee({ network: this.network.id, signedTxJson, priorityFeerate });
    } catch (error) {
      logger.warn('signed_transaction_fee_rejected', { action, ...feeLogFields(error.transactionDiagnostics) });
      throw error;
    }
    const fields = { action, ...feeLogFields(diagnostics) };
    logger.info('signed_transaction_fee_validated', fields);
    try {
      return validateGameId(await this.chain.submitSafeJson(signedTxJson));
    } catch (error) {
      error.transactionDiagnostics = fields;
      throw error;
    }
  }
}

function operationKey(action, preparedHash) {
  return `${PROTOCOL_VERSION}\u0000submission\u0000${action}\u0000${preparedHash}`;
}

function transactionIdFromSafeJson(txJson) {
  try {
    const id = JSON.parse(txJson)?.id;
    return /^[0-9a-f]{64}$/i.test(id ?? '') ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function publicError(error) {
  return { code: String(error?.code ?? 'UNKNOWN'), message: String(error?.message ?? 'Operation failed') };
}

// The node reports a mempool UTXO with block DAA score 0. It is visible but not
// mined, so it must not count as confirmed: chaining a spend onto it produces an
// orphan until the parent is included in a block.
function isDaaConfirmed(entry, currentDaaScore) {
  if (!isMinedDaaScore(entry?.blockDaaScore ?? entry?.utxo?.blockDaaScore)) return false;
  return BigInt(currentDaaScore) >= BigInt(entry.blockDaaScore ?? entry.utxo.blockDaaScore) + 1n;
}

// A covenant action is refused when the output it must spend is not in the
// state the action needs: still confirming, or already moved on to the next
// phase. That is the chain progressing under a UTXO model, not a player
// mistake, so these become one retryable CHAIN_NOT_READY the client can wait
// out instead of an error it shows to the player.
const CHAIN_STATE_CODES = new Set(['ACTION_NOT_CONFIRMED', 'GAME_NOT_CONFIRMED', 'GAME_NOT_OPEN']);

function asChainWait(error) {
  return CHAIN_STATE_CODES.has(error?.code)
    ? new ProtocolError('CHAIN_NOT_READY', 'The chain has not reached the state this action needs yet')
    : error;
}

function isRetryableSubmissionError(error) {
  if (error?.code !== 'TRANSACTION_REJECTED') return false;
  const message = String(error?.cause?.message ?? error?.message ?? '');
  return RETRYABLE_SUBMISSION_PATTERN.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeHex(value, bytes, name) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_GAME_STATE', `${name} must be ${bytes} bytes of hexadecimal`);
  }
  return value.toLowerCase();
}

function playerScriptPublicKey(publicKey) {
  return `000020${normalizePublicKey(publicKey)}ac`;
}

// A pending attempt stops holding the player's button once it is older than the
// retry window. We keep the attempt: the chain may still confirm it.
function isPendingRetryable(entry) {
  const submittedAt = Date.parse(entry?.submittedAt ?? '');
  return !Number.isFinite(submittedAt) || Date.now() - submittedAt >= PENDING_RETRY_MS;
}

function serializeRequest(request) {
  return Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
}

function deserializeRequest(request) {
  return {
    ...request,
    stakeSompi: BigInt(request.stakeSompi),
    feeSompi: BigInt(request.feeSompi),
    deadlineDaa: BigInt(request.deadlineDaa),
    settleFeeSompi: BigInt(request.settleFeeSompi ?? 0),
  };
}

function serializePrepared(prepared) {
  return JSON.parse(JSON.stringify(prepared, (_, value) => typeof value === 'bigint' ? String(value) : value));
}

function logPreparedTransaction(action, prepared) {
  const transaction = JSON.parse(prepared.txJson);
  logger.info('transaction_prepared', {
    action,
    mass: prepared.mass,
    feeSompi: String(prepared.feeSompi),
    effectiveFeeRate: Math.max(Number(prepared.priorityFeerate ?? prepared.feerate ?? 0), DEFAULT_RELAY_FLOOR_RATE),
    inputCount: transaction.inputs.length,
    outputCount: transaction.outputs.length,
    assumedSignedInputs: prepared.assumedSignedInputs,
  });
}

function feeLogFields(diagnostics) {
  if (!diagnostics) return {};
  return {
    mass: diagnostics.mass,
    effectiveFeeRate: diagnostics.effectiveFeeRate,
    paidFeeSompi: String(diagnostics.paidFeeSompi),
    requiredFeeSompi: String(diagnostics.requiredFeeSompi),
    inputCount: diagnostics.inputCount,
    outputCount: diagnostics.outputCount,
    signedInputCount: diagnostics.signedInputCount,
  };
}

function deserializePrepared(prepared) {
  return { ...prepared, feeSompi: BigInt(prepared.feeSompi), policy: deserializePolicy(prepared.policy) };
}

function deserializePolicy(policy) {
  return Object.fromEntries(Object.entries(policy ?? {}).map(([key, value]) => [key, /Sompi$/.test(key) && typeof value === 'string' ? BigInt(value) : value]));
}
