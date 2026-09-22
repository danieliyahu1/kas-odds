export function createServerSchedulers({ gameService, feedbackService, feedbackDeliverer, chainClient, logger, botService = null }) {
  let settlementTimer;
  let telemetryTimer;
  let feedbackTimer;
  let reconcileTimer;
  let pruneTimer;
  let botTimer;
  let settlementRunning = false;

  async function runSettlement() {
    if (settlementRunning) return;
    settlementRunning = true;
    try {
      await gameService.settleAutomaticGames();
      const delayMs = await gameService.automaticSettlementDelayMs();
      if (delayMs !== null) settlementTimer = setTimeout(() => void runSettlement(), delayMs);
      settlementTimer?.unref();
    } catch (error) {
      logger.debug('automatic_settlement_scan_failed', { message: error?.message });
      settlementTimer = setTimeout(() => void runSettlement(), 30_000);
      settlementTimer.unref();
    } finally { settlementRunning = false; }
  }

  return {
    wakeSettlement() { if (settlementTimer) clearTimeout(settlementTimer); settlementTimer = undefined; if (!settlementRunning) void runSettlement(); },
    async start() {
      if (feedbackDeliverer.enabled) {
        void feedbackService.drainPending().catch((error) => logger.debug('feedback_drain_failed', { message: error?.message }));
        feedbackTimer = setInterval(() => void feedbackService.drainPending().catch((error) => logger.debug('feedback_drain_failed', { message: error?.message })), 120_000);
        feedbackTimer.unref();
      } else logger.warn('feedback_delivery_disabled', { reason: 'TELEGRAM_FEEDBACK_BOT_TOKEN or TELEGRAM_FEEDBACK_CHAT_ID is not set' });
      void runSettlement();
      void chainClient.connect().catch((error) => logger.debug('rpc_warmup_failed', { message: error?.message }));
      void gameService.refreshTelemetry().catch((error) => logger.debug('telemetry_refresh_failed', { message: error?.message }));
      telemetryTimer = setInterval(() => void gameService.refreshTelemetry().catch((error) => logger.debug('telemetry_refresh_failed', { message: error?.message })), 60_000);
      telemetryTimer.unref();
      // Finished games are readable for a short window, then removed. Prune on
      // the same cadence so the window is honoured while the server runs.
      if (typeof gameService.pruneCompletedGames === 'function') {
        const prune = () => void gameService.pruneCompletedGames().catch((error) => logger.debug('completed_game_prune_failed', { message: error?.message }));
        prune();
        pruneTimer = setInterval(prune, 60_000);
        pruneTimer.unref();
      }
      // Every broadcast operation writes the game record in a separate step.
      // Reconcile often enough that a crash window never strands a creation or
      // join that already reached the network.
      if (typeof gameService.reconcilePendingSubmissions === 'function') {
        const reconcile = () => void gameService.reconcilePendingSubmissions().catch((error) => logger.debug('submission_reconcile_failed', { message: error?.message }));
        reconcile();
        reconcileTimer = setInterval(reconcile, 60_000);
        reconcileTimer.unref();
      }
      // The fallback bot drives itself: it joins and reveals only for the one
      // match it currently holds, so a short cadence is enough and cheap.
      if (botService) {
        const advanceBot = () => void botService.runOnce().catch((error) => logger.debug('bot_scan_failed', { message: error?.message }));
        advanceBot();
        botTimer = setInterval(advanceBot, botService.intervalMs ?? 2_000);
        botTimer.unref();
      }
    },
    stop() { if (settlementTimer) clearTimeout(settlementTimer); if (telemetryTimer) clearInterval(telemetryTimer); if (feedbackTimer) clearInterval(feedbackTimer); if (reconcileTimer) clearInterval(reconcileTimer); if (pruneTimer) clearInterval(pruneTimer); if (botTimer) clearInterval(botTimer); },
  };
}
