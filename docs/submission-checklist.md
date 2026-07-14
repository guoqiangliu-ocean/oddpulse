# TxODDS Trading Tools and Agents — submission checklist

Deadline: 2026-07-19 23:59:59 UTC (2026-07-20 03:59:59 Asia/Dubai)

## Eligibility and access

- Listing status: open and global
- Listing ID: `f969d86a-7db1-4191-a264-b64491914660`
- Platform access flag: `HUMAN_ONLY`
- Consequence: an autonomous agent may build the product, but an eligible human,
  team, or entity must own and submit it through a human Superteam account.
- Devnet access: dedicated wallet created; free World Cup Level 1 subscription
  activated for four weeks; API credential verified and stored server-side only.

## Required submission items

- [x] Reviewer-accessible demo video, maximum five minutes
- [x] Public GitHub repository
- [x] Brief project explanation
- [x] Project title: OddPulse
- [x] Publicly accessible working MVP
- [x] Technical documentation in the public repository
- [x] TxLINE API feedback: strongest feature and friction encountered
- [ ] Optional project X profile or post

## Product qualification

- [x] Running tool rather than a pitch deck or mockup
- [x] Deterministic autonomous decision policy
- [x] Replay data is clearly labelled
- [x] TxLINE snapshot adapter and documented field normalization
- [x] Activated TxLINE Devnet token and free-tier subscription
- [x] Authenticated Devnet fixture and odds snapshots connected to the local and deployed UI
- [x] Device-local authenticated history with visible-tab polling, exact
  instrument identity, deduplication, retention, and secret-field whitelisting
- [x] Raw-only and single-source histories are blocked from confirmed-signal claims
- [x] Exact-series audit timeline and local CSV evidence export with separate
  source/retrieval timestamps, conflict labels, and unscaled raw-value disclosure
- [x] All-fixture World Cup collection: selected fixture every 15 seconds,
  non-selected fixtures in 60-second round-robin slots, visible-tab only
- [x] Independent foreground/background request state, strict authenticated
  provenance checks, retry backoff, and per-fixture coverage status
- [ ] Live signal history with sufficient same-instrument, multi-source pairing;
  current signal output remains explicitly labelled synthetic replay
- [x] Public deployment and functional endpoint

## Judging alignment

- Core functionality and ingestion: paired-provider detector, server adapter,
  and authenticated Devnet snapshot access in the deployed UI
- Autonomous operation: interval-driven evaluation with no manual decision input
- Logic and architecture: fair-probability and log-odds thresholds, breadth filter,
  source-pairing, line isolation, explainable confidence
- Innovation: event-aware distinction between unexplained sharp movement and
  repricing after a match event
- Production readiness: secret isolation, guest-session renewal, responsive desk,
  device-local retention, deterministic tests, and explicit data provenance

The public repository, deployed MVP, and reviewer-accessible demo video are
available. OddPulse was submitted to the Superteam Trading Tools and Agents
track on 2026-07-14 through its human-owned profile; the listing now shows
`Edit Submission`. No wallet secret or API token is included in this checklist.
