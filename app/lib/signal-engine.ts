export type MatchPhase = "PREMATCH" | "LIVE";
export type SignalLevel = "quiet" | "provisional" | "confirmed" | "high";
export type SignalKind = "SHARP_MOVE" | "REPRICING_AFTER_EVENT";

export interface OddsTick {
  eventId: string;
  market: string;
  period: string;
  selection: string;
  line?: number;
  provider: string;
  decimalOdds: number;
  fairProb?: number;
  sourceTs?: number;
  receivedAt: number;
  phase: MatchPhase;
  suspended?: boolean;
  gameState?: string;
}

export interface SignalAssessment {
  key: string;
  level: SignalLevel;
  kind: SignalKind;
  direction: "up" | "down" | "flat";
  baselineProb: number;
  currentProb: number;
  deltaProb: number;
  deltaLogit: number;
  confidence: number;
  severity: number;
  providersMatched: number;
  sameDirectionShare: number;
  dispersion: number;
  action: "MONITOR" | "FLAG" | "ESCALATE";
  reason: string;
  flags: string[];
}

interface ThresholdProfile {
  minAgeMs: number;
  maxAgeMs: number;
  maxCurrentStalenessMs: number;
  minDeltaProb: number;
  minDeltaLogit: number;
}

const PROFILES: Record<MatchPhase, ThresholdProfile> = {
  LIVE: {
    minAgeMs: 8_000,
    maxAgeMs: 60_000,
    maxCurrentStalenessMs: 20_000,
    minDeltaProb: 0.035,
    minDeltaLogit: 0.18,
  },
  PREMATCH: {
    minAgeMs: 30_000,
    maxAgeMs: 180_000,
    maxCurrentStalenessMs: 120_000,
    minDeltaProb: 0.025,
    minDeltaLogit: 0.14,
  },
};

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

const probability = (tick: OddsTick) =>
  clamp(tick.fairProb ?? 1 / tick.decimalOdds, 0.002, 0.998);

const logit = (value: number) => Math.log(value / (1 - value));

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mad(values: number[], center = median(values)) {
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

const quietAssessment = (ticks: OddsTick[]): SignalAssessment => {
  const latest = ticks.at(-1);
  const current = latest ? probability(latest) : 0;
  const key = latest
    ? [
        latest.eventId,
        latest.market,
        latest.period,
        latest.line ?? "",
        latest.selection,
      ].join("|")
    : "unavailable";

  return {
    key,
    level: "quiet",
    kind: "SHARP_MOVE",
    direction: "flat",
    baselineProb: current,
    currentProb: current,
    deltaProb: 0,
    deltaLogit: 0,
    confidence: 0,
    severity: 0,
    providersMatched: 0,
    sameDirectionShare: 0,
    dispersion: 0,
    action: "MONITOR",
    reason: "Waiting for enough paired quotes inside the observation window.",
    flags: ["INSUFFICIENT_HISTORY"],
  };
};

export function evaluateOddsMovement(
  input: OddsTick[],
  now: number,
  sensitivity = 1,
): SignalAssessment {
  const ticks = input
    .filter(
      (tick) =>
        !tick.suspended &&
        Number.isFinite(tick.decimalOdds) &&
        tick.decimalOdds > 1.01 &&
        tick.decimalOdds < 1_000,
    )
    .sort((a, b) => a.receivedAt - b.receivedAt);

  if (!ticks.length) return quietAssessment(ticks);

  const latest = ticks.at(-1)!;
  const profile = PROFILES[latest.phase];
  const groups = new Map<string, OddsTick[]>();

  for (const tick of ticks) {
    const sameInstrument =
      tick.eventId === latest.eventId &&
      tick.market === latest.market &&
      tick.period === latest.period &&
      tick.selection === latest.selection &&
      (tick.line ?? null) === (latest.line ?? null);
    if (!sameInstrument) continue;
    const values = groups.get(tick.provider) ?? [];
    values.push(tick);
    groups.set(tick.provider, values);
  }

  const moves: Array<{
    provider: string;
    base: OddsTick;
    current: OddsTick;
    baseProb: number;
    currentProb: number;
    deltaProb: number;
    deltaLogit: number;
  }> = [];

  for (const [provider, quotes] of groups) {
    const current = quotes.at(-1)!;
    const currentAge = now - current.receivedAt;
    if (currentAge > profile.maxCurrentStalenessMs) continue;

    const baselineQuotes = quotes.filter((quote) => {
      const age = current.receivedAt - quote.receivedAt;
      return age >= profile.minAgeMs && age <= profile.maxAgeMs;
    });
    if (!baselineQuotes.length) continue;

    const targetAge = (profile.minAgeMs + profile.maxAgeMs) / 2;
    const base = [...baselineQuotes].sort(
      (a, b) =>
        Math.abs(current.receivedAt - a.receivedAt - targetAge) -
        Math.abs(current.receivedAt - b.receivedAt - targetAge),
    )[0];
    const baseProb = probability(base);
    const currentProb = probability(current);
    moves.push({
      provider,
      base,
      current,
      baseProb,
      currentProb,
      deltaProb: currentProb - baseProb,
      deltaLogit: logit(currentProb) - logit(baseProb),
    });
  }

  if (!moves.length) return quietAssessment(ticks);

  const deltaProb = median(moves.map((move) => move.deltaProb));
  const deltaLogit = median(moves.map((move) => move.deltaLogit));
  const direction = deltaLogit >= 0 ? 1 : -1;
  const sameDirectionShare =
    moves.filter((move) => Math.sign(move.deltaLogit || direction) === direction)
      .length / moves.length;
  const dispersion = mad(
    moves.map((move) => move.deltaLogit),
    deltaLogit,
  );
  const baselineProb = median(moves.map((move) => move.baseProb));
  const currentProb = median(moves.map((move) => move.currentProb));
  const providerMultiplier = moves.length === 1 ? 1.6 : 1;
  const thresholdProb =
    profile.minDeltaProb * providerMultiplier * clamp(sensitivity, 0.6, 1.5);
  const thresholdLogit =
    profile.minDeltaLogit * providerMultiplier * clamp(sensitivity, 0.6, 1.5);
  const probabilityRatio = Math.abs(deltaProb) / thresholdProb;
  const logitRatio = Math.abs(deltaLogit) / thresholdLogit;
  const magnitudePass =
    (probabilityRatio >= 1 && logitRatio >= 0.5) ||
    (logitRatio >= 1 && probabilityRatio >= 0.5);
  const breadthPass =
    moves.length === 1 ? ticks.length >= 6 : sameDirectionShare >= 0.67;
  const severity = Math.max(probabilityRatio, logitRatio);

  if (!magnitudePass || !breadthPass) {
    return {
      ...quietAssessment(ticks),
      key: [
        latest.eventId,
        latest.market,
        latest.period,
        latest.line ?? "",
        latest.selection,
      ].join("|"),
      baselineProb,
      currentProb,
      deltaProb,
      deltaLogit,
      direction: deltaProb > 0.001 ? "up" : deltaProb < -0.001 ? "down" : "flat",
      severity,
      confidence: Math.round(clamp(severity * 34, 4, 49)),
      providersMatched: moves.length,
      sameDirectionShare,
      dispersion,
      reason: `${moves.length} paired source${moves.length === 1 ? "" : "s"}; move remains below the confirmation boundary.`,
      flags: moves.length === 1 ? ["SINGLE_SOURCE"] : [],
    };
  }

  const magnitudeScore = 15 + 20 * clamp((severity - 1) / 1.5, 0, 1);
  const breadthScore =
    15 * sameDirectionShare + 10 * clamp((moves.length - 1) / 3, 0, 1);
  const consistencyScore =
    15 * (1 - clamp(dispersion / (Math.abs(deltaLogit) + 0.02), 0, 1));
  const qualityScore = moves.every((move) => move.current.sourceTs) ? 10 : 6;
  let confidence = Math.round(
    magnitudeScore + breadthScore + consistencyScore + qualityScore + 15,
  );
  if (moves.length === 1) confidence = Math.min(confidence, 59);
  confidence = clamp(confidence, 0, 99);

  const gameStateChanged = moves.some(
    (move) =>
      move.base.gameState &&
      move.current.gameState &&
      move.base.gameState !== move.current.gameState,
  );
  const kind: SignalKind = gameStateChanged
    ? "REPRICING_AFTER_EVENT"
    : "SHARP_MOVE";
  const level: SignalLevel =
    confidence >= 75 && severity >= 1.35
      ? "high"
      : confidence >= 60
        ? "confirmed"
        : "provisional";
  const action = level === "high" ? "ESCALATE" : level === "quiet" ? "MONITOR" : "FLAG";
  const movePp = Math.abs(deltaProb * 100).toFixed(1);

  return {
    key: [
      latest.eventId,
      latest.market,
      latest.period,
      latest.line ?? "",
      latest.selection,
    ].join("|"),
    level,
    kind,
    direction: direction > 0 ? "up" : "down",
    baselineProb,
    currentProb,
    deltaProb,
    deltaLogit,
    confidence,
    severity,
    providersMatched: moves.length,
    sameDirectionShare,
    dispersion,
    action,
    reason: `${movePp}pp ${direction > 0 ? "rise" : "fall"} confirmed across ${moves.length} paired sources with ${Math.round(sameDirectionShare * 100)}% directional agreement.`,
    flags: moves.length === 1 ? ["SINGLE_SOURCE"] : [],
  };
}

export function noVigProbabilities(decimalOdds: number[]) {
  const implied = decimalOdds.map((odd) => 1 / odd);
  const total = implied.reduce((sum, value) => sum + value, 0);
  if (total < 1 || total > 1.3) return null;
  return implied.map((value) => value / total);
}
