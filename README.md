# Kaspa Even/Odd

Live: <https://kaspa-even-odd.danieliyahu.com/>

Initial protocol implementation for the non-custodial Even/Odd MVP on
Kaspa `testnet-10`.

The join flow is invite-only. A creator shares a URL containing only the
protocol version and confirmed game identifier. The URL never contains a
secret, commitment preimage, wallet key, or transaction template.

## Current boundary

- `src/protocol.js` validates sides, stake, sompi arithmetic, network, and
  fee separation.
- `src/invite.js` parses and serializes the URL invite.
- `src/create-game.js` validates the creation intent, requires a chain service
  to prepare and verify Rusty Kaspa v2 SafeJSON, delegates signing only to
  KasWare, checkpoints the non-secret lifecycle for recovery, and shares the
  confirmed transaction ID only after authoritative revalidation.
- `src/join-game.js` parses direct invites, re-reads confirmed game state,
  enforces the joining deadline and exact matching stake, and checkpoints the
  join signing, broadcast, confirmation, and recovery lifecycle.
- `src/join-transactions.js` builds the join covenant input and doubled-pot
  continuation with ordinary joiner fee inputs kept separate.
- `src/covenant-artifact.js` validates a pinned SilverScript artifact before
  it can be used. SilverScript compilation is intentionally a build-time
  concern; the browser consumes the resulting artifact.
- `src/covenant/even-odd.mjs` derives the per-game covenant instance: it loads
  the pinned artifact, substitutes the game state into the template state span,
  verifies the template hash, and produces the P2SH-256 script and `kaspatest:`
   address. Output is byte-for-byte cross-validated against the authoritative
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
- `src/terminal-lifecycle.js` provides the authoritative read, idempotent
  checkpoint, sign, submit, confirmation, and recovery lifecycle for terminal
  actions.
- `src/recovery.js` reconstructs game state from accepted chain history with a
  one-confirmation buffer, invalidates removed-block checkpoints, classifies
  external transactions, and provides memory and durable JSON recovery stores.
- `src/backend-game-service.js` is the game use-case layer. It owns chain
  communication end to end: it prepares create/join/reveal/refund/claim
  transactions, verifies KasWare-signed SafeJSON, and broadcasts to the node.
  The browser only ever sends the commitment hash until the reveal, when the
  number becomes public on-chain anyway, so the server never learns a hidden
  number before both commitments are confirmed. It also pairs matchmaking
  players and attaches the creator's on-chain game to the match.
- `src/backend-game-store.js` persists game records, matchmaking sessions, and
  non-secret transaction preparations atomically on disk. Reveal preimages are
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
  script, `kaspatest:` address, state span, template hash, and genesis covenant
  id (see `test/covenant-oracle-runtime.test.js`). It depends on the vendored
  `silverscript` submodule (`silverscript-abi` by path) without modifying
  upstream code.

## Pinned Even/Odd covenant (testnet-10)

The canonical testnet covenant artifact is compiled by the `silverc` binary
from SilverScript `v1.0.0` (whose emitted artifact/compiler identifier remains
`0.1.0`) from `covenant/even_odd.sil` into
`covenant/even_odd.template.artifact.json`:

- **contract**: `EvenOdd`, template hash `4db84ab2…fb9d13f`
- **state span**: `offset 1, len 261` (13 fields: `creator_hash`,
  `joiner_hash`, `creator_commit`, `joiner_commit`, `stake`, `deadline_daa`,
  `creator_even`, `creator_choice`, `joiner_choice`, `first_revealer_hash`,
  `game_wallet_hash`, `status`, `settle_fee`)
- **dispatch tags**: `join = b1d2ce8f`, `refund = 762ffa55`, `refund_open = 3a658a5b`
- **terminal dispatch tags**: `reveal = 6b547798`, `fallback_claim = e8bae487`,
  `refund_all = 0e2b436c`
- **P2SH-256**: `0xaa 0x20 <blake2b-256(redeemScript)>`; address prefix
  `kaspatest`, version byte 8.
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
protocol implementation remains the module exported by `src/index.js`.

`git push` to `main` is the deploy button. CI builds the `linux/arm64` image,
smoke-tests the published artifact against `/readyz` and `/metrics`, pushes the
immutable `sha-<commit>` tag to GHCR, and commits the exact published digest
into `deploy/deployment.yaml` (`deploy: sha-<commit>`), preserving the source
commit in the `kaspa-even-odd/source-revision` annotation. The generated commit
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
docker build --platform linux/arm64 -t ghcr.io/danieliyahu1/kaspa-even-odd/kaspa-even-odd:sha-<git-sha> .
```

`deploy/deployment.yaml` pins the immutable image for the current release; the
image line is updated by CI, never by hand. Deleting a file under `deploy/`
removes the corresponding object from the cluster (Argo prunes it).

Runtime details:

- Namespace: `kaspa-even-odd`
- Public port: `3000`; internal metrics port: `9464`
- Readiness endpoint: `/readyz` (returns 503 unless the state volume is both
  readable and writable and the store parses as valid JSON)
- Liveness endpoint: `/healthz` (process liveness only)
- Required runtime secrets: none beyond the fee wallet identity. The app holds
  no private key — `GAME_FEE_ADDRESS` is a public wallet address — so it is
  never a literal in this repository. In the cluster the Deployment reads it
  from the `kaspa-even-odd-fee-address` Secret (`address` key) via
  `valueFrom.secretKeyRef`; locally it is set with `--env-file=.env` (the
  `.env` file is gitignored). Wallet private keys never leave the browser.
- Required network: `KASPA_NETWORK=testnet-10` (the process fails closed for
  any other value); `KASPA_WRPC_URL` pins the server's testnet-10 wRPC node
  (the SDK resolver is the fallback). The browser never talks to a node
  directly; all chain reads, fee estimation, transaction preparation, and
  broadcast happen server-side.
- The conditional on-chain game fee: `GAME_FEE_ADDRESS` is the `kaspatest:`
  wallet address of the game wallet that receives 1% of the total locked pot
  when the pot is at least 100 KAS and the game settles with a winner (second
  reveal or fallback claim). Smaller pots have no platform fee. Kaspa
  version-0 (PubKey) addresses embed the recipient's x-only public key
directly, so the server decodes the address at startup and bakes that key
  into every game's covenant state. Each player locks exactly the displayed
  stake; automatic timeout refunds reserve 0.016 KAS from the locked amount for
  the network fee, while winner settlement pays the game fee from the total pot.
  The fee recipient is runtime-only
  configuration: the process boots without it, reports
  `gameFeePublicKey: null` from `/api/config`, and rejects game creation with
  `INVALID_GAME_FEE` until it is configured — so a misconfigured pod never
  serves a game without a fee recipient. Create the cluster Secret out-of-band
  (its value never lives in Git):
  `kubectl create secret generic kaspa-even-odd-fee-address --from-literal=address=kaspatest:...`
  The Deployment references it with `valueFrom.secretKeyRef`, so the pod also
  fails to be created when the Secret is missing.
- Required persistent storage: the `kaspa-even-odd-state` PVC mounted at
  `/var/lib/kaspa-even-odd` stores non-secret backend game metadata. It is
  `ReadWriteOnce` and only ever mounted by a single replica; the Deployment uses
  `strategy: Recreate` for that reason.
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
  browser, add `?debug=1` (or set `localStorage['kaspa-debug'] = '1'`)
  for verbose `[even-odd]` console tracing of the wallet flow; warnings and
  errors are always printed.
- Feedback: the top-bar **Feedback** button posts anonymous feedback to
  `POST /api/feedback`. The server validates it (1–1,500 characters), writes it
  to the state volume before anything can fail, and forwards it to a private
  Telegram chat via `sendMessage` (`parse_mode` off, web preview disabled). The
  bot token (`TELEGRAM_FEEDBACK_BOT_TOKEN`) and chat id
  (`TELEGRAM_FEEDBACK_CHAT_ID`) are runtime-only configuration read from the
  `kaspa-even-odd-telegram` Secret. Feedback is just the message the user wrote
  — no wallet address, game id, transaction, page, or query string is attached,
  and the text is never logged. When Telegram is not configured the feedback is
  still stored in the queue — never discarded — records a
  `kaspa_feedback_total{outcome="disabled"}` metric, and logs a
  `feedback_delivery_disabled` warning so a missing bot is noticed without
  breaking the app; it is delivered automatically the next time the app starts
  with the bot configured. Deliveries that fail are queued at
  `FEEDBACK_SPILL_PATH` (default `/var/lib/kaspa-even-odd/feedback-spill.json`)
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
- `deploy/grafana-dashboard.yaml` provisions the "Kaspa Even/Odd" dashboard
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
- `src/covenant/even-odd-core.mjs` is the isomorphic, `Buffer`-free covenant
  derivation; `src/covenant/template.mjs` supplies the pinned artifact.
- The server sends a strict `Content-Security-Policy` (same-origin scripts,
  `wasm-unsafe-eval`, `connect-src 'self'`, no objects/frames) as
  defense-in-depth against XSS reading the browser-local reveal secret.

The commit-reveal covenant enforces the result on-chain. The server sees only
the commitment hash at create/join time. It learns the number and nonce only
when it prepares the reveal transaction — after both commitments are confirmed
on-chain and the number is public by design — so a server that also plays as a
player cannot change its committed number after seeing an opponent's.

The friend invite URL (`/join?v=…&game=<gameId>`) carries only the protocol
version and confirmed game identifier; the server holds the rest of the public
creation state. A rival game works the same way, except the server introduces
the two players and attaches the creator's on-chain game to the matchmaking
session. Matchmaking is "play up to": each player sets the most they are
comfortable playing, the server pairs any two waiters, and the game is the
lower of the two limits. Acceptance is on-chain, not off-chain: the assigned
creator signs the creation transaction to lock their escrow, and the matched
  rival signs the join transaction to take the other side. Until a join confirms,
  the permissionless `refund_open` entry can reclaim the creator's stake after
  the deadline, reserving the network fee from that lock. The server builds and
  broadcasts every transaction, so it is required for the normal flow; the
  covenant still enforces the reveal/claim/refund timeouts on-chain regardless
  of who broadcasts.

## Support

If you like this repo, you can tip me at [https://kas.coffee/danieliyahu](https://kas.coffee/danieliyahu).
