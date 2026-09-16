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
