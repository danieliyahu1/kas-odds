import { randomUUID } from 'node:crypto';
import { normalizePublicKey, prepareCreateGame } from './create-game.js';
import { verifySignedCreationSafeJson } from './genesis-transaction.js';
import { deriveGameInstance } from './covenant/even-odd.mjs';
import { verifySignedJoinTransaction } from './join-transactions.js';
import { DEFAULT_RELAY_FLOOR_RATE, selectOrdinaryUtxos } from './fee-policy.js';
import { prepareRevealTransaction, prepareTerminalTransaction, prepareCovenantOnlyTransaction, prepareOpenRefundTransaction, serializeTerminalTransaction, verifySignedTerminalTransaction } from './terminal-transactions.js';
import { parityOutcome, verifyRevealPreimage } from './reveal.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { FALLBACK_CLAIM_DAA_OFFSET, FIVE_MINUTE_DAA_OFFSET, NO_REVEAL_REFUND_DAA_OFFSET, TESTNET10_DAA_PER_SECOND, safetyReadiness } from './terminal-actions.js';
import { playerLockSompi, grossPotSompi, gameFeeSompi, winnerPayoutSompi, automaticFallbackPayoutSompi, automaticRefundPayoutSompi, AUTOMATION_FEE_SOMPI, MIN_STAKE_KAS, stakeToSompi, NETWORK, PROTOCOL_VERSION, ProtocolError, validateGameFeePublicKey, validateGameId } from './protocol.js';
import { noopMetrics } from './metrics.js';
import { EphemeralPreparations } from './ephemeral-preparations.js';
import { KaspaChainAdapter } from './chain-adapter.js';
import { logger } from './logger.js';
import { loadWasmSdk } from './wasm-transaction.js';
import { prepareWithDynamicFee } from './transaction-fee.js';
import { assertSignedTransactionFee, signedTransactionFeeDiagnostics } from './transaction-mass.js';

const MAX_TERMINAL_STORAGE_MASS = 500_000;
// A broadcast transaction that has not been observed on-chain yet keeps the
// player's button locked. After this window we let the player try again while
// keeping the original attempt: the first answer the chain gives wins.
const PENDING_RETRY_MS = 60_000;

// Application use cases for the Even/Odd game.
//
// The browser is a thin client: it owns the hidden number and nonce (never sent
// here until reveal) and KasWare signatures, while this service owns chain
// communication. It prepares transactions, verifies signed SafeJSON, and
// broadcasts to the node. The service therefore never learns a player's number
// before both commitments are confirmed on-chain and the number is public.
export class BackendGameService {
  constructor({ rpc, store, metrics = noopMetrics, ephemeral = new EphemeralPreparations(), gameFeePublicKey }) {
    this.rpc = rpc;
    this.store = store;
    this.metrics = metrics;
    this.ephemeral = ephemeral;
    this.gameFeePublicKey = gameFeePublicKey ? validateGameFeePublicKey(gameFeePublicKey) : null;
  }

  // Static config only: deliberately does not touch the node, so booting the
  // client never blocks on a wRPC round-trip.
  networkStatus() {
    return { network: NETWORK, protocolVersion: PROTOCOL_VERSION, gameFeePublicKey: this.gameFeePublicKey };
  }

  // --- Matchmaking ---------------------------------------------------------

  async joinMatchmaking(input) {
    const address = this.#matchmakingAddress(input.address);
    const publicKey = normalizePublicKey(input.publicKey, 'matchmaking public key');
    const limitKas = input.limitKas === undefined ? MIN_STAKE_KAS : Number(input.limitKas);
    stakeToSompi(limitKas);
    const match = await this.store.joinMatchmaking({ matchId: randomUUID(), address, publicKey, limitKas });
    this.#logPlayer('matchmaking_join', address, { matchId: match.matchId, status: match.status, limitKas });
    if (match.status === 'matched' && match.players.length === 2) {
      this.#logPlayer('matchmaking_paired', match.players[0].address, { matchId: match.matchId, opponentAddress: match.players[1].address, stakeKas: match.stakeKas });
    }
    this.metrics.recordGameEvent('matchmaking_join');
    await this.#recordMatchmakingBacklog();
    return this.#matchResponse(match, address);
  }

  async matchmakingStatus(matchId, address) {
    const match = await this.store.loadMatch(matchId);
    const playerAddress = this.#matchmakingAddress(address);
    this.#logPlayer('matchmaking_status', playerAddress, { matchId });
    this.#matchPlayer(match, playerAddress);
    await this.store.touchMatch(matchId, playerAddress);
    return this.#matchResponse(await this.store.loadMatch(matchId), playerAddress);
  }

  async leaveMatchmaking(matchId, address) {
    const playerAddress = this.#matchmakingAddress(address);
    this.#logPlayer('matchmaking_leave', playerAddress, { matchId });
    const match = await this.store.loadMatch(matchId);
    this.#matchPlayer(match, playerAddress);
    await this.store.leaveMatch(matchId, playerAddress);
    this.metrics.recordGameEvent('matchmaking_leave');
    await this.#recordMatchmakingBacklog();
    return { matchId, status: 'left' };
  }

  // --- Game lifecycle ------------------------------------------------------

  async prepareCreation(input) {
    if (!this.gameFeePublicKey) throw new ProtocolError('INVALID_GAME_FEE', 'Game fee recipient is not configured yet (GAME_FEE_ADDRESS)');
    if (input.matchId) await this.#validateMatchCreation(input);
    const dag = await this.rpc.getBlockDagInfo();
    const request = prepareCreateGame({
      network: NETWORK,
      creatorAddress: input.creatorAddress,
      creatorPublicKey: input.creatorPublicKey,
      creatorCommitment: input.creatorCommitment,
      deadlineDaa: BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString) + FIVE_MINUTE_DAA_OFFSET,
      side: input.side,
      stakeKas: input.stakeKas,
      feeSompi: 0n,
      gameFeePublicKey: this.gameFeePublicKey,
    });
    this.#logPlayer('creation_prepare', request.creatorAddress, { matchId: input.matchId ?? null });
    const prepared = await this.#chain(request).prepareCreation(request);
    logPreparedTransaction('creation', prepared);
    await this.store.savePrepared({
      preparedHash: prepared.preparedHash,
      request: serializeRequest(request),
      prepared: serializePrepared(prepared),
      createdAt: new Date().toISOString(),
      ...(input.matchId ? { matchId: input.matchId } : {}),
    });
    this.metrics.recordGameEvent('creation_prepared');
    return { network: NETWORK, preparedHash: prepared.preparedHash, txJson: prepared.txJson, feeSompi: String(prepared.feeSompi), deadlineDaa: String(request.deadlineDaa) };
  }

  async submitCreation({ preparedHash, signedTxJson, matchId }) {
    const record = await this.store.loadPrepared(preparedHash);
    if (!record) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Prepared transaction was not found or has expired');
    const request = deserializeRequest(record.request);
    const prepared = deserializePrepared(record.prepared);
    if (Boolean(record.matchId) !== Boolean(matchId) || (matchId && record.matchId !== matchId)) {
      throw new ProtocolError('MATCH_NOT_READY', 'This creation does not belong to the matchmaking session');
    }
    verifySignedCreationSafeJson({ preparedTxJson: prepared.txJson, signedTxJson, request, policy: prepared.policy });
    const transactionId = await this.#submitSignedTransaction('creation', signedTxJson, prepared.feerate);
    this.#logPlayer('creation_submit', request.creatorAddress, { gameId: transactionId, matchId: matchId ?? null });
    await this.#saveGame({
      gameId: transactionId,
      network: NETWORK,
      protocolVersion: PROTOCOL_VERSION,
      status: 'broadcast',
      request: record.request,
      prepared: record.prepared,
      creationPreparedHash: preparedHash,
      createdAt: new Date().toISOString(),
      ...(matchId ? { matchId } : {}),
    });
    if (matchId) await this.#attachMatchGame(matchId, request, transactionId);
    this.metrics.recordGameEvent('creation_submitted');
    return { gameId: transactionId, network: NETWORK, status: 'broadcast' };
  }

  async prepareJoin(gameId, input) {
    const id = validateGameId(gameId);
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    if (gameRecord.join?.transactionId) throw new ProtocolError('GAME_ALREADY_JOINED', 'Another player already joined this game');
    if (gameRecord.matchId && input.matchId !== gameRecord.matchId) throw new ProtocolError('MATCH_NOT_READY', 'This game belongs to a different matchmaking session');
    if (gameRecord.matchId) await this.#validateMatchJoin(gameRecord.matchId, id, input.joinerAddress);
    const request = deserializeRequest(gameRecord.request);
    const creation = deserializePrepared(gameRecord.prepared);
    const joinerPublicKey = normalizePublicKey(input.joinerPublicKey, 'joiner public key');
    const joinerCommitment = normalizeHex(input.joinerCommitment, 32, 'joiner commitment');
    if (typeof input.joinerAddress !== 'string' || !input.joinerAddress.startsWith('kaspatest:')) {
      throw new ProtocolError('INVALID_ADDRESS', 'Player B must use a testnet address');
    }
    this.#logPlayer('join_prepare', input.joinerAddress, { gameId: id, matchId: input.matchId ?? null });
    const { entry, currentDaaScore } = await this.#openCreationUtxo(id, request, creation);
    if (currentDaaScore >= request.deadlineDaa) throw new ProtocolError('GAME_EXPIRED', 'The joining deadline has passed');

    const joined = deriveGameInstance({
      creatorPubkey: request.creatorPublicKey,
      creatorCommit: request.creatorCommitment,
      joinerPubkey: joinerPublicKey,
      joinerCommit: joinerCommitment,
      stakeSompi: request.stakeSompi,
      deadlineDaa: request.deadlineDaa,
      creatorEven: request.creatorEven,
         gameWalletHash: request.gameWalletHash,
         settleFee: request.settleFeeSompi,
         status: 1,
    });
    const prepared = await this.#chain(request).prepareJoin({
      request: {
        network: NETWORK,
        gameId: id,
        joinerAddress: input.joinerAddress,
        joinerPublicKey,
        joinerCommitment,
      },
      game: {
        stakeSompi: request.stakeSompi,
        currentInput: {
          ...entry,
          transactionId: id,
          index: 0,
          covenantId: creation.covenantId,
        },
        currentCovenantId: creation.covenantId,
        currentRedeemScript: request.covenantRedeemScript,
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
    return { gameId: id, preparedHash: prepared.preparedHash, txJson: prepared.txJson, stakeSompi: String(request.stakeSompi), feeSompi: String(prepared.feeSompi) };
  }

  async submitJoin(gameId, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = await this.store.loadJoinPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Join preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    if (gameRecord.matchId && prepared.matchId !== gameRecord.matchId) throw new ProtocolError('MATCH_NOT_READY', 'This join does not belong to the matchmaking session');
    if (gameRecord.join?.transactionId) throw new ProtocolError('GAME_ALREADY_JOINED', 'Another player already joined this game');
    const request = deserializeRequest(gameRecord.request);
    const creation = deserializePrepared(gameRecord.prepared);
    await this.#openCreationUtxo(id, request, creation);
    verifySignedJoinTransaction({ preparedTxJson: prepared.txJson, signedTxJson });
    const transactionId = await this.#submitSignedTransaction('join', signedTxJson, prepared.priorityFeerate);
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

  async prepareReveal(gameId, input) {
    const id = validateGameId(gameId);
    let gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    gameRecord = await this.#refreshActionState(gameRecord);
    if (gameRecord.status === 'settled') throw new ProtocolError('GAME_SETTLED', 'This game is already settled');
    const request = deserializeRequest(gameRecord.request);
    const publicKey = normalizePublicKey(input.playerPublicKey, 'player public key');
    const player = this.#player(gameRecord, request, input.playerAddress, publicKey);
    this.#logPlayer('reveal_prepare', player.address, { gameId: id, role: player.role });
    const choice = Number(input.choice);
    const nonceHex = normalizeHex(input.nonceHex, 32, 'reveal nonce');
    if (!Number.isInteger(choice) || (choice !== 0 && choice !== 1)) throw new ProtocolError('INVALID_REVEAL', 'Choice must be zero or one');
    if (!verifyRevealPreimage({ commitment: player.commitment, choice, nonceHex })) throw new ProtocolError('INVALID_REVEAL', 'Reveal does not match the saved commitment');

    const confirmedReveals = (gameRecord.reveals ?? []).filter((reveal) => reveal.status === 'confirmed');
    if (confirmedReveals.some((reveal) => reveal.playerAddress === player.address)) throw new ProtocolError('ALREADY_REVEALED', 'This player already revealed');
    const pendingMine = (gameRecord.reveals ?? []).some((reveal) => reveal.status !== 'confirmed'
      && reveal.playerAddress === player.address && !isPendingRetryable(reveal));
    if (pendingMine) throw new ProtocolError('ACTION_PENDING', 'The previous reveal is still confirming');
    const current = await this.#currentGameUtxo(gameRecord, request, confirmedReveals);
    const first = confirmedReveals[0];
    const state = this.#revealGameState(id, gameRecord, request, current, confirmedReveals);

    const { continuation, winner } = this.#revealContinuation({ request, gameRecord, player, choice, publicKey, first });
    const build = (funding) => prepareRevealTransaction({
      game: state,
      caller: player.address,
      currentDaaScore: current.currentDaaScore,
      secret: { gameId: id, player: player.address, choice, nonceHex },
      gameInput: { ...current.entry, transactionId: current.transactionId, index: 0, covenantId: gameRecord.join.covenantId, redeemScript: current.redeemScript },
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationCovenant: continuation ? { authorizingInput: 0, covenantId: gameRecord.join.covenantId } : undefined,
      recipientScriptPublicKey: winner ? playerScriptPublicKey(winner === 'creator' ? request.creatorPublicKey : gameRecord.join.joinerPublicKey) : undefined,
      feeScriptPublicKey: gameFeeSompi(request.stakeSompi) > 0n ? playerScriptPublicKey(request.gameFeePublicKey) : undefined,
      walletPublicKey: request.gameFeePublicKey,
      feeInputs: funding.inputs,
      feeSompi: funding.feeSompi,
      change: funding.change,
      publicKey,
      payoutPublicKey: winner === 'creator' ? request.creatorPublicKey : winner === 'joiner' ? gameRecord.join.joinerPublicKey : publicKey,
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
      payoutAddress: winner === 'creator' ? request.creatorAddress : winner ? gameRecord.join.joinerAddress : undefined,
      createdAt: new Date().toISOString(),
    });
    this.metrics.recordGameEvent('reveal_prepared');
    return { gameId: id, preparedHash, txJson, feeSompi: String(funding.feeSompi), stage: first ? 'settlement' : 'first_reveal' };
  }

  async submitReveal(gameId, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = this.ephemeral.load(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== 'reveal') throw new ProtocolError('PREPARATION_NOT_FOUND', 'Reveal preparation was not found or has expired');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
    const transactionId = await this.#submitSignedTransaction('reveal', signedTxJson, prepared.priorityFeerate);
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
          const open = await this.#openCreationUtxo(current.gameId, request, deserializePrepared(current.prepared));
          if (open.currentDaaScore < request.deadlineDaa) continue;
          const prepared = prepareOpenRefundTransaction({
            gameInput: { ...open.entry, transactionId: current.gameId, index: 0, amount: playerLockSompi(request.stakeSompi), covenantId: deserializePrepared(current.prepared).covenantId, redeemScript: request.covenantRedeemScript },
            stakeSompi: request.stakeSompi,
            settleFeeSompi: request.settleFeeSompi,
            deadlineDaa: request.deadlineDaa,
            creatorPublicKey: request.creatorPublicKey,
           });
           const txJson = serializeTerminalTransaction(prepared);
           const feeDiagnostics = await this.#validateAutomaticFee('refund_open', txJson, request.settleFeeSompi);
           const transactionId = validateGameId(await this.rpc.submitSafeJson(txJson));
          await this.#saveGame({ ...current, status: 'refund_open_broadcast', automaticSettlement: {
            action: 'refund_open', transactionId, txJson, status: 'broadcast', submittedAt: new Date().toISOString(),
            payouts: [{ outputIndex: 0, value: String(playerLockSompi(request.stakeSompi) - request.settleFeeSompi), scriptPublicKey: playerScriptPublicKey(request.creatorPublicKey), address: request.creatorAddress }],
          } });
          this.metrics.recordGameEvent('refund_open_submitted');
           logger.info('automatic_settlement_submitted', { gameId: record.gameId, action: 'refund_open', transactionId, feeSompi: String(request.settleFeeSompi), mass: feeDiagnostics.mass, requiredFeeSompi: String(feeDiagnostics.requiredFeeSompi), feeRate: feeDiagnostics.effectiveFeeRate });
          attempted += 1;
          continue;
        }
        const covenant = await this.#currentGameUtxo(current, request, reveals);
        const age = covenant.currentDaaScore - BigInt(covenant.entry.blockDaaScore);
        let action;
        let args;
        let outputs;
        if (reveals.length === 0 && age >= NO_REVEAL_REFUND_DAA_OFFSET) {
          action = 'refund_all';
          args = [request.creatorPublicKey, current.join.joinerPublicKey];
          const refund = automaticRefundPayoutSompi(request.stakeSompi);
          outputs = [
            { value: refund, scriptPublicKey: playerScriptPublicKey(request.creatorPublicKey) },
            { value: refund, scriptPublicKey: playerScriptPublicKey(current.join.joinerPublicKey) },
          ];
        } else if (reveals.length === 1 && age >= FALLBACK_CLAIM_DAA_OFFSET) {
          action = 'fallback_claim';
          const first = reveals[0];
          args = [first.role === 'creator' ? request.creatorPublicKey : current.join.joinerPublicKey, request.gameFeePublicKey];
          const winnerKey = args[0];
          outputs = [{ value: automaticFallbackPayoutSompi(request.stakeSompi), scriptPublicKey: playerScriptPublicKey(winnerKey) }];
          const fee = gameFeeSompi(request.stakeSompi);
          if (fee > 0n) outputs.push({ value: fee, scriptPublicKey: playerScriptPublicKey(request.gameFeePublicKey) });
        } else continue;

        const prepared = prepareCovenantOnlyTransaction({
          action,
          gameInput: { ...covenant.entry, transactionId: covenant.transactionId, index: 0, amount: grossPotSompi(request.stakeSompi), covenantId: current.join.covenantId, redeemScript: covenant.redeemScript },
          inputSequence: action === 'fallback_claim' ? FALLBACK_CLAIM_DAA_OFFSET : NO_REVEAL_REFUND_DAA_OFFSET,
          args,
          outputs,
         });
         const txJson = serializeTerminalTransaction(prepared);
          const feeDiagnostics = await this.#validateAutomaticFee(action, txJson, prepared.feeSompi);
         const transactionId = validateGameId(await this.rpc.submitSafeJson(txJson));
        const payoutAddresses = action === 'refund_all'
          ? [request.creatorAddress, current.join.joinerAddress]
          : [reveals[0].role === 'creator' ? request.creatorAddress : current.join.joinerAddress];
        await this.#saveGame({ ...current, status: `${action}_broadcast`, automaticSettlement: {
          action, transactionId, txJson, status: 'broadcast', submittedAt: new Date().toISOString(),
          payouts: outputs.slice(0, action === 'refund_all' ? 2 : 1).map((output, outputIndex) => ({ outputIndex, value: String(output.value), scriptPublicKey: output.scriptPublicKey,
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
        active = await this.#currentGameUtxo(record, deserializeRequest(record.request), reveals);
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
    return Math.max(1_000, Number(remainingDaa) * 1_000 / Number(TESTNET10_DAA_PER_SECOND) + 1_000);
  }

  async #validateAutomaticFee(action, txJson, reservedFeeSompi) {
    const estimate = await this.rpc.getFeeEstimate();
    const estimatedRate = Number(estimate?.estimate?.priorityBucket?.[0]?.feerate ?? DEFAULT_RELAY_FLOOR_RATE);
    const priorityFeerate = Number.isFinite(estimatedRate) && estimatedRate >= 0 ? estimatedRate : DEFAULT_RELAY_FLOOR_RATE;
    const diagnostics = signedTransactionFeeDiagnostics({ network: NETWORK, signedTxJson: txJson, priorityFeerate });
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
      const open = await this.#openCreationUtxo(id, request, creation);
      if (open.currentDaaScore < request.deadlineDaa) throw new ProtocolError('ACTION_UNAVAILABLE', 'The game is still open for Player B');
      current = { entry: open.entry, currentDaaScore: open.currentDaaScore, transactionId: id, redeemScript: request.covenantRedeemScript, value: playerLockSompi(request.stakeSompi) };
      covenantEntry = 'refund';
    } else {
      throw new ProtocolError('UNSUPPORTED_ACTION', 'Unsupported safety action');
    }

    let preparedArgs = [publicKey];
    let preparedPayout = playerLockSompi(request.stakeSompi);
    const preparedExtraOutputs = [];
    const build = (funding) => prepareTerminalTransaction({
      action: covenantEntry,
      gameInput: { ...current.entry, transactionId: current.transactionId, index: current.outputIndex ?? 0, amount: current.value, covenantId: gameRecord.join?.covenantId ?? deserializePrepared(gameRecord.prepared).covenantId, redeemScript: current.redeemScript },
      inputSequence: sequence,
      lockTime: action === 'creator_refund' ? request.deadlineDaa : 0n,
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
    return { gameId: id, preparedHash, txJson, feeSompi: String(funding.feeSompi), action };
  }

  async submitSafetyAction(gameId, action, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = await this.store.loadActionPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== action) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Action preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
    const transactionId = await this.#submitSignedTransaction(action, signedTxJson, prepared.priorityFeerate);
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
      : await this.#chain(request, 1).confirmCreation({ transactionId: id, request, prepared });
    const status = safetyStatus ? refreshed.status
      : automaticBroadcast ? `${refreshed.automaticSettlement.action}_broadcast`
      : confirmedReveals.some((reveal) => reveal.winner) ? 'settled'
      : confirmedReveals.length >= 1 ? 'first_revealed'
      : pendingReveals.some((reveal) => reveal.winner) ? 'settlement_broadcast'
      : pendingReveals.length > 0 ? 'reveal_broadcast'
      : pendingSafety.length > 0 ? `${pendingSafety[0].action}_broadcast`
      : refreshed.join
        ? (confirmation.status === 'confirmed' ? 'joined' : refreshed.status)
      : (confirmation.status === 'confirmed' ? 'waiting_for_player_b' : confirmation.status);
    if (status !== refreshed.status) await this.#saveGame({ ...refreshed, status, confirmation, updatedAt: new Date().toISOString() });
    const safetyAction = status === 'waiting_for_player_b' ? 'creator_refund' : null;
    const automaticAction = ['waiting_for_player_b', 'refund_open_broadcast'].includes(status) ? 'refund_open'
      : status === 'first_revealed' ? 'fallback_claim' : status === 'joined' ? 'refund_all' : null;
    const readiness = await this.#safetyReadiness(refreshed, request, automaticAction ?? safetyAction);
    return {
      gameId: id,
      network: NETWORK,
      status,
      confirmationStatus: confirmation.status,
      stakeKas: Number(request.stakeSompi / 100_000_000n),
      creator: { address: request.creatorAddress, side: request.side },
      joiner: refreshed.join ? { address: refreshed.join.joinerAddress } : null,
      deadlineDaa: String(request.deadlineDaa),
       canJoin: status === 'waiting_for_player_b' && !(automaticAction === 'refund_open' && readiness?.ready),
      joinTransactionId: refreshed.join?.transactionId,
      revealCount: confirmedReveals.length,
      firstRevealer: confirmedReveals.find((reveal) => !reveal.winner)?.playerAddress ?? null,
      winner: refreshed.winner,
      winnerAddress: refreshed.winner === 'creator' ? request.creatorAddress : refreshed.winner === 'joiner' ? refreshed.join?.joinerAddress : null,
      matchmaking: Boolean(refreshed.matchId),
      revealedPicks: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.role, reveal.choice])),
      canReveal: ['joined', 'first_revealed'].includes(status),
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
    if (!first) {
      const firstHash = Buffer.from(blake2b256(Buffer.from(publicKey, 'hex'))).toString('hex');
      return {
        continuation: deriveGameInstance({
          creatorPubkey: request.creatorPublicKey,
          creatorCommit: request.creatorCommitment,
          joinerPubkey: gameRecord.join.joinerPublicKey,
          joinerCommit: gameRecord.join.joinerCommitment,
          stakeSompi: request.stakeSompi,
          deadlineDaa: request.deadlineDaa,
          creatorEven: request.creatorEven,
          creatorChoice: player.role === 'creator' ? choice : 0,
          joinerChoice: player.role === 'joiner' ? choice : 0,
          firstRevealerHash: firstHash,
           gameWalletHash: request.gameWalletHash,
           settleFee: request.settleFeeSompi,
           status: 2,
        }),
        winner: null,
      };
    }
    const creatorChoice = player.role === 'creator' ? choice : first.choice;
    const joinerChoice = player.role === 'joiner' ? choice : first.choice;
    return { continuation: null, winner: parityOutcome({ creatorChoice, joinerChoice, creatorEven: request.creatorEven }) };
  }

  #revealGameState(gameId, record, request, current, confirmedReveals) {
    const first = confirmedReveals[0];
    return {
      gameId,
      network: NETWORK,
      confirmationStatus: 'confirmed',
      joinedDaaScore: current.joinedDaaScore,
      currentDaaScore: current.currentDaaScore,
      creatorAddress: request.creatorAddress,
      joinerAddress: record.join.joinerAddress,
      creatorEven: request.creatorEven,
      creatorChoice: first?.role === 'creator' ? first.choice : 0,
      joinerChoice: first?.role === 'joiner' ? first.choice : 0,
      stakeSompi: request.stakeSompi,
      potSompi: request.stakeSompi * 2n,
      participants: {
        [request.creatorAddress]: { commitment: request.creatorCommitment },
        [record.join.joinerAddress]: { commitment: record.join.joinerCommitment },
      },
      reveals: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.playerAddress, true])),
      firstReveal: first ? { player: first.playerAddress, confirmedDaaScore: first.confirmedDaaScore } : null,
    };
  }

  // --- Chain state ---------------------------------------------------------

  async #currentGameUtxo(record, request, confirmedReveals) {
    const first = confirmedReveals[0];
    const descriptor = first
      ? { transactionId: first.transactionId, address: first.continuationAddress, scriptPublicKey: first.continuationScriptPublicKey, redeemScript: first.continuationRedeemScript }
      : { transactionId: record.join.transactionId, address: record.join.joinedAddress, scriptPublicKey: record.join.joinedScriptPublicKey, redeemScript: record.join.joinedRedeemScript };
    const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, grossPotSompi(request.stakeSompi));
    return { entry, currentDaaScore, joinedDaaScore: BigInt(entry.blockDaaScore), transactionId: descriptor.transactionId, redeemScript: descriptor.redeemScript };
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
    const descriptor = reveal.winner
      ? { transactionId: reveal.transactionId, address: reveal.payoutAddress, scriptPublicKey: playerScriptPublicKey(reveal.winner === 'creator' ? request.creatorPublicKey : record.join.joinerPublicKey), outputIndex: 0 }
      : { transactionId: reveal.transactionId, address: reveal.continuationAddress, scriptPublicKey: reveal.continuationScriptPublicKey, outputIndex: 0 };
    const expected = reveal.winner ? winnerPayoutSompi(request.stakeSompi) : grossPotSompi(request.stakeSompi);
    try {
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, expected);
      if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) return null;
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
    const publicKey = item.role === 'creator' ? request.creatorPublicKey : record.join?.joinerPublicKey;
    const value = item.action === 'fallback_claim' ? winnerPayoutSompi(request.stakeSompi) : playerLockSompi(request.stakeSompi);
    const descriptor = item.continuationAddress
      ? { transactionId: item.transactionId, address: item.continuationAddress, scriptPublicKey: item.continuationScriptPublicKey, outputIndex: item.continuationOutputIndex ?? 1 }
      : { transactionId: item.transactionId, address: item.playerAddress, scriptPublicKey: playerScriptPublicKey(publicKey), outputIndex: 0 };
    try {
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, value);
      if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) return null;
      return currentDaaScore;
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return null;
      throw error;
    }
  }

  async #expectedUtxo(descriptor, valueSompi) {
    const [utxos, dag] = await Promise.all([this.rpc.getUtxosByAddresses([descriptor.address]), this.rpc.getBlockDagInfo()]);
    const outputIndex = descriptor.outputIndex ?? 0;
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === descriptor.transactionId && outpoint.index === outputIndex
        && BigInt(candidate.amount) === valueSompi && candidate.scriptPublicKey === descriptor.scriptPublicKey;
    });
    if (!entry) throw new ProtocolError('ACTION_NOT_CONFIRMED', 'The expected game output is not available yet');
    return { entry, currentDaaScore: BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString) };
  }

  async #openCreationUtxo(gameId, request, prepared) {
    const [utxos, dag] = await Promise.all([
      this.rpc.getUtxosByAddresses([request.covenantAddress]),
      this.rpc.getBlockDagInfo(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === gameId && outpoint.index === 0
        && BigInt(candidate.amount) === playerLockSompi(request.stakeSompi)
        && candidate.scriptPublicKey === prepared.scriptPublicKey;
    });
    if (!entry) throw new ProtocolError('GAME_NOT_OPEN', 'The game deposit is no longer available');
    const currentDaaScore = BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString);
    if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) throw new ProtocolError('GAME_NOT_CONFIRMED', 'The game deposit is still confirming');
    return { entry, currentDaaScore };
  }

  async #confirmJoin(record, request) {
    const [utxos, dag] = await Promise.all([
      this.rpc.getUtxosByAddresses([record.join.joinedAddress]),
      this.rpc.getBlockDagInfo(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === record.join.transactionId && outpoint.index === 0
        && BigInt(candidate.amount) === grossPotSompi(request.stakeSompi)
        && candidate.scriptPublicKey === record.join.joinedScriptPublicKey;
    });
    if (!entry) return { status: 'observed' };
    const currentDaaScore = BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString);
    return { status: currentDaaScore >= BigInt(entry.blockDaaScore) + 1n ? 'confirmed' : 'observed' };
  }

  async #actionFunding(address, measure) {
    const response = await this.rpc.getUtxosByAddresses([address]);
    const entries = response.entries ?? response;
    const ordinary = entries.filter((entry) => !entry.covenantId);
    if (ordinary.length === 0) {
      selectOrdinaryUtxos({ utxos: entries, targetSompi: 1n });
    }
    const candidates = fundingCandidates(ordinary, 1n);
    if (candidates.length === 0) selectOrdinaryUtxos({ utxos: entries, targetSompi: 1n });
    const priorityFeerate = await this.#readPriorityFeerate();
    let best;
    let bestMass = Number.POSITIVE_INFINITY;
    let sawMassFailure = false;
    let lastFundingError;
    for (const inputs of candidates) {
      const total = inputs.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
      try {
        const changeScriptPublicKey = inputs[0].scriptPublicKey ?? inputs[0].utxo?.scriptPublicKey;
        const repriced = prepareWithDynamicFee({
          network: NETWORK,
          priorityFeerate,
          fundingSompi: total,
          changeScriptPublicKey,
          build: ({ feeSompi, change }) => measure({ inputs, feeSompi, change }),
        });
        const mass = terminalStorageMass(repriced.transaction);
        if (mass <= MAX_TERMINAL_STORAGE_MASS && mass < bestMass) {
          best = {
            inputs,
            feeSompi: repriced.feeSompi,
            mass: repriced.mass,
            assumedSignedInputs: repriced.assumedSignedInputs,
            priorityFeerate,
            change: total > repriced.feeSompi
              ? { value: total - repriced.feeSompi, scriptPublicKey: changeScriptPublicKey }
              : undefined,
          };
          bestMass = mass;
        } else {
          sawMassFailure = true;
        }
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        lastFundingError = error;
      }
    }
    if (best) return best;
    if (!sawMassFailure && lastFundingError) throw lastFundingError;
    throw new ProtocolError('STORAGE_MASS_EXCEEDED', `No fee UTXO combination keeps this transaction below the ${MAX_TERMINAL_STORAGE_MASS} storage-mass limit`);
  }

  async #readPriorityFeerate() {
    if (typeof this.rpc.getFeeEstimate !== 'function') return 0;
    const response = await this.rpc.getFeeEstimate();
    const buckets = response?.estimate?.priorityBucket ?? response?.estimate?.buckets ?? [];
    const bucket = buckets[0];
    return typeof bucket?.feerate === 'number' && bucket.feerate >= 0 ? bucket.feerate : 0;
  }

  async #safetyReadiness(record, request, safetyAction) {
    if (!safetyAction) return null;
    const currentDaa = await this.#currentDaaScore();
    if (safetyAction === 'creator_refund' || safetyAction === 'refund_open') return safetyReadiness(currentDaa, request.deadlineDaa);
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
    const dag = await this.rpc.getBlockDagInfo();
    return BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString);
  }

  async #outputBlockDaaScore({ address, outputIndex = 0, scriptPublicKey }) {
    const utxos = await this.rpc.getUtxosByAddresses([address]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      const index = outpoint.index ?? candidate.index;
      return index === outputIndex && candidate.scriptPublicKey === scriptPublicKey;
    });
    if (!entry) return null;
    return BigInt(entry.blockDaaScore ?? entry.utxo?.blockDaaScore ?? 0);
  }

  #refundCurrentOutput(record) {
    if (record.join) return { address: record.join.joinedAddress, outputIndex: 0, scriptPublicKey: record.join.joinedScriptPublicKey };
    return null;
  }

  // --- Matchmaking internals -----------------------------------------------

  async #attachMatchGame(matchId, request, gameId) {
    const match = await this.store.loadMatch(matchId);
    if (!match) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const creator = this.#matchPlayer(match, request.creatorAddress);
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
        stakeKas: Number(request.stakeSompi / 100_000_000n),
        deadlineDaa: String(request.deadlineDaa),
        creatorAddress: request.creatorAddress,
      };
    });
    this.#logPlayer('matchmaking_creation', request.creatorAddress, { matchId, gameId });
    return updated;
  }

  async #validateMatchCreation(input) {
    const match = await this.store.loadMatch(input.matchId);
    const player = this.#matchPlayer(match, input.creatorAddress);
    const playerIndex = match.players.indexOf(player);
    const assignedSide = this.#assignedSide(match, playerIndex);
    if (match.status !== 'matched' || match.players.length !== 2 || playerIndex !== match.creatorIndex || input.stakeKas !== match.stakeKas || input.side !== assignedSide) {
      throw new ProtocolError('MATCH_NOT_READY', 'This matchmaking game is not ready to start');
    }
  }

  async #validateMatchJoin(matchId, gameId, address) {
    const match = await this.store.loadMatch(matchId);
    const player = this.#matchPlayer(match, address);
    const playerIndex = match.players.indexOf(player);
    if (match.status !== 'started' || match.gameId !== gameId || playerIndex === match.creatorIndex) {
      throw new ProtocolError('MATCH_NOT_READY', 'This matchmaking game is not ready for you');
    }
  }

  #assignedSide(match, playerIndex) {
    return match.creatorSide === (playerIndex === match.creatorIndex ? 'even' : 'odd') ? 'even' : 'odd';
  }

  #matchmakingAddress(value) {
    if (typeof value !== 'string' || !value.startsWith('kaspatest:')) throw new ProtocolError('INVALID_ADDRESS', 'Matchmaking requires a testnet wallet');
    return value;
  }

  async #recordMatchmakingBacklog() {
    try {
      this.metrics.setMatchmakingWaiting(await this.store.countWaitingMatches());
    } catch {
      // Backlog is best-effort telemetry; never let it affect a request.
    }
  }

  async #saveGame(record) {
    await this.store.saveGame(record);
  }

  async #completeGame(record, status) {
    const removed = await this.store.completeGame(record);
    if (!removed) return;
    logger.info('game_completed', {
      gameId: record.gameId,
      status,
      winner: record.winner ?? null,
      revealTransactionId: record.reveals?.find((reveal) => reveal.winner)?.transactionId ?? null,
      automaticTransactionId: record.automaticSettlement?.transactionId ?? null,
      safetyTransactionIds: (record.safetyActions ?? []).map((action) => action.transactionId).filter(Boolean),
      payouts: record.automaticSettlement?.payouts ?? [],
    });
    this.ephemeral.deleteForGame(record.gameId);
    this.metrics.recordGameEvent('game_completed');
  }

  // Recompute the matchmaking gauge from the store. Called on startup and
  // periodically so the gauge stays correct across restarts.
  async refreshTelemetry() {
    await this.#recordMatchmakingBacklog();
  }

  #matchPlayer(match, address) {
    if (!match || !Array.isArray(match.players)) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const index = match.players.findIndex((player) => player.address === address);
    if (index < 0) throw new ProtocolError('NOT_A_PLAYER', 'This wallet is not part of the matchmaking session');
    return match.players[index];
  }

  #matchResponse(match, address) {
    if (!match) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const index = match.players.findIndex((player) => player.address === address);
    if (index < 0) throw new ProtocolError('NOT_A_PLAYER', 'This wallet is not part of the matchmaking session');
    const isCreator = match.status !== 'waiting' && index === match.creatorIndex;
    const side = match.status === 'waiting' ? null : this.#assignedSide(match, index);
    const mine = match.players[index];
    const rival = match.players.length === 2 ? match.players[1 - index] : null;
    return {
      matchId: match.matchId,
      status: match.status,
      role: match.status === 'waiting' ? null : isCreator ? 'creator' : 'joiner',
      side: match.status === 'waiting' ? null : side,
      gameId: match.gameId ?? null,
      creation: match.creation ?? null,
      stakeKas: match.stakeKas ?? null,
      myLimitKas: mine.limitKas ?? MIN_STAKE_KAS,
      rivalLimitKas: rival ? rival.limitKas ?? MIN_STAKE_KAS : null,
      opponentConnected: match.players.length === 2,
    };
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

  #chain(request, attempts = 30) {
    return new KaspaChainAdapter({
      rpc: this.rpc,
      covenantAddress: request.covenantAddress,
      scriptPublicKey: request.covenantScriptPublicKey,
      confidenceAttempts: attempts,
      confidenceIntervalMs: attempts === 1 ? 0 : 2_000,
    });
  }

  #logPlayer(event, address, fields = {}) {
    if (process.env.LOG_WALLET_ADDRESSES !== '1') return;
    logger.info(event, { address, ...fields });
  }

  async #submitSignedTransaction(action, signedTxJson, priorityFeerate) {
    let diagnostics;
    try {
      diagnostics = assertSignedTransactionFee({ network: NETWORK, signedTxJson, priorityFeerate });
    } catch (error) {
      logger.warn('signed_transaction_fee_rejected', { action, ...feeLogFields(error.transactionDiagnostics) });
      throw error;
    }
    const fields = { action, ...feeLogFields(diagnostics) };
    logger.info('signed_transaction_fee_validated', fields);
    try {
      return validateGameId(await this.rpc.submitSafeJson(signedTxJson));
    } catch (error) {
      error.transactionDiagnostics = fields;
      throw error;
    }
  }
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
  return { ...request, stakeSompi: BigInt(request.stakeSompi), feeSompi: BigInt(request.feeSompi), deadlineDaa: BigInt(request.deadlineDaa), settleFeeSompi: BigInt(request.settleFeeSompi ?? 0) };
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

function terminalStorageMass(transaction) {
  const wasm = loadWasmSdk();
  return Number(wasm.calculateStorageMass(
    NETWORK,
    transaction.inputs.map((input) => Number(input.utxo.amount)),
    transaction.outputs.map((output) => Number(output.value)),
  ));
}

function fundingCandidates(entries, targetSompi) {
  const byOutpoint = (entry) => {
    const outpoint = entry.outpoint ?? entry;
    return `${outpoint.transactionId.toLowerCase()}:${outpoint.index}`;
  };
  const byAmount = (a, b) => {
    const amount = BigInt(a.amount) === BigInt(b.amount) ? 0 : BigInt(a.amount) > BigInt(b.amount) ? 1 : -1;
    return amount !== 0 ? amount : byOutpoint(a).localeCompare(byOutpoint(b));
  };
  const ascending = [...entries].sort(byAmount);
  // Storage mass is dominated by the funded value each input adds, so smallest
  // values tend to produce the lowest-mass settlements. Bound the search pool
  // to the ten smallest UTXOs and subsets of up to four inputs.
  const pool = ascending.slice(0, 10);
  const MAX_CANDIDATES = 600;
  const candidates = [];
  const seen = new Set();
  const consider = (selected) => {
    if (selected.reduce((sum, entry) => sum + BigInt(entry.amount), 0n) < targetSompi) return;
    const key = selected.map(byOutpoint).sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(selected);
  };
  for (const entry of pool) consider([entry]);
  for (let size = 2; size <= 4 && candidates.length < MAX_CANDIDATES; size += 1) {
    for (let a = 0; a < pool.length && candidates.length < MAX_CANDIDATES; a += 1) {
      for (let b = a + 1; b < pool.length && candidates.length < MAX_CANDIDATES; b += 1) {
        if (size === 2) { consider([pool[a], pool[b]]); continue; }
        for (let c = b + 1; c < pool.length && candidates.length < MAX_CANDIDATES; c += 1) {
          if (size === 3) { consider([pool[a], pool[b], pool[c]]); continue; }
          for (let d = c + 1; d < pool.length && candidates.length < MAX_CANDIDATES; d += 1) {
            consider([pool[a], pool[b], pool[c], pool[d]]);
          }
        }
      }
    }
  }
  // Keep the legacy deterministic choice available for wallets with more than
  // ten small UTXOs; the mass-aware candidates are tried first.
  try {
    const { selected } = selectOrdinaryUtxos({ utxos: entries, targetSompi });
    const legacy = entries.filter((entry) => selected.some((item) => {
      const outpoint = entry.outpoint ?? entry;
      return outpoint.transactionId.toLowerCase() === item.transactionId && outpoint.index === item.index;
    }));
    consider(legacy);
  } catch {
    // The caller produces the existing typed funding error below.
  }
  return candidates;
}

function deserializePrepared(prepared) {
  return { ...prepared, feeSompi: BigInt(prepared.feeSompi), policy: deserializePolicy(prepared.policy) };
}

function deserializePolicy(policy) {
  return Object.fromEntries(Object.entries(policy ?? {}).map(([key, value]) => [key, /Sompi$/.test(key) && typeof value === 'string' ? BigInt(value) : value]));
}
