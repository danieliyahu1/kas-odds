import { randomUUID } from 'node:crypto';
import { normalizePublicKey, prepareCreateGame } from './create-game.js';
import { verifySignedCreationSafeJson } from './genesis-transaction.js';
import { deriveGameInstance } from './covenant/even-odd.mjs';
import { verifySignedJoinTransaction } from './join-transactions.js';
import { selectOrdinaryUtxos } from './fee-policy.js';
import { prepareRevealTransaction, prepareTerminalTransaction, serializeTerminalTransaction, verifySignedTerminalTransaction } from './terminal-transactions.js';
import { parityOutcome, verifyRevealPreimage } from './reveal.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { FALLBACK_CLAIM_DAA_OFFSET, FIVE_MINUTE_DAA_OFFSET, NO_REVEAL_REFUND_DAA_OFFSET, safetyReadiness } from './terminal-actions.js';
import { playerLockSompi, grossPotSompi, gameFeeSompi, winnerPayoutSompi, MIN_STAKE_KAS, stakeToSompi, NETWORK, PROTOCOL_VERSION, ProtocolError, validateGameFeePublicKey, validateGameId } from './protocol.js';
import { noopMetrics } from './metrics.js';
import { EphemeralPreparations } from './ephemeral-preparations.js';
import { KaspaChainAdapter } from './chain-adapter.js';
import { logger } from './logger.js';
import { loadWasmSdk } from './wasm-transaction.js';

const TERMINAL_FEE_SOMPI = 4_200_000n;
const MAX_TERMINAL_STORAGE_MASS = 500_000;

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

  async confirmMatchmaking(matchId, address, stakeKas) {
    const playerAddress = this.#matchmakingAddress(address);
    const match = await this.store.loadMatch(matchId);
    const player = this.#matchPlayer(match, playerAddress);
    if (player.confirmed) return this.#matchResponse(match, playerAddress);
    if (match.status !== 'matched' || match.stakeKas === null || match.players.length !== 2) {
      throw new ProtocolError('MATCH_NOT_READY', 'This match has no stake to accept yet');
    }
    if (Number(stakeKas) !== match.stakeKas) {
      throw new ProtocolError('INVALID_STAKE', 'The stake you accept must match the agreed game');
    }
    this.#logPlayer('matchmaking_confirm', playerAddress, { matchId, stakeKas });
    const updated = await this.store.confirmMatchmaking(matchId, playerAddress);
    this.metrics.recordGameEvent('matchmaking_confirm');
    return this.#matchResponse(updated, playerAddress);
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
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
    this.#logPlayer('creation_submit', request.creatorAddress, { gameId: transactionId, matchId: matchId ?? null });
    await this.#saveGame({
      gameId: transactionId,
      network: NETWORK,
      protocolVersion: PROTOCOL_VERSION,
      status: 'broadcast',
      request: record.request,
      prepared: record.prepared,
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
      status: 1,
    });
    const prepared = await this.#chain(request).prepareJoin({
      request: {
        network: NETWORK,
        gameId: id,
        joinerAddress: input.joinerAddress,
        joinerPublicKey,
        joinerCommitment,
        feeSompi: TERMINAL_FEE_SOMPI,
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
    await this.store.saveJoinPrepared({
      preparedHash: prepared.preparedHash,
      gameId: id,
      joinerAddress: input.joinerAddress,
      joinerPublicKey,
      joinerCommitment,
      txJson: prepared.txJson,
      feeSompi: String(prepared.feeSompi),
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
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
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
    if ((gameRecord.reveals ?? []).some((reveal) => reveal.status !== 'confirmed')) throw new ProtocolError('ACTION_PENDING', 'The previous reveal is still confirming');
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
      feeScriptPublicKey: playerScriptPublicKey(request.gameFeePublicKey),
      walletPublicKey: request.gameFeePublicKey,
      feeInputs: funding.inputs,
      feeSompi: TERMINAL_FEE_SOMPI,
      change: funding.change,
      publicKey,
      payoutPublicKey: winner === 'creator' ? request.creatorPublicKey : winner === 'joiner' ? gameRecord.join.joinerPublicKey : publicKey,
    });
    const funding = await this.#actionFunding(player.address, TERMINAL_FEE_SOMPI, build);
    const prepared = build(funding);
    const txJson = serializeTerminalTransaction(prepared);
    const preparedHash = Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex');
    this.ephemeral.save({
      preparedHash,
      action: 'reveal',
      gameId: id,
      playerAddress: player.address,
      role: player.role,
      choice,
      txJson,
      transaction: prepared.transaction,
      feeSompi: String(TERMINAL_FEE_SOMPI),
      continuationAddress: continuation?.address,
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationRedeemScript: continuation?.redeemScript.toString('hex'),
      winner,
      payoutAddress: winner === 'creator' ? request.creatorAddress : winner ? gameRecord.join.joinerAddress : undefined,
      createdAt: new Date().toISOString(),
    });
    this.metrics.recordGameEvent('reveal_prepared');
    return { gameId: id, preparedHash, txJson, feeSompi: String(TERMINAL_FEE_SOMPI), stage: first ? 'settlement' : 'first_reveal' };
  }

  async submitReveal(gameId, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = this.ephemeral.load(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== 'reveal') throw new ProtocolError('PREPARATION_NOT_FOUND', 'Reveal preparation was not found or has expired');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
    this.#logPlayer('reveal_submit', prepared.playerAddress, { gameId: id, transactionId, role: prepared.role });
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
    await this.#saveGame({ ...gameRecord, status: prepared.winner ? 'settlement_broadcast' : 'reveal_broadcast', reveals: [...(gameRecord.reveals ?? []), reveal] });
    this.metrics.recordGameEvent('reveal_submitted');
    return { gameId: id, transactionId, status: prepared.winner ? 'settlement_broadcast' : 'reveal_broadcast' };
  }

  async prepareSafetyAction(gameId, action, input) {
    const id = validateGameId(gameId);
    let gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    gameRecord = await this.#refreshActionState(gameRecord);
    gameRecord = await this.#refreshSafetyState(gameRecord);
    if ((gameRecord.safetyActions ?? []).some((item) => item.status !== 'confirmed')) throw new ProtocolError('ACTION_PENDING', 'The previous recovery action is still confirming');
    const request = deserializeRequest(gameRecord.request);
    const publicKey = normalizePublicKey(input.playerPublicKey, 'player public key');
    const player = action === 'creator_refund' && !gameRecord.join
      ? this.#creator(request, input.playerAddress, publicKey)
      : this.#player(gameRecord, request, input.playerAddress, publicKey);
    this.#logPlayer(`${action}_prepare`, player.address, { gameId: id, role: player.role });
    const confirmedReveals = (gameRecord.reveals ?? []).filter((item) => item.status === 'confirmed');
    const confirmedRefunds = (gameRecord.safetyActions ?? []).filter((item) => item.action === 'refund_player' && item.status === 'confirmed');
    let current;
    let covenantEntry;
    let sequence = 0n;
    let continuation;
    let continuationOutputIndex;

    if (action === 'creator_refund') {
      if (gameRecord.join) throw new ProtocolError('ACTION_UNAVAILABLE', 'Player B already joined this game');
      const creation = deserializePrepared(gameRecord.prepared);
      const open = await this.#openCreationUtxo(id, request, creation);
      if (open.currentDaaScore < request.deadlineDaa) throw new ProtocolError('ACTION_UNAVAILABLE', 'The game is still open for Player B');
      current = { entry: open.entry, currentDaaScore: open.currentDaaScore, transactionId: id, redeemScript: request.covenantRedeemScript, value: playerLockSompi(request.stakeSompi) };
      covenantEntry = 'refund';
    } else if (action === 'fallback_claim') {
      if (confirmedReveals.length !== 1 || confirmedReveals[0].playerAddress !== player.address) throw new ProtocolError('ACTION_UNAVAILABLE', 'Only the first revealer can claim the timeout pot');
      current = await this.#currentGameUtxo(gameRecord, request, confirmedReveals);
      if (current.currentDaaScore < BigInt(current.entry.blockDaaScore) + FALLBACK_CLAIM_DAA_OFFSET) throw new ProtocolError('ACTION_UNAVAILABLE', 'The opponent still has time to reveal');
      current.value = grossPotSompi(request.stakeSompi);
      covenantEntry = 'fallback_claim';
      sequence = FALLBACK_CLAIM_DAA_OFFSET;
    } else if (action === 'refund_player') {
      if (!gameRecord.join || confirmedReveals.length > 0) throw new ProtocolError('ACTION_UNAVAILABLE', 'Refunds require a joined game with no reveals');
      if (confirmedRefunds.some((item) => item.playerAddress === player.address)) throw new ProtocolError('ALREADY_REFUNDED', 'This player already received a refund');
      if (confirmedRefunds.length === 0) {
        current = await this.#currentGameUtxo(gameRecord, request, []);
      } else {
        const firstRefund = confirmedRefunds[0];
        const found = await this.#expectedUtxo({ transactionId: firstRefund.transactionId, address: firstRefund.continuationAddress, scriptPublicKey: firstRefund.continuationScriptPublicKey, outputIndex: 1 }, playerLockSompi(request.stakeSompi));
        current = { ...found, transactionId: firstRefund.transactionId, outputIndex: 1, redeemScript: firstRefund.continuationRedeemScript, joinedDaaScore: BigInt(found.entry.blockDaaScore) };
      }
      if (current.currentDaaScore < BigInt(current.entry.blockDaaScore) + NO_REVEAL_REFUND_DAA_OFFSET) throw new ProtocolError('ACTION_UNAVAILABLE', 'The no-reveal refund wait has not elapsed');
      current.value = confirmedRefunds.length === 0 ? grossPotSompi(request.stakeSompi) : playerLockSompi(request.stakeSompi);
      covenantEntry = 'refund_player';
      sequence = NO_REVEAL_REFUND_DAA_OFFSET;
      if (confirmedRefunds.length === 0) {
        continuation = deriveGameInstance({
          creatorPubkey: request.creatorPublicKey,
          creatorCommit: request.creatorCommitment,
          joinerPubkey: gameRecord.join.joinerPublicKey,
          joinerCommit: gameRecord.join.joinerCommitment,
          stakeSompi: request.stakeSompi,
          deadlineDaa: request.deadlineDaa,
          creatorEven: request.creatorEven,
          gameWalletHash: request.gameWalletHash,
          status: player.role === 'creator' ? 5 : 6,
        });
        continuationOutputIndex = 1;
      }
    } else {
      throw new ProtocolError('UNSUPPORTED_ACTION', 'Unsupported safety action');
    }

    let preparedArgs = [publicKey];
    let preparedPayout = playerLockSompi(request.stakeSompi);
    let preparedExtraOutputs = continuation
      ? [{ value: playerLockSompi(request.stakeSompi), scriptPublicKey: `0000${continuation.p2shScript.toString('hex')}`, covenant: { authorizingInput: 0, covenantId: gameRecord.join.covenantId } }]
      : [];
    if (action === 'fallback_claim') {
      preparedPayout = winnerPayoutSompi(request.stakeSompi);
      preparedArgs = [publicKey, request.gameFeePublicKey];
      preparedExtraOutputs = [{ value: gameFeeSompi(request.stakeSompi), scriptPublicKey: playerScriptPublicKey(request.gameFeePublicKey) }];
    }
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
      feeSompi: TERMINAL_FEE_SOMPI,
      change: funding.change,
    });
    const funding = await this.#actionFunding(player.address, TERMINAL_FEE_SOMPI, build);
    const prepared = build(funding);
    const txJson = serializeTerminalTransaction(prepared);
    const preparedHash = Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex');
    await this.store.saveActionPrepared({
      preparedHash, action, gameId: id, playerAddress: player.address, role: player.role,
      txJson, transaction: prepared.transaction, feeSompi: String(TERMINAL_FEE_SOMPI),
      continuationAddress: continuation?.address,
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationRedeemScript: continuation?.redeemScript.toString('hex'),
      continuationOutputIndex,
      createdAt: new Date().toISOString(),
    });
    this.metrics.recordGameEvent(`${action}_prepared`);
    return { gameId: id, preparedHash, txJson, feeSompi: String(TERMINAL_FEE_SOMPI), action };
  }

  async submitSafetyAction(gameId, action, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = await this.store.loadActionPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== action) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Action preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
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
    refreshed = await this.#refreshSafetyState(refreshed);
    const request = deserializeRequest(refreshed.request);
    const prepared = deserializePrepared(refreshed.prepared);
    const safetyStatus = ['fallback_claimed', 'refunded', 'creator_refunded', 'refund_partial'].includes(refreshed.status);
    const confirmation = safetyStatus || ['first_revealed', 'settled'].includes(refreshed.status)
      ? { status: 'confirmed' }
      : refreshed.join
      ? await this.#confirmJoin(refreshed, request)
      : await this.#chain(request, 1).confirmCreation({ transactionId: id, request, prepared });
    const confirmedReveals = (refreshed.reveals ?? []).filter((reveal) => reveal.status === 'confirmed');
    const status = safetyStatus ? refreshed.status
      : refreshed.status === 'settled' ? 'settled'
      : confirmedReveals.length === 1 ? 'first_revealed'
      : refreshed.join
        ? (confirmation.status === 'confirmed' ? 'joined' : refreshed.status)
      : (confirmation.status === 'confirmed' ? 'waiting_for_player_b' : confirmation.status);
    if (status !== refreshed.status) await this.#saveGame({ ...refreshed, status, confirmation, updatedAt: new Date().toISOString() });
    const safetyAction = status === 'first_revealed' ? 'fallback_claim'
      : status === 'joined' || status === 'refund_partial' ? 'refund_player'
      : status === 'waiting_for_player_b' ? 'creator_refund' : null;
    const readiness = await this.#safetyReadiness(refreshed, request, safetyAction);
    return {
      gameId: id,
      network: NETWORK,
      status,
      confirmationStatus: confirmation.status,
      stakeKas: Number(request.stakeSompi / 100_000_000n),
      creator: { address: request.creatorAddress, side: request.side },
      joiner: refreshed.join ? { address: refreshed.join.joinerAddress } : null,
      deadlineDaa: String(request.deadlineDaa),
      canJoin: status === 'waiting_for_player_b',
      joinTransactionId: refreshed.join?.transactionId,
      revealCount: confirmedReveals.length,
      firstRevealer: confirmedReveals[0]?.playerAddress,
      winner: refreshed.winner,
      winnerAddress: refreshed.winner === 'creator' ? request.creatorAddress : refreshed.winner === 'joiner' ? refreshed.join?.joinerAddress : null,
      matchmaking: Boolean(refreshed.matchId),
      revealedPicks: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.role, reveal.choice])),
      canReveal: ['joined', 'first_revealed'].includes(status),
      safetyAction,
      safetyReady: readiness?.ready ?? null,
      safetyRemainingSeconds: readiness?.remainingSeconds ?? null,
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
    const pending = reveals.find((reveal) => reveal.status !== 'confirmed');
    if (!pending) return record;
    const request = deserializeRequest(record.request);
    const descriptor = pending.winner
      ? { transactionId: pending.transactionId, address: pending.payoutAddress, scriptPublicKey: playerScriptPublicKey(pending.winner === 'creator' ? request.creatorPublicKey : record.join.joinerPublicKey), outputIndex: 0 }
      : { transactionId: pending.transactionId, address: pending.continuationAddress, scriptPublicKey: pending.continuationScriptPublicKey, outputIndex: 0 };
    try {
      const expected = pending.winner ? winnerPayoutSompi(request.stakeSompi) : grossPotSompi(request.stakeSompi);
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, expected);
      if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) return record;
      const index = reveals.indexOf(pending);
      reveals[index] = { ...pending, status: 'confirmed', confirmedDaaScore: String(currentDaaScore) };
      const updated = { ...record, reveals, status: pending.winner ? 'settled' : 'first_revealed', ...(pending.winner ? { winner: pending.winner } : {}) };
      await this.#saveGame(updated);
      return updated;
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return record;
      throw error;
    }
  }

  async #refreshSafetyState(record) {
    const actions = [...(record.safetyActions ?? [])];
    const pending = actions.find((item) => item.status !== 'confirmed');
    if (!pending) return record;
    const request = deserializeRequest(record.request);
    const publicKey = pending.role === 'creator' ? request.creatorPublicKey : record.join?.joinerPublicKey;
    const value = pending.action === 'fallback_claim' ? winnerPayoutSompi(request.stakeSompi) : playerLockSompi(request.stakeSompi);
    const descriptor = pending.continuationAddress
      ? { transactionId: pending.transactionId, address: pending.continuationAddress, scriptPublicKey: pending.continuationScriptPublicKey, outputIndex: pending.continuationOutputIndex ?? 1 }
      : { transactionId: pending.transactionId, address: pending.playerAddress, scriptPublicKey: playerScriptPublicKey(publicKey), outputIndex: 0 };
    try {
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, value);
      if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) return record;
      const index = actions.indexOf(pending);
      actions[index] = { ...pending, status: 'confirmed', confirmedDaaScore: String(currentDaaScore) };
      const refundCount = actions.filter((item) => item.action === 'refund_player' && item.status === 'confirmed').length;
      const status = pending.action === 'fallback_claim' ? 'fallback_claimed'
        : pending.action === 'creator_refund' ? 'creator_refunded'
        : refundCount >= 2 ? 'refunded' : 'refund_partial';
      const updated = { ...record, safetyActions: actions, status };
      await this.#saveGame(updated);
      return updated;
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return record;
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

  async #actionFunding(address, feeSompi, measure) {
    const response = await this.rpc.getUtxosByAddresses([address]);
    const entries = response.entries ?? response;
    const targetSompi = feeSompi + 1n;
    const ordinary = entries.filter((entry) => !entry.covenantId);
    if (ordinary.length === 0) {
      selectOrdinaryUtxos({ utxos: entries, targetSompi });
    }
const candidates = fundingCandidates(ordinary, targetSompi);
    if (candidates.length === 0) selectOrdinaryUtxos({ utxos: entries, targetSompi });
    let best;
    let bestMass = Number.POSITIVE_INFINITY;
    for (const inputs of candidates) {
      const total = inputs.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
      const funding = { inputs, change: { value: total - feeSompi, scriptPublicKey: inputs[0].scriptPublicKey } };
      try {
        const prepared = measure ? measure(funding) : null;
        const mass = prepared ? terminalStorageMass(prepared.transaction) : 0;
        if (mass <= MAX_TERMINAL_STORAGE_MASS && mass < bestMass) {
          best = funding;
          bestMass = mass;
        }
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
      }
    }
    if (best) return best;
    throw new ProtocolError('STORAGE_MASS_EXCEEDED', `No fee UTXO combination keeps this transaction below the ${MAX_TERMINAL_STORAGE_MASS} storage-mass limit`);
  }

  async #safetyReadiness(record, request, safetyAction) {
    if (!safetyAction) return null;
    const currentDaa = await this.#currentDaaScore();
    if (safetyAction === 'creator_refund') return safetyReadiness(currentDaa, request.deadlineDaa);
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
    const confirmedRefund = (record.safetyActions ?? []).find((item) => item.action === 'refund_player' && item.status === 'confirmed');
    if (confirmedRefund?.continuationAddress) {
      return { address: confirmedRefund.continuationAddress, outputIndex: confirmedRefund.continuationOutputIndex ?? 1, scriptPublicKey: confirmedRefund.continuationScriptPublicKey };
    }
    if (record.join) return { address: record.join.joinedAddress, outputIndex: 0, scriptPublicKey: record.join.joinedScriptPublicKey };
    return null;
  }

  // --- Matchmaking internals -----------------------------------------------

  async #attachMatchGame(matchId, request, gameId) {
    const match = await this.store.loadMatch(matchId);
    if (!match) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const creator = this.#matchPlayer(match, request.creatorAddress);
    const creatorIndex = match.players.indexOf(creator);
    if (match.status !== 'ready' || creatorIndex !== match.creatorIndex) {
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
    if (match.status !== 'ready' || match.players.length !== 2 || playerIndex !== match.creatorIndex || input.stakeKas !== match.stakeKas || input.side !== assignedSide) {
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
      confirmed: Boolean(mine.confirmed),
      opponentConfirmed: Boolean(rival?.confirmed ?? false),
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

function serializeRequest(request) {
  return Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
}

function deserializeRequest(request) {
  return { ...request, stakeSompi: BigInt(request.stakeSompi), feeSompi: BigInt(request.feeSompi), deadlineDaa: BigInt(request.deadlineDaa) };
}

function serializePrepared(prepared) {
  return JSON.parse(JSON.stringify(prepared, (_, value) => typeof value === 'bigint' ? String(value) : value));
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
