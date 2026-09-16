import { normalizePublicKey, prepareCreateGame } from './create-game.js';
import { verifySignedCreationSafeJson } from './genesis-transaction.js';
import { deriveGameInstance } from './covenant/even-odd.mjs';
import { verifySignedJoinTransaction } from './join-transactions.js';
import { DEFAULT_RELAY_FLOOR_RATE } from './fee-policy.js';
import { prepareRevealTransaction, prepareTerminalTransaction, prepareCovenantOnlyTransaction, prepareOpenRefundTransaction, serializeTerminalTransaction, verifySignedTerminalTransaction } from './terminal-transactions.js';
import { parityOutcome, verifyRevealPreimage } from './reveal.js';
import { createTransactionIntent } from './transaction-intent.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { FALLBACK_CLAIM_DAA_OFFSET, FIVE_MINUTE_DAA_OFFSET, NO_REVEAL_REFUND_DAA_OFFSET, TESTNET10_DAA_PER_SECOND, safetyReadiness } from './terminal-actions.js';
import { playerLockSompi, grossPotSompi, gameFeeSompi, winnerPayoutSompi, automaticFallbackPayoutSompi, automaticRefundPayoutSompi, AUTOMATION_FEE_SOMPI, MIN_STAKE_KAS, stakeToSompi, NETWORK, PROTOCOL_VERSION, ProtocolError, validateGameFeePublicKey, validateGameId } from './protocol.js';
import { noopMetrics } from './metrics.js';
import { EphemeralPreparations } from './ephemeral-preparations.js';
import { KaspaChainAdapter } from './chain-adapter.js';
import { logger } from './logger.js';
import { assertSignedTransactionFee, signedTransactionFeeDiagnostics } from './transaction-mass.js';
import { TerminalFundingSelector } from './terminal-funding.js';
import { deriveAvailableActions, deriveGameStatus } from './game-projection.js';
import { assignedSide as matchmakingAssignedSide, findMatchPlayer, MatchmakingService } from './matchmaking-service.js';

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
  constructor({ rpc, chain, store, metrics = noopMetrics, ephemeral = new EphemeralPreparations(), gameFeePublicKey }) {
    this.chain = chain ?? new KaspaChainAdapter({ rpc });
    this.funding = null;
    this.matchmaking = new MatchmakingService({ store, metrics, logPlayer: (event, address, fields) => this.#logPlayer(event, address, fields) });
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
    return this.matchmaking.join(input);
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
      network: NETWORK,
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
    return { network: NETWORK, preparedHash: prepared.preparedHash, txJson: prepared.txJson, feeSompi: String(prepared.feeSompi), deadlineDaa: String(request.deadlineDaa), changeScriptPublicKey: prepared.policy?.changeScriptPublicKey };
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
      network: NETWORK,
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
    const prepared = await this.chain.prepareJoin({
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
    return { gameId: id, preparedHash: prepared.preparedHash, txJson: prepared.txJson, stakeSompi: String(request.stakeSompi), feeSompi: String(prepared.feeSompi), verification: createTransactionIntent({ action: 'join', txJson: prepared.txJson, feeSompi: prepared.feeSompi }) };
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
    return { gameId: id, preparedHash, txJson, feeSompi: String(funding.feeSompi), stage: first ? 'settlement' : 'first_reveal', verification: createTransactionIntent({ action: 'reveal', txJson, feeSompi: funding.feeSompi }) };
  }

  async submitReveal(gameId, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = this.ephemeral.load(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== 'reveal') throw new ProtocolError('PREPARATION_NOT_FOUND', 'Reveal preparation was not found or has expired');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    const operationId = operationKey('reveal', preparedHash);
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
           const operationId = operationKey('automatic_settlement', Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex'));
           const transactionId = await this.#submitOperation({
             operationId, action: 'automatic_settlement', gameId: record.gameId, preparedHash: operationId,
             metadata: { status: 'refund_open_broadcast', settlement: { action: 'refund_open', txJson, payouts: [{ outputIndex: 0, value: String(playerLockSompi(request.stakeSompi) - request.settleFeeSompi), scriptPublicKey: playerScriptPublicKey(request.creatorPublicKey), address: request.creatorAddress }] } },
             submit: () => this.chain.submitSafeJson(txJson).then(validateGameId),
           });
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
          const operationId = operationKey('automatic_settlement', Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex'));
          const transactionId = await this.#submitOperation({
            operationId, action: 'automatic_settlement', gameId: record.gameId, preparedHash: operationId,
            metadata: { status: `${action}_broadcast`, settlement: { action, txJson, payouts: outputs.slice(0, action === 'refund_all' ? 2 : 1).map((output, outputIndex) => ({ outputIndex, value: String(output.value), scriptPublicKey: output.scriptPublicKey, address: action === 'refund_all' ? [request.creatorAddress, current.join.joinerAddress][outputIndex] : [reveals[0].role === 'creator' ? request.creatorAddress : current.join.joinerAddress][outputIndex] })) } },
            submit: () => this.chain.submitSafeJson(txJson).then(validateGameId),
          });
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
    const estimatedRate = await this.chain.getPriorityFeerate();
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

  async submitSafetyAction(gameId, action, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
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
      : await this.chain.confirmCreation({ transactionId: id, request, prepared });
    const status = deriveGameStatus({ record: refreshed, confirmation, safetyStatus, automaticBroadcast, confirmedReveals, pendingReveals, pendingSafety });
    if (status !== refreshed.status) await this.#saveGame({ ...refreshed, status, confirmation, updatedAt: new Date().toISOString() });
    const actions = deriveAvailableActions({ status, firstRevealer: confirmedReveals.find((reveal) => !reveal.winner)?.playerAddress });
    const { safetyAction, automaticAction, canCancel } = actions;
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
      canCancel,
      joinTransactionId: refreshed.join?.transactionId,
      revealCount: confirmedReveals.length,
       firstRevealer: actions.firstRevealer,
      winner: refreshed.winner,
      winnerAddress: refreshed.winner === 'creator' ? request.creatorAddress : refreshed.winner === 'joiner' ? refreshed.join?.joinerAddress : null,
      matchmaking: Boolean(refreshed.matchId),
      revealedPicks: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.role, reveal.choice])),
       canReveal: actions.canReveal,
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
    return this.chain.findExpectedUtxo(descriptor, valueSompi);
  }

  async #openCreationUtxo(gameId, request, prepared) {
    const [utxos, currentDaaScore] = await Promise.all([
      this.chain.getUtxos(request.covenantAddress),
      this.chain.getCurrentDaaScore(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === gameId && outpoint.index === 0
        && BigInt(candidate.amount) === playerLockSompi(request.stakeSompi)
        && candidate.scriptPublicKey === prepared.scriptPublicKey;
    });
    if (!entry) throw new ProtocolError('GAME_NOT_OPEN', 'The game deposit is no longer available');
    if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) throw new ProtocolError('GAME_NOT_CONFIRMED', 'The game deposit is still confirming');
    return { entry, currentDaaScore };
  }

  async #confirmJoin(record, request) {
    const [utxos, currentDaaScore] = await Promise.all([
      this.chain.getUtxos(record.join.joinedAddress),
      this.chain.getCurrentDaaScore(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === record.join.transactionId && outpoint.index === 0
        && BigInt(candidate.amount) === grossPotSompi(request.stakeSompi)
        && candidate.scriptPublicKey === record.join.joinedScriptPublicKey;
    });
    if (!entry) return { status: 'observed' };
    return { status: currentDaaScore >= BigInt(entry.blockDaaScore) + 1n ? 'confirmed' : 'observed' };
  }

  async #actionFunding(address, measure) {
    this.funding ??= new TerminalFundingSelector({ chain: this.chain });
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
    await this.matchmaking.recordBacklog();
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
          gameId: operation.transactionId, network: NETWORK, protocolVersion: PROTOCOL_VERSION,
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
    try {
      const submittedTransactionId = await submit();
      await this.store.saveOperation({ ...base, gameId: gameId ?? submittedTransactionId, transactionId: submittedTransactionId, status: 'broadcast', updatedAt: new Date().toISOString() });
      return submittedTransactionId;
    } catch (error) {
      await this.store.saveOperation({ ...base, status: 'failed', lastError: publicError(error), updatedAt: new Date().toISOString() });
      throw error;
    }
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

function deserializePrepared(prepared) {
  return { ...prepared, feeSompi: BigInt(prepared.feeSompi), policy: deserializePolicy(prepared.policy) };
}

function deserializePolicy(policy) {
  return Object.fromEntries(Object.entries(policy ?? {}).map(([key, value]) => [key, /Sompi$/.test(key) && typeof value === 'string' ? BigInt(value) : value]));
}
