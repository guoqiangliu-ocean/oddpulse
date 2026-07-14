import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeSnapshotHistory,
  buildAuditSeries,
  buildAuthenticatedEnvelope,
  ingestSnapshotHistory,
  nextBackgroundCaptureTarget,
  retainSnapshotHistory,
  snapshotFingerprint,
  snapshotHistoryToCsv,
  summarizeSnapshotCoverage,
  type AuthenticatedSnapshotInput,
  type SnapshotMarket,
} from "../app/lib/snapshot-history.ts";

const NOW = 1_800_000_000_000;

function market(
  timestamp: number | null,
  probability: number | null,
  overrides: Partial<SnapshotMarket> = {},
): SnapshotMarket {
  return {
    fixtureId: 42,
    timestamp,
    provider: "Provider A",
    market: "MATCH_RESULT",
    parameters: "",
    period: "match",
    inRunning: true,
    gameState: "IN_PLAY",
    outcomes: [
      { name: "part1", rawPrice: 2_000, probability },
      { name: "draw", rawPrice: 3_200, probability: null },
    ],
    ...overrides,
  };
}

function envelope(
  timestamp: number | null,
  probability: number | null,
  overrides: Partial<AuthenticatedSnapshotInput> = {},
) {
  const result = buildAuthenticatedEnvelope({
    configured: true,
    mode: "authenticated-snapshot",
    network: "devnet",
    fixtureId: 42,
    fetchedAt: timestamp ?? NOW,
    markets: [market(timestamp, probability)],
    ...overrides,
  });
  assert.ok(result);
  return result;
}

test("deduplicates identical upstream content across retrieval times and ordering", () => {
  const firstMarket = market(NOW - 1_000, 0.4);
  const reorderedMarket = {
    ...firstMarket,
    outcomes: [...firstMarket.outcomes].reverse(),
  };
  const first = buildAuthenticatedEnvelope({
    configured: true,
    mode: "authenticated-snapshot",
    network: "DEVNET",
    fixtureId: 42,
    fetchedAt: NOW - 500,
    markets: [firstMarket, firstMarket],
  });
  const second = buildAuthenticatedEnvelope({
    configured: true,
    mode: "authenticated-snapshot",
    network: "devnet",
    fixtureId: 42,
    fetchedAt: NOW,
    markets: [reorderedMarket],
  });

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.id, second.id);
  assert.equal(first.markets.length, 1);
  const ingested = ingestSnapshotHistory([first], second, NOW);
  assert.equal(ingested.inserted, false);
  assert.equal(ingested.duplicate, true);
  assert.equal(ingested.history.length, 1);
});

test("retains corrected prices at one source time and unchanged prices at a new time", () => {
  const baseline = envelope(NOW - 30_000, 0.4);
  const correction = envelope(NOW - 30_000, 0.43);
  const newer = envelope(NOW - 15_000, 0.43);

  assert.notEqual(baseline.id, correction.id);
  assert.notEqual(correction.id, newer.id);
  const corrected = ingestSnapshotHistory([baseline], correction, NOW);
  const advanced = ingestSnapshotHistory(corrected.history, newer, NOW);
  assert.equal(advanced.history.length, 3);
});

test("rejects replay provenance and persists only whitelisted public fields", () => {
  const secret = "TXLINE_SECRET_CANARY";
  const unsafe = {
    configured: true,
    mode: "schema-compatible replay",
    network: "devnet",
    fixtureId: 42,
    fetchedAt: NOW,
    markets: [market(NOW, 0.4)],
    apiToken: secret,
    headers: { Authorization: secret },
    privateKey: secret,
  } as unknown as AuthenticatedSnapshotInput;
  assert.equal(buildAuthenticatedEnvelope(unsafe), null);

  const authenticated = {
    ...unsafe,
    mode: "authenticated-snapshot",
  } as unknown as AuthenticatedSnapshotInput;
  const stored = buildAuthenticatedEnvelope(authenticated);
  assert.ok(stored);
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /TXLINE_SECRET_CANARY|authorization|privateKey/i);
});

test("isolates networks and applies age pruning before the per-fixture cap", () => {
  const devnetOld = envelope(NOW - 400_000, 0.4, { fetchedAt: NOW - 400_000 });
  const devnetRecent = envelope(NOW - 30_000, 0.41);
  const mainnetRecent = envelope(NOW - 20_000, 0.42, { network: "mainnet" });
  const retained = retainSnapshotHistory(
    [devnetOld, devnetRecent, mainnetRecent],
    NOW,
    { maxAgeMs: 180_000, maxPerFixture: 2 },
  );

  assert.deepEqual(
    retained.map((item) => item.network).sort(),
    ["devnet", "mainnet"],
  );
  assert.ok(retained.every((item) => item.id !== devnetOld.id));
});

test("keeps raw-only snapshots in collection mode", () => {
  const rawOnly = [
    envelope(NOW - 30_000, null),
    envelope(NOW - 10_000, null),
  ];
  const observation = analyzeSnapshotHistory(rawOnly, NOW);
  assert.equal(observation.status, "collecting");
  assert.match(observation.reason, /verified probabilities are unavailable/);
});

test("labels a strict six-sample single-provider move as observation only", () => {
  const times = [50_000, 40_000, 30_000, 20_000, 10_000, 1_000];
  const probabilities = [0.4, 0.41, 0.42, 0.44, 0.46, 0.48];
  const history = times.map((age, index) =>
    envelope(NOW - age, probabilities[index]),
  );
  const observation = analyzeSnapshotHistory(history, NOW);

  assert.equal(observation.status, "observed");
  assert.equal(observation.providerCount, 1);
  assert.equal(observation.distinctSourceTimes, 6);
  assert.ok((observation.deltaProbability ?? 0) >= 0.08 - Number.EPSILON);
  assert.match(observation.reason, /single-source movement.*never.*confirmed/i);
});

test("never pairs different market parameters or counts outcomes as providers", () => {
  const baseline = envelope(NOW - 50_000, 0.4, {
    markets: [market(NOW - 50_000, 0.4, { parameters: "line=2.5" })],
  });
  const current = envelope(NOW - 1_000, 0.5, {
    markets: [market(NOW - 1_000, 0.5, { parameters: "line=3.5" })],
  });
  const observation = analyzeSnapshotHistory([baseline, current], NOW);

  assert.equal(observation.status, "collecting");
  assert.equal(observation.providerCount, 1);
  assert.equal(observation.eligiblePairCount, 0);
});

test("fingerprint changes with source time but not retrieval metadata", () => {
  const first = snapshotFingerprint("devnet", 42, [market(NOW - 2_000, 0.4)]);
  const second = snapshotFingerprint("devnet", 42, [market(NOW - 1_000, 0.4)]);
  assert.notEqual(first, second);
});

test("builds exact audit series without crossing provider or line identity", () => {
  const first = envelope(NOW - 30_000, 0.4, {
    markets: [
      market(NOW - 30_000, 0.4, { parameters: "line=2.5" }),
      market(NOW - 30_000, 0.41, {
        provider: "Provider B",
        parameters: "line=2.5",
      }),
      market(NOW - 30_000, 0.42, { parameters: "line=3.5" }),
    ],
  });
  const series = buildAuditSeries([first], {
    network: "devnet",
    fixtureId: 42,
  });

  const part1 = series.filter((item) => item.outcome === "part1");
  assert.equal(part1.length, 3);
  assert.equal(new Set(part1.map((item) => item.key)).size, 3);
});

test("retains raw-only audit rows and flags corrected source-time conflicts", () => {
  const rawOnly = envelope(null, null, {
    fetchedAt: NOW - 5_000,
    markets: [market(null, null)],
  });
  const original = envelope(NOW - 1_000, 0.4);
  const correction = envelope(NOW - 1_000, 0.45);
  const series = buildAuditSeries([rawOnly, original, correction]);
  const part1 = series.find((item) => item.outcome === "part1");

  assert.ok(part1);
  assert.equal(part1.valueMode, "raw");
  assert.equal(part1.points.filter((point) => point.conflict).length, 2);
  assert.equal(
    part1.points.some((point) => point.timestampQuality === "retrieval-only"),
    true,
  );
});

test("exports a scoped fixed-column CSV with escaping and formula protection", () => {
  const secret = "PRIVATE_EMAIL_AND_WALLET_CANARY";
  const parameters = '=SUM(1,2),"quoted"\nline';
  const rawInput = {
    configured: true,
    mode: "authenticated-snapshot",
    network: "devnet",
    fixtureId: 42,
    fetchedAt: NOW,
    markets: [market(null, null, { parameters })],
    email: secret,
    walletSecret: secret,
    headers: { Authorization: secret },
  } as unknown as AuthenticatedSnapshotInput;
  const rawEnvelope = buildAuthenticatedEnvelope(rawInput);
  const otherNetwork = envelope(NOW - 1_000, 0.4, { network: "mainnet" });
  assert.ok(rawEnvelope);
  const selectedSeries = buildAuditSeries([rawEnvelope], {
    network: "devnet",
    fixtureId: 42,
  }).find((series) => series.outcome === "part1");
  assert.ok(selectedSeries);
  const csv = snapshotHistoryToCsv([rawEnvelope, otherNetwork], {
    network: "devnet",
    fixtureId: 42,
    seriesKey: selectedSeries.key,
  });

  assert.match(
    csv,
    /^schema_version,mode,network,fixture_id,provider,market,period,parameters,/,
  );
  assert.match(csv, /retrieval-only,2000,/);
  assert.match(csv, /"'=SUM\(1,2\),""quoted"" line"/);
  assert.doesNotMatch(csv, /mainnet|PRIVATE_EMAIL_AND_WALLET_CANARY/);
  assert.doesNotMatch(csv, /Authorization|walletSecret|email/);
  assert.equal(csv.includes("\r\n"), true);
});

test("round-robins every valid non-selected fixture without changing selection", () => {
  const fixtureIds = [101, 202, 303, 303, -1, 4.5, Number.MAX_SAFE_INTEGER + 1];
  const first = nextBackgroundCaptureTarget(fixtureIds, 202, 0);
  const second = nextBackgroundCaptureTarget(
    fixtureIds,
    202,
    first?.nextCursor ?? 0,
  );
  const wrapped = nextBackgroundCaptureTarget(
    fixtureIds,
    202,
    second?.nextCursor ?? 0,
  );

  assert.deepEqual(first, { fixtureId: 101, nextCursor: 1 });
  assert.deepEqual(second, { fixtureId: 303, nextCursor: 0 });
  assert.deepEqual(wrapped, { fixtureId: 101, nextCursor: 1 });
  assert.equal(nextBackgroundCaptureTarget([202, 202], 202, 0), null);
});

test("summarizes saved coverage per fixture and network", () => {
  const devnet42 = envelope(NOW - 30_000, 0.4);
  const devnet43 = envelope(NOW - 20_000, 0.41, {
    fixtureId: 43,
    markets: [market(NOW - 20_000, 0.41, { fixtureId: 43 })],
  });
  const mainnet42 = envelope(NOW - 10_000, 0.42, { network: "mainnet" });
  const coverage = summarizeSnapshotCoverage(
    [devnet42, devnet43, mainnet42],
    "devnet",
    [42, 43],
  );

  assert.deepEqual(
    coverage.map((item) => [item.fixtureId, item.snapshotCount]),
    [
      [42, 1],
      [43, 1],
    ],
  );
  assert.ok(coverage.every((item) => item.network === "devnet"));
});
