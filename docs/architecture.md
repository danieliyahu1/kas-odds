# Architecture

## Runtime Boundaries

The production process starts in `src/server.js`. It composes concrete chain,
store, metrics, feedback, and scheduler dependencies, then starts the HTTP and
metrics listeners. `src/http-application.js` contains the injectable request
handler and route dispatch. `src/backend-game-service.js` is the application
use-case boundary; it does not expose raw wRPC or wallet APIs to callers.

The chain direction is one-way:

```text
HTTP application -> backend game service -> Kaspa chain gateway -> wRPC/WASM
                 -> durable game store
Browser           -> HTTP application
Browser wallet    -> browser signing only
```

`src/network.js` is the single runtime registry of supported networks. The
composition root resolves one profile from `KASPA_NETWORK` and injects it into
the wRPC client, the HTTP application, and the game service; domain modules take
the network id and address prefix as explicit inputs and never read the
environment. The same image therefore serves `mainnet` or `testnet-10`.

`src/chain-adapter.js` normalizes node responses, fee policy, transaction
preparation, submission, and confirmation. Domain and protocol modules remain
environment-independent. `src/index.js` exports reusable protocol building
blocks for library consumers; it is not used to boot the server.

## Game Lifecycle

The backend persists non-secret game records and transaction preparations. Each
create, join, reveal, and terminal action follows the same safety shape:

1. Validate the request and current game state.
2. Prepare a transaction through the chain gateway.
3. Return only the prepared, verifiable transaction to the browser.
4. Verify the wallet-signed SafeJSON before submission.
5. Persist the accepted submission before or with broadcast tracking.
6. Reconcile pending submissions and confirmation state after restart.

The browser stores reveal choices and nonces in IndexedDB. The server never
stores reveal preimages. `public/app-controller.js` serializes polling,
cancels it during navigation or terminal states, and rejects stale responses.

## Persistence And Recovery

`src/backend-game-store.js` is the durable aggregate store. It validates loaded
JSON, creates parent directories, serializes mutations, writes atomically, and
returns clones. `src/feedback.js` uses the same fail-closed rule: only a missing
spill file means an empty queue; malformed or unreadable state is an error.

The deployment uses `/var/lib/kaspa-even-odd/games-mainnet-v10.json` and
`/var/lib/kaspa-even-odd/feedback-spill.json` on the persistent volume; the game
store path is network-scoped so two profiles never share a record set.

## Verification And Delivery

Local checks:

```sh
npm run lint
npm run format:check
npm run check
npm test
npm run coverage
cargo test --locked --manifest-path oracle/Cargo.toml
```

CI validates JavaScript, Rust, the covenant oracle, and Kubernetes manifests,
then builds the ARM64 image. On pushes to `main`, it publishes the immutable
image digest and updates only `deploy/deployment.yaml`. Argo CD synchronizes
that Git revision; CI does not hold cluster credentials or contact Kubernetes.
