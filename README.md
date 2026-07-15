# OddPulse

OddPulse is an autonomous football-odds movement monitor built for the TxODDS
World Cup Hackathon. It turns TxLINE snapshots into auditable evidence and
demonstrates an explainable movement policy in a clearly separated replay.

## Project links

- Source code: [GitHub](https://github.com/guoqiangliu-ocean/oddpulse)
- Demo video: [YouTube walkthrough](https://youtu.be/X7bHzndiUsc)
- Live MVP: [Open OddPulse](https://oddpulse-agent.oddpulse-txline-2026.workers.dev/)

## What it does

- pairs current and baseline quotes from the same provider and exact market line;
- uses fair probability rather than a raw price wherever the full market is known;
- rejects a rogue single-provider move when the provider median remains stable;
- requires directional breadth across matched sources before confirming an alert;
- labels price changes following a score or match-state change separately;
- records the action, confidence, evidence, and virtual or source timestamp;
- accepts a live probability only from a complete, coherent market vector;
- exposes a separate quote-proof receipt that fails closed until a read-only
  TxLINE Devnet validation passes;
- runs without human input once the feed is configured.

The included dashboard is fully interactive. An activated Devnet credential now
provides authenticated TxLINE fixture and odds snapshots to the local UI. The
selected fixture is polled every 15 seconds while the tab is visible. Other
explicitly labelled World Cup fixtures are collected one at a time through a
60-second round-robin slot, and deduplicated authenticated snapshots are
retained in device-local IndexedDB.
The signal charts and ledger remain an explicitly labelled, deterministic,
schema-compatible replay because the available history does not yet provide
enough eligible, same-instrument, multi-source pairs for live signal claims.

## Architecture

```mermaid
flowchart LR
  A[TxLINE fixtures and odds] --> B[Server-only adapter]
  B --> C[Schema normalizer]
  C --> H[Authenticated snapshot status and local UI]
  B --> P[Server-only quote proof gate]
  P --> Q[Read-only validateOdds simulation]
  Q --> H
  H --> I[Device-local deduplicated history]
  I --> J[Strict movement eligibility check]
  R[Deterministic paired replay] --> D[Paired quote store]
  D --> E[Movement detector]
  E --> F[Confidence and decision policy]
  F --> G[Signal ledger and dashboard]
```

The browser never receives the TxLINE API token. The server adapter fetches a
short-lived guest JWT, retries once after a `401`, normalizes both documented
field-name variants, and returns only the fields needed by the product.
Local history persists only those normalized public fields. Missing upstream
timestamps remain missing rather than being replaced with local retrieval time.
Only fixtures in the current authenticated World Cup catalogue can be queried.
A vector is shown as probability only when every outcome is present and the
whole vector has one plausible fraction or percentage scale; all other values
remain explicitly unavailable.

## Detector policy

The replay detector profile compares quotes 8–60 seconds apart. A candidate must clear
both a fair-probability and log-odds boundary. With multiple matched providers,
at least 67% must move in the same direction. The confidence score combines:

1. movement magnitude;
2. provider breadth;
3. cross-provider dispersion;
4. timestamp and probability quality.

A single-source move receives a larger threshold and cannot exceed 59%
confidence. Spreads and totals are never compared across different lines.

## Run locally

```bash
npm install
npm run dev
```

The detector remains in clearly labelled replay mode. A valid activated TxLINE
token enables authenticated Devnet snapshot access in the local UI without
turning synthetic replay signals into live claims:

```text
TXLINE_BASE_URL=https://txline-dev.txodds.com
TXLINE_API_TOKEN=...
```

See `.env.example`. Do not put credentials in client-prefixed variables or a
public repository.

## TxLINE activation status

- A dedicated Devnet wallet has been created and its signing material is stored
  locally in encrypted form.
- The free World Cup Level 1 subscription for four weeks has been completed on
  Devnet.
- The TxLINE API token has been activated, stored server-side only, and verified
  against authenticated fixture and odds snapshots.
- Authenticated snapshot availability is surfaced in the local UI. Signal output
  remains labelled synthetic replay until sufficient historical and multi-source
  quote pairing is available.
- While the tab is visible, the selected fixture is sampled every 15 seconds.
  Other World Cup fixtures use a lower-rate 60-second round-robin slot. Hidden,
  closed, sleeping, or manually paused tabs make no requests; this is not a
  server background job.
- Foreground and background collection use separate request state. A busy
  foreground request defers the next background slot, and old fixture responses
  cannot overwrite the newly selected fixture view.
- Only fixtures explicitly labelled `World Cup` with positive safe integer IDs
  enter the collection roster. Identical upstream content is deduplicated;
  corrected prices at one source time and unchanged prices at a newer source
  time remain auditable.
- Raw-price-only snapshots are stored but are not converted into probabilities.
  Single-source threshold crossings can only be labelled observations, never
  confirmed signals.
- The authenticated evidence view groups history by exact network, fixture,
  provider, market, period, parameters, outcome, in-running state, and game
  state. It shows source and retrieval time separately and marks conflicting
  corrections instead of connecting them into a trend.
- A selected exact series can be exported as a device-local CSV. The export uses
  a fixed public-field whitelist, keeps raw prices explicitly unscaled, protects
  spreadsheet formula prefixes, and performs no upload.
- No wallet secret or API token is committed to the repository or sent to the
  browser.

## Quote proof receipt

For a selected authenticated World Cup fixture, the browser may request the
same-origin endpoint:

```text
GET /api/txline-proof?fixtureId=<authenticated-fixture-id>
```

The server selects an exact quote carrying a message ID and source timestamp,
requests a compatible odds-proof record, checks that its fixture/message/time
match the selected quote, and validates its schema before deriving the daily
odds-root PDA. It then invokes `validateOdds` with Solana RPC read-only
simulation (`sigVerify: false` with a replacement blockhash). It never asks a
wallet to sign and never submits a transaction.

`VERIFIED_ONCHAIN` is emitted only after that exact simulation returns `true`.
`PROOF_FETCHED` means a proof was received but did not pass validation;
`AWAITING_PROOF` means the selected snapshot lacks a proof-eligible quote;
`UNAVAILABLE` means no badge was issued. The browser receives a minimal record
summary and status, never a TxLINE credential, raw proof payload, Merkle path,
or RPC request detail.

Official references:

- [World Cup free tier](https://txline.txodds.com/documentation/worldcup)
- [Fetching snapshots](https://txline.txodds.com/documentation/examples/fetching-snapshots)
- [Streaming data](https://txline.txodds.com/documentation/examples/streaming-data)

## Verification

```bash
npm run build
npm test
```

The automated suite covers broad multi-provider movement, rogue-source rejection,
fair-probability normalization, exact instrument matching, authenticated-history
provenance, deduplication, retention, raw-only ineligibility, conflict handling,
exact-series separation, CSV escaping, credential whitelisting, safe fixture
rotation, network-isolated coverage summaries, complete-vector rejection,
signed-byte proof parsing, and proof schema mismatch rejection.

## Current status

- Local interactive MVP: complete
- Publicly accessible MVP deployment: complete — [open OddPulse](https://oddpulse-agent.oddpulse-txline-2026.workers.dev/)
- Deterministic detector and tests: complete
- Server-side TxLINE adapter: complete
- Dedicated Devnet wallet and free four-week Level 1 subscription: complete
- TxLINE API activation and authenticated local and deployed snapshot access: complete
- Device-local authenticated snapshot history, polling, deduplication, and
  conservative eligibility display: complete
- Exact-series evidence timeline, evidence rows, and local CSV export: complete
- Visible-tab collection across every explicitly labelled World Cup fixture,
  with selected/round-robin separation and per-fixture coverage status: complete
- Complete-vector probability gate and authenticated World Cup fixture allowlist:
  complete
- Read-only quote-proof receipt: complete in the release candidate; it stays
  pending or unavailable unless a live Devnet `validateOdds` simulation passes
- Live signal history and multi-source quote pairing: not yet available; the
  dashboard signal output remains explicitly labelled synthetic replay
- Public repository: available on [GitHub](https://github.com/guoqiangliu-ocean/oddpulse)
- Public deployment: available — [live MVP](https://oddpulse-agent.oddpulse-txline-2026.workers.dev/)
- Demo video: available as an [unlisted YouTube walkthrough](https://youtu.be/X7bHzndiUsc)
- Superteam submission: submitted to [Trading Tools and Agents](https://superteam.fun/earn/listing/trading-tools-and-agents) on 2026-07-14

OddPulse is decision support, not a betting executor and not a guarantee of
profit.

## Deployment check

Build and deploy through the existing Cloudflare Worker workflow. The TxLINE
secret is already provisioned and must not be printed or re-entered during an
ordinary release. After deployment, check `/`, `/api/txline`, an authenticated
fixture snapshot, and `/api/txline-proof?fixtureId=<current-fixture-id>`. The
proof endpoint must return `Cache-Control: no-store`, `transactionSubmitted:
false`, and no credential or raw proof payload. A non-verified proof status is
an expected safe outcome until the live proof and Devnet simulation both pass.

The Worker also sets a restrictive Content Security Policy, blocks framing, and
disables camera, microphone, geolocation, payment, and USB permissions.
