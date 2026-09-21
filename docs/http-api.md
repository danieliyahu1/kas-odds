# KasOdds HTTP API

KasOdds is a non-custodial protocol: the backend prepares transactions, a client
signs them with a wallet key it holds locally, and the Kaspa chain enforces the
covenant. There is no browser requirement and no privileged client. A script, a
bot, or an agent can drive the same HTTP API a browser uses.

The backend never holds a player key and never decides an outcome. Confirmed
KasOdds covenant state is authoritative; the API is an interface to the chain,
not a gatekeeper.

- **Base URL:** the server origin, e.g. `http://127.0.0.1:3000`.
- **Network:** a single network per deployment (`testnet-10` by default). Read it
  from `GET /api/config`.
- **Content type:** requests and responses are JSON (`content-type:
  application/json`).

## Conventions

**Error envelope.** Every failure returns:

```json
{ "error": "GAME_NOT_FOUND", "message": "Game was not found", "requestId": "..." }
```

| HTTP | When |
|------|------|
| `400` | Validation or domain error (`error` is a stable code) |
| `404` | `GAME_NOT_FOUND`, `PREPARATION_NOT_FOUND`, `MATCH_NOT_FOUND` |
| `413` | `REQUEST_TOO_LARGE` |
| `429` | `RATE_LIMITED` — respect the `retry-after` header (seconds) |
| `502` | A node/storage dependency is unavailable; retry |

Common codes: `INVALID_JSON`, `INVALID_STAKE`, `INVALID_SIDE`, `INVALID_ADDRESS`,
`INVALID_REVEAL`, `WRONG_NETWORK`, `GAME_NOT_FOUND`, `GAME_NOT_JOINED`,
`GAME_ALREADY_JOINED`, `GAME_EXPIRED`, `GAME_CANCELLED`, `MATCH_NOT_FOUND`,
`MATCH_NOT_READY`, `MATCH_FULL`, `NOT_A_PLAYER`, `PREPARATION_NOT_FOUND`,
`ALREADY_REVEALED`, `ACTION_PENDING`, `ACTION_UNAVAILABLE`, and `REVEAL_WAITING`
(retry shortly).

**Signing.** A `prepare` step returns `txJson` as SafeJSON. Sign it with the
pinned Rusty Kaspa v2.0.1 WASM SDK:

1. `Transaction.deserializeFromSafeJSON(txJson)`.
2. For every input whose `signatureScript` is empty (your wallet funding inputs
   only), call `createInputSignature(tx, index, privateKey, SighashType.All)` and
   assign the result to that input's `signatureScript`.
3. Never touch an input that already carries a script (covenant inputs). Verify
   the signed JSON differs from the prepared JSON **only** in signature scripts
   before submitting. The browser does exactly this in `public/verify.js`.

**Commitments.** A revealed number is committed as
`blake2b256(choice_le64 || nonce32)`, where `choice` is `0` or `1` (8-byte
little-endian), and `nonce` is 32 random bytes. See `src/reveal.js`
(`revealCommitment`). The nonce is secret until reveal.

## Configuration

`GET /api/config`

```json
{
  "network": "testnet-10",
  "addressPrefix": "kaspatest",
  "kaswareNetwork": "testnet-10",
  "protocolVersion": "EO/v10",
  "gameFeePublicKey": "…64 hex…",
  "explorerUrl": "https://…"
}
```

Static; it does not touch the node.

## Matchmaking

Two players are matched before either locks funds. Public queue and private rooms
share the same response shape:

```json
{
  "matchId": "…uuid…",
  "status": "waiting | matched",
  "role": "creator | joiner | null",
  "side": "even | odd | null",
  "gameId": "…64 hex… | null",
  "creation": null,
  "stakeKas": 2,
  "myLimitKas": 2,
  "rivalLimitKas": 2,
  "opponentConnected": false
}
```

`stakeKas` is fixed when matched: the lower of the two players' limits. `role`
and `side` are assigned when matched, at random.

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `POST` | `/api/matchmaking/join` | `{ address, publicKey, limitKas }` | Public queue. Matched against the oldest waiting player; `limitKas` is the maximum stake you accept |
| `POST` | `/api/matchmaking/room` | `{ address, publicKey, stakeKas }` | Create a private room at a fixed stake |
| `POST` | `/api/matchmaking/:matchId/join` | `{ address, publicKey }` | Take the second seat in a private room |
| `GET` | `/api/matchmaking/:matchId?address=…` | — | Poll status; call until `status = matched` |
| `POST` | `/api/matchmaking/:matchId/leave` | `{ address }` | Returns `{ matchId, status: "left" }` |

`address` is a wallet address on the configured network (`kaspatest:…`).
`publicKey` is the 32-byte x-only public key, hex.

## Game lifecycle

Each on-chain step is a `prepare` (backend builds and returns SafeJSON) followed
by `submit` (client signs and returns it). Submissions are idempotent per
preparation.

### Creation (the matched creator)

`POST /api/games/prepare`

```json
{ "creatorAddress": "kaspatest:…", "creatorPublicKey": "…64 hex…",
  "creatorCommitment": "…64 hex…", "side": "even", "stakeKas": 2,
  "matchId": "…uuid… (optional)" }
```

→ `{ "network", "preparedHash", "txJson", "feeSompi", "deadlineDaa", "changeScriptPublicKey" }`

`POST /api/games/submit` — `202`

```json
{ "preparedHash": "…", "signedTxJson": "{…}", "matchId": "…uuid… (optional)" }
```

→ `{ "gameId": "…64 hex…", "network": "testnet-10", "status": "broadcast" }`

The `gameId` is the creation transaction id. `deadlineDaa` is five minutes ahead;
the join must land before it.

### Join (the matched joiner)

`POST /api/games/:gameId/join/prepare`

```json
{ "joinerAddress": "kaspatest:…", "joinerPublicKey": "…64 hex…",
  "joinerCommitment": "…64 hex…", "matchId": "…uuid… (optional)" }
```

→ `{ "gameId", "preparedHash", "txJson", "stakeSompi", "feeSompi", "verification" }`

`POST /api/games/:gameId/join/submit` — `202`

```json
{ "preparedHash": "…", "signedTxJson": "{…}" }
```

→ `{ "gameId", "transactionId", "status": "join_broadcast" }`

### Reveal (both players, in order)

Reveal is two on-chain steps: the first spends the joined escrow and continues the
covenant, the second spends that continuation and settles. Either player may
lead; the second waits for the first to confirm.

`POST /api/games/:gameId/reveal/prepare`

```json
{ "playerAddress": "kaspatest:…", "playerPublicKey": "…64 hex…",
  "choice": 0, "nonceHex": "…64 hex…" }
```

→ `{ "gameId", "preparedHash", "txJson", "feeSompi",
     "stage": "first_reveal | settlement", "verification" }`

If the other player has not confirmed their lead yet, the call fails with
`REVEAL_WAITING`; retry until it succeeds.

`POST /api/games/:gameId/reveal/submit` — `202`

```json
{ "preparedHash": "…", "signedTxJson": "{…}" }
```

→ `{ "gameId", "transactionId", "status": "reveal_broadcast | settlement_broadcast" }`

### Creator refund (cancel before a join)

While the game is still `waiting_for_player_b`, the creator can reclaim their
stake. Timeout settles are automatic and permissionless, so this is the only
safety action exposed.

`POST /api/games/:gameId/creator_refund/prepare`
`{ "playerAddress", "playerPublicKey" }` →
`{ "gameId", "preparedHash", "txJson", "feeSompi", "action": "creator_refund", "verification" }`

`POST /api/games/:gameId/creator_refund/submit`
`{ "preparedHash", "signedTxJson" }` →
`{ "gameId", "transactionId", "status": "creator_refund_broadcast" }`

### Reading a game

`GET /api/games/:gameId` returns the authoritative view used by every client:

```json
{
  "gameId": "…", "network": "testnet-10",
  "status": "waiting_for_player_b | joined | first_revealed | settled | …",
  "confirmationStatus": "confirmed | observed | …",
  "stakeKas": 2,
  "creator": { "address": "kaspatest:…", "side": "even" },
  "joiner": { "address": "kaspatest:…" },
  "deadlineDaa": "…",
  "canJoin": true, "canCancel": false, "canReveal": false,
  "joinTransactionId": "… | null",
  "revealCount": 0, "firstRevealer": "… | null",
  "winner": "creator | joiner | null", "winnerAddress": "… | null",
  "transactions": []
}
```

Also included: `revealedPicks`, `pendingReveals`, `pendingSafety`, `safetyAction`,
`safetyReady`, `safetyRemainingSeconds`, `automaticAction`, `automaticReady`,
`automaticRemainingSeconds`, `automaticSettlement`, and `matchmaking`.

**Status values.** `broadcast` → `waiting_for_player_b` → `join_broadcast` →
`joined` → `reveal_broadcast`/`first_revealed` → `settlement_broadcast` →
`settled`. Terminal safety outcomes: `creator_refunded`, `refunded`,
`fallback_claimed`, `refund_partial`. `transactions` is populated only once the
game is terminal — open those ids on the explorer to verify the covenant spend.

## Idempotency and retries

- **Submissions are idempotent per preparation.** Re-submitting the same
  `preparedHash` returns the same `transactionId` without rebroadcasting.
- **A preparation expires.** If a `submit` returns `PREPARATION_NOT_FOUND`,
  `prepare` again. Reveal preparations are ephemeral.
- **Retry safe errors.** Retry `429` (after `retry-after`), `502`, `REVEAL_WAITING`,
  and network failures. Do not retry validation errors (`400`) or `404`.
- **Keep your secret.** Persist `{ gameId, player, choice, nonce }` durably before
  submitting a reveal, so a crash cannot lose the ability to reveal.

## Health

`GET /healthz` → `{ ok: true, … }` — liveness.
`GET /readyz` → `{ ok: true }` or `503 STORAGE_UNAVAILABLE` — readiness.
`GET /metrics` (if configured on a separate port) — Prometheus text.

## Relay

A small keyed store for passing a payload between clients (for example, a
collaborative signing handoff): `POST /api/relay/:relayId` with any JSON body
returns `{ ok: true }`; `GET /api/relay/:relayId` returns it or `404`. The id is
32 bytes of hex.
