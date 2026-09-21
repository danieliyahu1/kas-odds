# KasOdds

Live: <https://kasodds.com/>

Initial protocol implementation for the non-custodial KasOdds MVP on Kaspa.
The same image serves either Kaspa `mainnet` or `testnet-10`; the network is
selected at runtime with the single `KASPA_NETWORK` environment variable, and
the store file, wRPC node, and fee wallet all follow from it.

Both ways to play begin with an off-chain lobby. "Play someone new" queues the
wallet for matchmaking; "Play with a friend" opens a private room and the host
shares a `/join?room=<sessionId>` link. Funds are locked only after the two
players are matched: the creator signs the creation transaction first, then the
matched opponent signs the join. The invite carries no secret, commitment
preimage, wallet key, or transaction template.

## Stakes

Every game is a **staked** game: both players wager the same amount, and the
winner takes the pot. A stake may be any amount from `1` to `1,000,000 KAS`,
fractions included down to the sompi (eight decimal places). Zero and anything
below `1` KAS is rejected — there is no free-play mode.

The covenant enforces the minimum on-chain, not just the app: every entry
requires `stake >= 1 KAS`. Both players fund their own escrow, so the joined
covenant holds `grossPot = stake * 2`. For a pot of at least 100 KAS, 1% goes to
the game wallet and the winner receives the remainder; smaller pots pay the
winner in full. The game fee is never charged without a winner.


## Current boundary

- `src/network.js` is the single runtime registry of supported Kaspa networks.
  Each profile maps the SDK network id (`mainnet`, `testnet-10`) to its bech32
  address prefix (`kaspa`, `kaspatest`) and KasWare network name
  (`kaspa_mainnet`, `kaspa_testnet_10`). `server-config.js` resolves the profile
  once from `KASPA_NETWORK` and injects it downward; domain code never reads the
  environment.
- `src/protocol.js` validates sides, stake, sompi arithmetic, network, and
  fee separation.
- `src/invite.js` parses and serializes the game-id invite; a friend room link
  is a `/join?room=<sessionId>` matchmaking session id instead.
- `src/backend-game-service.js` is the production game use-case boundary. It
  owns creation, joining, reveal, refund, claim, matchmaking (the public queue
  and invite-only friend rooms), persistence, and recovery orchestration behind
  the HTTP application.
- `src/create-game.js`, `src/join-game.js`, and `src/terminal-lifecycle.js` are
  exported protocol/lifecycle building blocks used by focused tests and library
  consumers; they are not the server's production request path.
- `src/join-transactions.js` builds the join covenant input and doubled-pot
  continuation with ordinary joiner fee inputs kept separate.
- `src/covenant-artifact.js` validates a pinned SilverScript artifact before
  it can be used. SilverScript compilation is intentionally a build-time
  concern; the browser consumes the resulting artifact.
- `src/covenant/kasodds.mjs` derives the per-game covenant instance: it loads
  the pinned artifact, substitutes the game state into the template state span,
  verifies the template hash, and produces the P2SH-256 script and the
  network-prefixed address (`kaspa:` on mainnet, `kaspatest:` on testnet-10).
  Output is byte-for-byte cross-validated against the authoritative
  Rust `covenant-oracle` (see `oracle/`).
- `src/chain-adapter.js` provides the production `KaspaChainAdapter` gateway
  between the game use cases and the chain: `prepareCreation` (UTXOs + live
  priority feerate + local mass/relay floor policy via `src/fee-policy.js`),
  `confirmCreation` gated on one DAA confirmation, and `prepareJoin`
  (doubled-pot continuation with ordinary joiner fee inputs).
- `src/terminal-actions.js` reduces confirmed game state into fallback-claim and
  individual-refund eligibility, including DAA deadlines, race precedence, and
  fail-closed user-facing outcomes.
- `src/terminal-transactions.js` builds KCC entry scripts and Rusty Kaspa v2
  SafeJSON templates for reveal-adjacent terminal actions, claims, and refunds;
  the browser still signs only the prepared transaction.
- `src/recovery.js` reconstructs game state from accepted chain history with a
  one-confirmation buffer, invalidates removed-block checkpoints, classifies
  external transactions, and provides memory and durable JSON recovery stores.
- `public/app.js` is the browser composition root. `public/app-controller.js`
  owns cancellable polling and stale-response protection; browser secrets and
  IndexedDB remain behind `public/secrets.js`.
- `src/backend-game-store.js` persists game records, matchmaking sessions
  (including invite-only friend rooms), and non-secret transaction preparations
  atomically on disk. Reveal preimages are
  never stored here; they live only in the short-lived in-memory
  `src/ephemeral-preparations.js`.
- `src/wasm-transaction.js` loads the pinned WASM SDK (`Transaction`,
  `GenesisCovenantGroup`, `populateGenesisCovenants`, `serializeToSafeJSON`)
  and rejects any wallet mutation of sighash-relevant fields.
- `src/genesis-transaction.js` computes the Rusty Kaspa v2 covenant ID,
  constructs output zero, proves exact fee separation, and rejects any wallet
  SafeJSON mutation outside input signature scripts.
- The Rust `covenant-oracle` (`oracle/`, built from the pinned rusty-kaspa
  v2.0.1 rev `a41a333b…`) is a real-runtime regression oracle for the P2SH-256
  script, covenant address, state span, template hash, and genesis covenant
  id (see `test/covenant-oracle-runtime.test.js`). It depends on the vendored
  `silverscript` submodule (`silverscript-abi` by path) without modifying
  upstream code.

## Pinned KasOdds covenant (network-agnostic)

The canonical covenant artifact is compiled by the `silverc` binary
from SilverScript `v1.0.0` (whose emitted artifact/compiler identifier remains
`0.1.0`) from `covenant/kasodds.sil` into
`covenant/kasodds.template.artifact.json`. The artifact is identical on both
networks: only the bech32 address prefix differs (Toccata covenants are live on
mainnet and testnet-10, and the pinned WASM SDK is the mainnet Toccata release).

- **contract**: `KasOdds`, template hash `ade3453c…7e27a`
- **state span**: `offset 1, len 261` (13 fields: `creator_hash`,
  `joiner_hash`, `creator_commit`, `joiner_commit`, `stake`, `deadline_daa`,
  `creator_even`, `creator_choice`, `joiner_choice`, `first_revealer_hash`,
  `game_wallet_hash`, `status`, `settle_fee`)
- **dispatch tags**: `join = b1d2ce8f`, `refund = 762ffa55`, `refund_open = 3a658a5b`
- **terminal dispatch tags**: `reveal = 6b547798`, `fallback_claim = e8bae487`,
  `refund_all = 0e2b436c`
- **P2SH-256**: `0xaa 0x20 <blake2b-256(redeemScript)>`; address prefix is the
  configured network's (`kaspa` or `kaspatest`), version byte 8.
- **reproducibility manifest**: `covenant/pins.json` pins the SilverScript
  release, source commit, emitted compiler version, plus source, artifact, and
  local Windows compiler SHA-256 values.

The ABI, state layout, compiler revision, covenant artifact, Rusty Kaspa v2.0.1
WASM release checksum, fee-input selection, and fee-rate policy are all pinned
before real funds are accepted. See `covenant/pins.json` (`rustyKaspa.status =
"pinned"`, `wasmReleaseSha256`, `vendoredWasmFileSha256`).
The obsolete npm `kaspa-wasm@0.13.0` package is intentionally not used for
covenant transaction construction.

## Verification

```sh
npm test
npm run check
```

`silverscript/` is a pinned git submodule (upstream `kaspanet/silverscript` at
`v1.0.0`). The `covenant-oracle-runtime` tests need its `silverscript-abi`
crate, so initialize the submodule and build the standalone oracle before
running them:

```sh
git submodule update --init
cd oracle && cargo build --release && cd ..
```

## Deployment

The repository includes a production container and Kubernetes manifests under
`deploy/`. The runtime process exposes Kubernetes probe endpoints only; the
production request path is `src/server.js` -> `src/http-application.js` ->
`src/backend-game-service.js`. `src/index.js` is a convenience aggregate for
library consumers, not the server entry point. See
[`docs/architecture.md`](docs/architecture.md) for the dependency direction and
recovery boundaries.

`git push` to `main` is the deploy button. CI builds the `linux/arm64` image,
smoke-tests the published artifact against `/readyz` and `/metrics`, pushes the
immutable `sha-<commit>` tag to GHCR, and commits the exact published digest
into `deploy/deployment.yaml` (`deploy: sha-<commit>`), preserving the source
commit in the `kasodds/source-revision` annotation. The generated commit
touches only `deploy/deployment.yaml`, which is excluded from the workflow
trigger, so the delivery flow terminates without recursing. Argo CD syncs the
cluster to Git — `prune` + `selfHeal` keep Git authoritative — so the pod rolls
to the new digest automatically. CI never talks to Kubernetes and holds no
cluster credential; there is no second deploy path.

Pull requests run the full validation plus an ARM64 image build (without
publishing). Several pushes in quick succession cancel obsolete in-flight
builds so the newest revision wins, and CI refuses to advance the manifest if a
newer source push has already landed on `main`.

Local verification mirrors the CI gate:

```sh
npm run check
npm test
docker build --platform linux/arm64 -t ghcr.io/danieliyahu1/kas-odds/kasodds:sha-<git-sha> .
```

`deploy/deployment.yaml` pins the immutable image for the current release; the
image line is updated by CI, never by hand. Deleting a file under `deploy/`
removes the corresponding object from the cluster (Argo prunes it).

Runtime details:

- Namespace: `kasodds`
- Public port: `3000`; internal metrics port: `9464`
- Readiness endpoint: `/readyz` (returns 503 unless the state volume is both
  readable and writable and the store parses as valid JSON)
- Liveness endpoint: `/healthz` (process liveness only)
- Required runtime secrets: none beyond the fee wallet identity. The app holds
  no private key — the fee wallet is a public address — so it is never a literal
  in this repository. In the cluster the Deployment reads it from the
  `kasodds-game-fee-address` Secret (keys `mainnet` and `testnet-10`,
  filled from the OCI Vault entries `kasodds-game-fee-address-mainnet`
  and `kasodds-game-fee-address-testnet-10`) via `valueFrom.secretKeyRef`;
  locally the same values are set with `--env-file=.env` (the `.env` file is
  gitignored). Wallet private keys never leave the browser.
- Required network: `KASPA_NETWORK` is the single switch and must be `mainnet`
  or `testnet-10` — the process fails closed when it is unset or unknown. Each
  profile fixes the address prefix (`kaspa` / `kaspatest`) and the KasWare
  network name (`kaspa_mainnet` / `kaspa_testnet_10`), and the SDK resolver
  picks the matching wRPC node. `KASPA_WRPC_URL` is an optional override that
  pins a specific node. Every other network-specific value (the store file and
  the fee wallet, below) follows from `KASPA_NETWORK`, so switching networks
  changes exactly one variable. The browser never talks
  to a node directly; all chain reads, fee estimation, transaction preparation,
  and broadcast happen server-side.
- The conditional on-chain game fee: each network has its own recipient wallet,
  supplied as `GAME_FEE_ADDRESS_MAINNET` and `GAME_FEE_ADDRESS_TESTNET_10` (a
  shared `GAME_FEE_ADDRESS` is still the fallback when the qualified name is
  absent), so `KASPA_NETWORK` alone decides which wallet is used. Both live in
  the `kasodds-game-fee-address` Secret — keys `mainnet` and
  `testnet-10` — which the ExternalSecret fills from the OCI Vault entries
  `kasodds-game-fee-address-mainnet` and
  `kasodds-game-fee-address-testnet-10` by name, so no value is ever in
  Git. The wallet receives 1% of the total
  locked pot
  when the pot is at least 100 KAS and the game settles with a winner (second
  reveal or fallback claim). Smaller pots have no platform fee. Kaspa
  version-0 (PubKey) addresses embed the recipient's x-only public key
directly, so the server decodes the address at startup and bakes that key
  into every game's covenant state. Each player locks exactly the displayed
  stake; automatic timeout refunds reserve 0.016 KAS from the locked amount for
  the network fee, while winner settlement pays the game fee from the total pot.
  The fee recipient is runtime configuration: the process boots without one,
  reports
  `gameFeePublicKey: null` from `/api/config`, and rejects game creation with
  `INVALID_GAME_FEE` until it is configured — so a misconfigured pod never
  serves a game without a fee recipient. The Deployment reads the keys with
  `valueFrom.secretKeyRef`, so the pod is not created when the Secret is
  missing, and each address prefix must match `KASPA_NETWORK` (a mismatched
  prefix is rejected at startup).
- Required persistent storage: the `kasodds-state` PVC mounted at
  `/var/lib/kasodds` stores non-secret backend game metadata. The store
  file is derived from the network — `GAME_STORE_DIR` plus
  `games-<network>-v10.json` — so a network switch never points two networks at
  one file; `GAME_STORE_PATH` remains an explicit override, and locally it
  defaults under `.data/`. The volume is `ReadWriteOnce` and only ever mounted by
  a single replica; the Deployment uses `strategy: Recreate` for that reason.
- Request controls: `MAX_REQUEST_BYTES` (default 1,000,000) caps request bodies,
  and `RATE_LIMIT_PER_MINUTE` (default 300) caps mutating API calls per client.
  Set `TRUST_PROXY=true` only behind a trusted proxy that rewrites
  `x-forwarded-for`. The in-memory relay expires entries after 10 minutes and
  caps payloads and entry count; the server holds no reveal secret.
- Logging: `LOG_LEVEL` (default `info`; `debug` adds static-asset requests) and
  `LOG_FORMAT` (`text` or `json`). Each request logs its method, route template,
  status, duration, and any protocol error code/message. Logs never contain
  request bodies, wallet addresses, keys, nonces, signatures, or transaction
  ids. For a debug session only, `LOG_WALLET_ADDRESSES=1` reveals full wallet
  addresses on every server operation while still redacting keys, nonces,
  signatures, commitments, and bodies; leave it unset in production. In the
  browser, add `?debug=1` (or set `localStorage['kasodds-debug'] = '1'`)
  for verbose `[kasodds]` console tracing of the wallet flow; warnings and
  errors are always printed.
- Feedback: the top-bar **Feedback** button posts anonymous feedback to
  `POST /api/feedback`. The server validates it (1–1,500 characters), writes it
  to the state volume before anything can fail, and forwards it to a private
  Telegram chat via `sendMessage` (`parse_mode` off, web preview disabled). The
  bot token (`TELEGRAM_FEEDBACK_BOT_TOKEN`) and chat id
  (`TELEGRAM_FEEDBACK_CHAT_ID`) are runtime-only configuration read from the
  `kasodds-telegram` Secret (keys `bot-token` and `chat-id`, filled from
  the OCI Vault entries `kasodds-telegram-bot-token` and
  `kasodds-telegram-chat-id`). Feedback is just the message the user wrote
  — no wallet address, game id, transaction, page, or query string is attached,
  and the text is never logged. When Telegram is not configured the feedback is
  still stored in the queue — never discarded — records a
  `kasodds_feedback_total{outcome="disabled"}` metric, and logs a
  `feedback_delivery_disabled` warning so a missing bot is noticed without
  breaking the app; it is delivered automatically the next time the app starts
  with the bot configured. Deliveries that fail are queued at
  `FEEDBACK_SPILL_PATH` (default `/var/lib/kasodds/feedback-spill.json`)
  and retried on startup and every two minutes until they land, so outages never
  lose a message. A per-client limit of five submissions per ten minutes keeps
  the channel spam-free.

Observability:

- The serving process exposes Prometheus metrics on `9464` at `/metrics`
  (requests, errors, latency, wRPC calls, store operations, matchmaking
  backlog, relay entries, process memory). The public Service does not expose
  this port.
- `deploy/metrics-service.yaml` and `deploy/vmservicescrape.yaml` register the
  scrape target with the VictoriaMetrics operator.
- `deploy/grafana-dashboard.yaml` provisions the "KasOdds" dashboard
  into the `observability` namespace via the `grafana_dashboard: "1"` label.

## Trust model

The browser is a thin client and the server coordinates every game. The hidden
number and nonce are generated in the browser and never leave it until reveal:

- `public/secrets.js` stores each game's hidden number in IndexedDB under a
  fresh 32-byte `crypto.getRandomValues` nonce, saved before any funds are
  locked. Only the commitment hash is sent to the server. The secret is deleted
  once the game settles, is claimed, or is refunded.
- `public/verify.js` independently re-derives the covenant and checks the
  prepared creation output before KasWare is asked to sign, so a compromised
  server cannot substitute a different commitment, side, stake, or covenant.
- `public/app.js` drives the flow: create → reveal → refund/claim, signing each
  server-prepared transaction with KasWare and returning it for broadcast.
- `src/wasm-loader.mjs` loads the pinned Rusty Kaspa v2.0.1 SDK in Node and
  verifies the WASM binary against the pinned SHA-256 before use.
- `src/covenant/kasodds-core.mjs` is the isomorphic, `Buffer`-free covenant
  derivation; `src/covenant/template.mjs` supplies the pinned artifact.
- The server sends a strict `Content-Security-Policy` (same-origin scripts,
  `wasm-unsafe-eval`, `connect-src 'self'`, no objects/frames) as
  defense-in-depth against XSS reading the browser-local reveal secret.

The commit-reveal covenant enforces the result on-chain. The server sees only
the commitment hash at create/join time. It learns the number and nonce only
when it prepares the reveal transaction — after both commitments are confirmed
on-chain and the number is public by design — so a server that also plays as a
player cannot change its committed number after seeing an opponent's.

Both paths use the same off-chain lobby. A public game is "play up to": each
player sets the most they are comfortable playing, the server pairs any two
waiters, and the stake is the lower of the two limits. A friend game is a
private room: the host fixes the stake and shares a `/join?room=<sessionId>`
link, and only the wallet holding that link can take the second seat. In both
cases the server assigns each player a side at match time, and no funds move
until both players pick a number and lock: the assigned creator signs the
creation transaction to escrow their stake, and the matched opponent signs the
join to take the other side. Until a join confirms,
  the creator can reclaim their full stake at any time by signing the `refund`
  spend (the server builds and relays it), and after the deadline the
  permissionless `refund_open` entry can reclaim the creator's stake with no
  signature, reserving the network fee from that lock. The server builds and
  broadcasts every transaction, so it is required for the normal flow; the
  covenant still enforces the reveal/claim/refund timeouts on-chain regardless
  of who broadcasts.

## Support

If you like this repo, you can tip me at [https://kas.coffee/danieliyahu](https://kas.coffee/danieliyahu).
