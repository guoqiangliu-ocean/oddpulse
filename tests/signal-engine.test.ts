import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOddsMovement,
  noVigProbabilities,
  type OddsTick,
} from "../app/lib/signal-engine.ts";

const now = Date.UTC(2026, 6, 14, 19, 15, 0);

function tick(
  provider: string,
  probability: number,
  receivedAt: number,
  overrides: Partial<OddsTick> = {},
): OddsTick {
  return {
    eventId: "fixture-1",
    market: "MATCH_RESULT",
    period: "MATCH",
    selection: "HOME",
    provider,
    decimalOdds: 1 / probability,
    fairProb: probability,
    sourceTs: receivedAt - 100,
    receivedAt,
    phase: "LIVE",
    gameState: "IN_PLAY",
    ...overrides,
  };
}

test("removes a plausible market overround", () => {
  const fair = noVigProbabilities([1.95, 3.6, 4.2]);
  assert.ok(fair);
  assert.ok(Math.abs(fair.reduce((sum, value) => sum + value, 0) - 1) < 1e-10);
});

test("confirms a broad, sharp movement across three paired sources", () => {
  const ticks: OddsTick[] = [];
  for (const provider of ["A", "B", "C"]) {
    ticks.push(tick(provider, 0.44, now - 45_000));
    ticks.push(tick(provider, 0.515, now));
  }
  const result = evaluateOddsMovement(ticks, now);
  assert.ok(result.level === "confirmed" || result.level === "high");
  assert.equal(result.direction, "up");
  assert.equal(result.providersMatched, 3);
});

test("rejects one rogue source when the paired median is stable", () => {
  const ticks: OddsTick[] = [];
  ticks.push(tick("A", 0.44, now - 45_000), tick("A", 0.52, now));
  ticks.push(tick("B", 0.44, now - 45_000), tick("B", 0.441, now));
  ticks.push(tick("C", 0.44, now - 45_000), tick("C", 0.439, now));
  const result = evaluateOddsMovement(ticks, now);
  assert.equal(result.level, "quiet");
  assert.equal(result.action, "MONITOR");
});

test("never pairs different total lines", () => {
  const ticks = [
    tick("A", 0.48, now - 45_000, {
      market: "TOTAL",
      selection: "OVER",
      line: 2.5,
    }),
    tick("A", 0.59, now, {
      market: "TOTAL",
      selection: "OVER",
      line: 3.5,
    }),
  ];
  const result = evaluateOddsMovement(ticks, now);
  assert.equal(result.level, "quiet");
  assert.equal(result.providersMatched, 0);
});
