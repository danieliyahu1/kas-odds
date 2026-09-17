export function deriveGameStatus({ record, confirmation, safetyStatus, automaticBroadcast, confirmedReveals, pendingReveals, pendingSafety }) {
  if (safetyStatus) return record.status;
  if (automaticBroadcast) return `${record.automaticSettlement.action}_broadcast`;
  if (confirmedReveals.some((reveal) => reveal.winner)) return 'settled';
  if (confirmedReveals.length >= 1) return 'first_revealed';
  if (pendingReveals.some((reveal) => reveal.winner)) return 'settlement_broadcast';
  if (pendingReveals.length > 0) return 'reveal_broadcast';
  if (pendingSafety.length > 0) return `${pendingSafety[0].action}_broadcast`;
  if (record.join) return confirmation.status === 'confirmed' ? 'joined' : record.status;
  return confirmation.status === 'confirmed' ? 'waiting_for_player_b' : confirmation.status;
}

export function deriveAvailableActions({ status, firstRevealer }) {
  return {
    safetyAction: status === 'waiting_for_player_b' ? 'creator_refund' : null,
    automaticAction: ['waiting_for_player_b', 'refund_open_broadcast'].includes(status) ? 'refund_open'
      : status === 'first_revealed' ? 'fallback_claim' : status === 'joined' ? 'refund_all' : null,
    canReveal: ['joined', 'first_revealed'].includes(status),
    canCancel: status === 'waiting_for_player_b',
    firstRevealer: firstRevealer ?? null,
  };
}

const TERMINAL_STATUSES = new Set(['settled', 'fallback_claimed', 'refunded', 'creator_refunded', 'refund_partial']);

// The on-chain transactions a player can open to verify a finished game: the
// winning settlement, any claim/refund safety action, and the backend-relayed
// automatic settlement. Only terminal games expose them, and a transaction id is
// listed once.
export function projectTerminalTransactions({ record, confirmedReveals, status }) {
  if (!TERMINAL_STATUSES.has(status)) return [];
  const transactions = [];
  for (const reveal of confirmedReveals) {
    if (reveal.winner && reveal.transactionId) transactions.push({ action: 'settlement', transactionId: reveal.transactionId });
  }
  for (const safety of record.safetyActions ?? []) {
    if (safety.transactionId) transactions.push({ action: safety.action, transactionId: safety.transactionId });
  }
  if (record.automaticSettlement?.transactionId) {
    transactions.push({ action: record.automaticSettlement.action, transactionId: record.automaticSettlement.transactionId });
  }
  const seen = new Set();
  return transactions.filter((transaction) => {
    if (seen.has(transaction.transactionId)) return false;
    seen.add(transaction.transactionId);
    return true;
  });
}
