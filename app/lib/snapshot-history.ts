export type SnapshotOutcome = {
  name: string;
  rawPrice: number | null;
  probability: number | null;
};

export type SnapshotMarket = {
  fixtureId: number;
  timestamp: number | null;
  provider: string;
  market: string;
  parameters: string;
  period: string;
  inRunning: boolean;
  gameState: string | number;
  outcomes: SnapshotOutcome[];
};

export type AuthenticatedSnapshotInput = {
  configured: boolean;
  mode: string;
  network: string;
  fixtureId: number;
  fetchedAt: number;
  markets: SnapshotMarket[];
};

export type LocalSnapshotEnvelope = {
  schemaVersion: 1;
  id: string;
  mode: "authenticated-snapshot";
  network: string;
  fixtureId: number;
  retrievedAt: number;
  sourceAsOf: number | null;
  fingerprint: string;
  markets: SnapshotMarket[];
};

export type HistoryPolicy = {
  maxAgeMs: number;
  maxPerFixture: number;
};

export type HistoryObservation = {
  status: "collecting" | "stable" | "observed";
  sampleCount: number;
  distinctSourceTimes: number;
  providerCount: number;
  eligiblePairCount: number;
  selection: string | null;
  market: string | null;
  period: string | null;
  parameters: string;
  deltaProbability: number | null;
  elapsedMs: number | null;
  agreement: number | null;
  reason: string;
};

export type PersistResult = {
  stored: boolean;
  duplicate: boolean;
  history: LocalSnapshotEnvelope[];
};

export type AuditSeriesPoint = {
  sourceAt: number | null;
  retrievedAt: number;
  rawPrice: number | null;
  probability: number | null;
  timestampQuality: "source" | "retrieval-only";
  fingerprint: string;
  conflict: boolean;
};

export type AuditSeries = {
  key: string;
  network: string;
  fixtureId: number;
  provider: string;
  market: string;
  period: string;
  parameters: string;
  outcome: string;
  inRunning: boolean;
  gameState: string;
  valueMode: "probability" | "raw" | "unavailable";
  points: AuditSeriesPoint[];
};

export type AuditScope = {
  network?: string;
  fixtureId?: number;
  seriesKey?: string;
};

export type SnapshotCoverage = {
  network: string;
  fixtureId: number;
  snapshotCount: number;
  latestRetrievedAt: number | null;
  latestSourceAt: number | null;
};

export type BackgroundCaptureTarget = {
  fixtureId: number;
  nextCursor: number;
};

export const LOCAL_HISTORY_DB = "oddpulse-local";
export const LOCAL_HISTORY_STORE = "txlineSnapshotHistory";
export const LOCAL_HISTORY_POLICY: HistoryPolicy = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  maxPerFixture: 2_000,
};
export const LOCAL_CAPTURE_INTERVAL_MS = 15_000;

const MIN_POLICY_AGE_MS = 180_000;
const DB_VERSION = 1;

function normalizedText(value: unknown) {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalMarket(market: SnapshotMarket) {
  const outcomes = market.outcomes
    .map((outcome) => ({
      name: normalizedText(outcome.name),
      rawPrice: finiteNumber(outcome.rawPrice),
      probability: finiteNumber(outcome.probability),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    fixtureId: Math.trunc(market.fixtureId),
    timestamp: finiteNumber(market.timestamp),
    provider: normalizedText(market.provider),
    market: normalizedText(market.market),
    parameters: normalizedText(market.parameters),
    period: normalizedText(market.period),
    inRunning: Boolean(market.inRunning),
    gameState: normalizedText(market.gameState),
    outcomes,
  };
}

function stableMarkets(markets: SnapshotMarket[]): SnapshotMarket[] {
  const unique = new Map<string, ReturnType<typeof canonicalMarket>>();
  for (const market of markets) {
    if (!Number.isFinite(market.fixtureId)) continue;
    const canonical = canonicalMarket(market);
    if (!canonical.provider || !canonical.market || !canonical.period) continue;
    if (!canonical.outcomes.length) continue;
    unique.set(JSON.stringify(canonical), canonical);
  }

  return [...unique.values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((market) => ({
      ...market,
      gameState: market.gameState,
    }));
}

function hashString(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function snapshotFingerprint(
  network: string,
  fixtureId: number,
  markets: SnapshotMarket[],
) {
  const canonical = JSON.stringify({
    network: normalizedText(network).toLowerCase(),
    fixtureId: Math.trunc(fixtureId),
    markets: stableMarkets(markets),
  });
  return `${stableMarkets(markets).length}-${hashString(canonical)}`;
}

export function buildAuthenticatedEnvelope(
  input: AuthenticatedSnapshotInput,
): LocalSnapshotEnvelope | null {
  const network = normalizedText(input.network).toLowerCase();
  const fixtureId = input.fixtureId;
  if (
    input.configured !== true ||
    input.mode !== "authenticated-snapshot" ||
    !network ||
    !Number.isSafeInteger(fixtureId) ||
    fixtureId <= 0 ||
    String(input.fixtureId).startsWith("replay-")
  ) {
    return null;
  }

  const markets = stableMarkets(input.markets).filter(
    (market) => market.fixtureId === fixtureId,
  );
  if (!markets.length) return null;

  const retrievedAt = finiteNumber(input.fetchedAt) ?? Date.now();
  const sourceTimes = markets
    .map((market) => finiteNumber(market.timestamp))
    .filter((value): value is number => value !== null);
  const sourceAsOf = sourceTimes.length ? Math.max(...sourceTimes) : null;
  const fingerprint = snapshotFingerprint(network, fixtureId, markets);

  return {
    schemaVersion: 1,
    id: `${network}|${fixtureId}|${fingerprint}`,
    mode: "authenticated-snapshot",
    network,
    fixtureId,
    retrievedAt,
    sourceAsOf,
    fingerprint,
    markets,
  };
}

export function retainSnapshotHistory(
  history: LocalSnapshotEnvelope[],
  now = Date.now(),
  policy: HistoryPolicy = LOCAL_HISTORY_POLICY,
) {
  const safePolicy = {
    maxAgeMs: Math.max(MIN_POLICY_AGE_MS, policy.maxAgeMs),
    maxPerFixture: Math.max(2, Math.trunc(policy.maxPerFixture)),
  };
  const cutoff = now - safePolicy.maxAgeMs;
  const deduplicated = new Map<string, LocalSnapshotEnvelope>();

  for (const envelope of history) {
    if (
      envelope.schemaVersion !== 1 ||
      envelope.mode !== "authenticated-snapshot" ||
      !Number.isFinite(envelope.retrievedAt) ||
      envelope.retrievedAt < cutoff
    ) {
      continue;
    }
    deduplicated.set(envelope.id, envelope);
  }

  const groups = new Map<string, LocalSnapshotEnvelope[]>();
  for (const envelope of deduplicated.values()) {
    const key = `${envelope.network}|${envelope.fixtureId}`;
    groups.set(key, [...(groups.get(key) ?? []), envelope]);
  }

  return [...groups.values()]
    .flatMap((group) =>
      group
        .sort(
          (left, right) =>
            left.retrievedAt - right.retrievedAt || left.id.localeCompare(right.id),
        )
        .slice(-safePolicy.maxPerFixture),
    )
    .sort(
      (left, right) =>
        left.retrievedAt - right.retrievedAt || left.id.localeCompare(right.id),
    );
}

export function summarizeSnapshotCoverage(
  history: LocalSnapshotEnvelope[],
  network: string,
  fixtureIds: number[],
): SnapshotCoverage[] {
  const normalizedNetwork = normalizedText(network).toLowerCase();
  const ids = [
    ...new Set(
      fixtureIds.filter(
        (fixtureId) => Number.isSafeInteger(fixtureId) && fixtureId > 0,
      ),
    ),
  ];
  const retained = retainSnapshotHistory(history).filter(
    (envelope) =>
      envelope.network === normalizedNetwork && ids.includes(envelope.fixtureId),
  );
  return ids.map((fixtureId) => {
    const fixtureHistory = retained.filter(
      (envelope) => envelope.fixtureId === fixtureId,
    );
    const sourceTimes = fixtureHistory
      .map((envelope) => envelope.sourceAsOf)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    return {
      network: normalizedNetwork,
      fixtureId,
      snapshotCount: fixtureHistory.length,
      latestRetrievedAt: fixtureHistory.length
        ? Math.max(...fixtureHistory.map((envelope) => envelope.retrievedAt))
        : null,
      latestSourceAt: sourceTimes.length ? Math.max(...sourceTimes) : null,
    };
  });
}

export function nextBackgroundCaptureTarget(
  fixtureIds: number[],
  selectedFixtureId: number | null,
  cursor: number,
): BackgroundCaptureTarget | null {
  const candidates = [
    ...new Set(
      fixtureIds
        .filter(
          (fixtureId) => Number.isSafeInteger(fixtureId) && fixtureId > 0,
        )
        .filter((fixtureId) => fixtureId !== selectedFixtureId),
    ),
  ];
  if (!candidates.length) return null;
  const safeCursor = Number.isFinite(cursor)
    ? ((Math.trunc(cursor) % candidates.length) + candidates.length) %
      candidates.length
    : 0;
  return {
    fixtureId: candidates[safeCursor],
    nextCursor: (safeCursor + 1) % candidates.length,
  };
}

export function ingestSnapshotHistory(
  current: LocalSnapshotEnvelope[],
  envelope: LocalSnapshotEnvelope,
  now = Date.now(),
  policy: HistoryPolicy = LOCAL_HISTORY_POLICY,
) {
  const retained = retainSnapshotHistory(current, now, policy);
  if (retained.some((item) => item.id === envelope.id)) {
    return {
      inserted: false,
      duplicate: true,
      history: retained,
    };
  }

  return {
    inserted: true,
    duplicate: false,
    history: retainSnapshotHistory([...retained, envelope], now, policy),
  };
}

type QuotePoint = {
  seriesKey: string;
  instrumentKey: string;
  provider: string;
  selection: string;
  market: string;
  period: string;
  parameters: string;
  inRunning: boolean;
  sourceAt: number;
  retrievedAt: number;
  probability: number;
  valueKey: string;
};

function logit(probability: number) {
  return Math.log(probability / (1 - probability));
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quotePoints(history: LocalSnapshotEnvelope[], now: number) {
  const points: QuotePoint[] = [];
  for (const envelope of history) {
    for (const market of envelope.markets) {
      const sourceAt = finiteNumber(market.timestamp);
      if (sourceAt === null || sourceAt > now + 5_000) continue;
      for (const outcome of market.outcomes) {
        const probability = finiteNumber(outcome.probability);
        if (probability === null || probability < 0.002 || probability > 0.998) {
          continue;
        }
        const identity = [
          envelope.network,
          envelope.fixtureId,
          normalizedText(market.market).toLowerCase(),
          normalizedText(market.period).toLowerCase(),
          normalizedText(market.parameters),
          normalizedText(outcome.name).toLowerCase(),
          String(Boolean(market.inRunning)),
          normalizedText(market.gameState).toLowerCase(),
        ].join("|");
        const provider = normalizedText(market.provider);
        points.push({
          seriesKey: `${identity}|${provider.toLowerCase()}`,
          instrumentKey: identity,
          provider,
          selection: normalizedText(outcome.name),
          market: normalizedText(market.market),
          period: normalizedText(market.period),
          parameters: normalizedText(market.parameters),
          inRunning: Boolean(market.inRunning),
          sourceAt,
          retrievedAt: envelope.retrievedAt,
          probability,
          valueKey: `${probability}|${finiteNumber(outcome.rawPrice)}|${Boolean(
            market.inRunning,
          )}|${normalizedText(market.gameState)}`,
        });
      }
    }
  }
  return points;
}

export function analyzeSnapshotHistory(
  history: LocalSnapshotEnvelope[],
  now = Date.now(),
): HistoryObservation {
  const retained = retainSnapshotHistory(history, now);
  const sourceTimes = new Set<number>();
  const providers = new Set<string>();
  for (const envelope of retained) {
    for (const market of envelope.markets) {
      const timestamp = finiteNumber(market.timestamp);
      if (timestamp !== null) sourceTimes.add(timestamp);
      if (market.provider) providers.add(normalizedText(market.provider));
    }
  }

  const base = {
    sampleCount: retained.length,
    distinctSourceTimes: sourceTimes.size,
    providerCount: providers.size,
    eligiblePairCount: 0,
    selection: null,
    market: null,
    period: null,
    parameters: "",
    deltaProbability: null,
    elapsedMs: null,
    agreement: null,
  };

  if (!retained.length) {
    return {
      ...base,
      status: "collecting",
      reason: "Waiting for the first authenticated local snapshot.",
    };
  }

  const points = quotePoints(retained, now);
  if (!points.length) {
    return {
      ...base,
      status: "collecting",
      reason: "Raw snapshots are saved, but verified probabilities are unavailable.",
    };
  }

  const conflicts = new Set<string>();
  const valuesBySeriesTime = new Map<string, Set<string>>();
  for (const point of points) {
    const key = `${point.seriesKey}|${point.sourceAt}`;
    const values = valuesBySeriesTime.get(key) ?? new Set<string>();
    values.add(point.valueKey);
    valuesBySeriesTime.set(key, values);
    if (values.size > 1) conflicts.add(key);
  }

  const cleanPoints = points.filter(
    (point) => !conflicts.has(`${point.seriesKey}|${point.sourceAt}`),
  );
  const series = new Map<string, QuotePoint[]>();
  for (const point of cleanPoints) {
    series.set(point.seriesKey, [...(series.get(point.seriesKey) ?? []), point]);
  }

  const pairs: Array<{
    instrumentKey: string;
    provider: string;
    selection: string;
    market: string;
    period: string;
    parameters: string;
    inRunning: boolean;
    delta: number;
    deltaLogit: number;
    elapsedMs: number;
    distinctTimes: number;
  }> = [];

  for (const group of series.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.sourceAt - right.sourceAt || left.retrievedAt - right.retrievedAt,
    );
    const latest = ordered.at(-1)!;
    const stalenessLimit = latest.inRunning ? 20_000 : 120_000;
    if (now - latest.sourceAt > stalenessLimit) continue;
    const minAge = latest.inRunning ? 8_000 : 30_000;
    const maxAge = latest.inRunning ? 60_000 : 180_000;
    const baseline = ordered.find((point) => {
      const age = latest.sourceAt - point.sourceAt;
      return age >= minAge && age <= maxAge;
    });
    if (!baseline) continue;
    pairs.push({
      instrumentKey: latest.instrumentKey,
      provider: latest.provider,
      selection: latest.selection,
      market: latest.market,
      period: latest.period,
      parameters: latest.parameters,
      inRunning: latest.inRunning,
      delta: latest.probability - baseline.probability,
      deltaLogit: logit(latest.probability) - logit(baseline.probability),
      elapsedMs: latest.sourceAt - baseline.sourceAt,
      distinctTimes: new Set(ordered.map((point) => point.sourceAt)).size,
    });
  }

  if (!pairs.length) {
    return {
      ...base,
      status: "collecting",
      reason: "A fresh, same-instrument baseline pair has not formed yet.",
    };
  }

  const byInstrument = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    byInstrument.set(pair.instrumentKey, [
      ...(byInstrument.get(pair.instrumentKey) ?? []),
      pair,
    ]);
  }
  const candidates = [...byInstrument.values()].map((group) => {
    const delta = median(group.map((pair) => pair.delta));
    const deltaLogit = median(group.map((pair) => pair.deltaLogit));
    const direction = Math.sign(delta);
    const agreement =
      group.filter((pair) => Math.sign(pair.delta) === direction).length /
      group.length;
    return { group, delta, deltaLogit, agreement };
  });
  const candidate = candidates.sort(
    (left, right) => Math.abs(right.delta) - Math.abs(left.delta),
  )[0];
  const representative = candidate.group[0];
  const providerCount = candidate.group.length;
  const minProbabilityMove = representative.inRunning
    ? providerCount > 1
      ? 0.035
      : 0.056
    : providerCount > 1
      ? 0.025
      : 0.04;
  const minLogitMove = representative.inRunning
    ? providerCount > 1
      ? 0.18
      : 0.288
    : providerCount > 1
      ? 0.14
      : 0.224;
  const enoughSingleSourceHistory =
    providerCount > 1 || representative.distinctTimes >= 6;
  const observed =
    enoughSingleSourceHistory &&
    candidate.agreement >= 0.67 &&
    Math.abs(candidate.delta) >= minProbabilityMove &&
    Math.abs(candidate.deltaLogit) >= minLogitMove;

  return {
    status: observed ? "observed" : "stable",
    sampleCount: retained.length,
    distinctSourceTimes: sourceTimes.size,
    providerCount,
    eligiblePairCount: pairs.length,
    selection: representative.selection,
    market: representative.market,
    period: representative.period,
    parameters: representative.parameters,
    deltaProbability: candidate.delta,
    elapsedMs: Math.max(...candidate.group.map((pair) => pair.elapsedMs)),
    agreement: candidate.agreement,
    reason: observed
      ? providerCount > 1
        ? "A matched multi-source movement was observed; it is not yet a confirmed signal."
        : "A single-source movement was observed; it can never be a confirmed signal."
      : "A valid baseline exists, but the strict movement boundary was not crossed.",
  };
}

export function buildAuditSeries(
  history: LocalSnapshotEnvelope[],
  scope: AuditScope = {},
): AuditSeries[] {
  const groups = new Map<
    string,
    Omit<AuditSeries, "valueMode" | "points"> & {
      points: Map<string, Omit<AuditSeriesPoint, "conflict">>;
    }
  >();

  const scopeNetwork = scope.network
    ? normalizedText(scope.network).toLowerCase()
    : null;
  for (const envelope of retainSnapshotHistory(history)) {
    if (scopeNetwork !== null && envelope.network !== scopeNetwork) continue;
    if (scope.fixtureId !== undefined && envelope.fixtureId !== scope.fixtureId) {
      continue;
    }
    for (const market of envelope.markets) {
      const provider = normalizedText(market.provider);
      const marketName = normalizedText(market.market);
      const period = normalizedText(market.period);
      const parameters = normalizedText(market.parameters);
      const gameState = normalizedText(market.gameState);
      for (const outcome of market.outcomes) {
        const outcomeName = normalizedText(outcome.name);
        const key = JSON.stringify([
          envelope.network,
          envelope.fixtureId,
          provider.toLowerCase(),
          marketName.toLowerCase(),
          period.toLowerCase(),
          parameters,
          outcomeName.toLowerCase(),
          String(Boolean(market.inRunning)),
          gameState.toLowerCase(),
        ]);
        const group = groups.get(key) ?? {
          key,
          network: envelope.network,
          fixtureId: envelope.fixtureId,
          provider,
          market: marketName,
          period,
          parameters,
          outcome: outcomeName,
          inRunning: Boolean(market.inRunning),
          gameState,
          points: new Map(),
        };
        const sourceAt = finiteNumber(market.timestamp);
        const rawPrice = finiteNumber(outcome.rawPrice);
        const probability = finiteNumber(outcome.probability);
        const valueKey = `${rawPrice}|${probability}`;
        const pointKey =
          sourceAt === null
            ? `retrieval-only|${valueKey}`
            : `source|${sourceAt}|${valueKey}`;
        const existing = group.points.get(pointKey);
        if (!existing || envelope.retrievedAt < existing.retrievedAt) {
          group.points.set(pointKey, {
            sourceAt,
            retrievedAt: envelope.retrievedAt,
            rawPrice,
            probability,
            timestampQuality: sourceAt === null ? "retrieval-only" : "source",
            fingerprint: envelope.fingerprint,
          });
        }
        groups.set(key, group);
      }
    }
  }

  return [...groups.values()]
    .map((group): AuditSeries => {
      const valuesBySourceTime = new Map<number, Set<string>>();
      for (const point of group.points.values()) {
        if (point.sourceAt === null) continue;
        const values = valuesBySourceTime.get(point.sourceAt) ?? new Set<string>();
        values.add(`${point.rawPrice}|${point.probability}`);
        valuesBySourceTime.set(point.sourceAt, values);
      }
      const points = [...group.points.values()]
        .map((point) => ({
          ...point,
          conflict:
            point.sourceAt !== null &&
            (valuesBySourceTime.get(point.sourceAt)?.size ?? 0) > 1,
        }))
        .sort(
          (left, right) =>
            (left.sourceAt ?? left.retrievedAt) -
              (right.sourceAt ?? right.retrievedAt) ||
            left.retrievedAt - right.retrievedAt,
        );
      const usable = points.filter((point) => !point.conflict);
      const probabilityCount = usable.filter(
        (point) =>
          point.probability !== null &&
          point.probability >= 0.002 &&
          point.probability <= 0.998,
      ).length;
      const rawCount = usable.filter((point) => point.rawPrice !== null).length;
      return {
        key: group.key,
        network: group.network,
        fixtureId: group.fixtureId,
        provider: group.provider,
        market: group.market,
        period: group.period,
        parameters: group.parameters,
        outcome: group.outcome,
        inRunning: group.inRunning,
        gameState: group.gameState,
        valueMode:
          probabilityCount > 0
            ? "probability"
            : rawCount > 0
              ? "raw"
              : "unavailable",
        points,
      };
    })
    .filter((series) => !scope.seriesKey || series.key === scope.seriesKey)
    .sort(
      (left, right) =>
        left.market.localeCompare(right.market) ||
        left.parameters.localeCompare(right.parameters) ||
        left.provider.localeCompare(right.provider) ||
        left.outcome.localeCompare(right.outcome),
    );
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isoTime(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function snapshotHistoryToCsv(
  history: LocalSnapshotEnvelope[],
  scope: AuditScope = {},
) {
  const header = [
    "schema_version",
    "mode",
    "network",
    "fixture_id",
    "provider",
    "market",
    "period",
    "parameters",
    "outcome",
    "in_running",
    "game_state",
    "source_ts_ms",
    "source_time_utc",
    "retrieved_at_ms",
    "retrieved_time_utc",
    "timestamp_quality",
    "raw_price",
    "probability",
    "conflict",
    "snapshot_fingerprint",
  ];
  const rows = buildAuditSeries(history, scope).flatMap((series) =>
    series.points.map((point) => [
      1,
      "authenticated-snapshot",
      series.network,
      series.fixtureId,
      series.provider,
      series.market,
      series.period,
      series.parameters,
      series.outcome,
      series.inRunning,
      series.gameState,
      point.sourceAt,
      isoTime(point.sourceAt),
      point.retrievedAt,
      isoTime(point.retrievedAt),
      point.timestampQuality,
      point.rawPrice,
      point.probability,
      point.conflict,
      point.fingerprint,
    ]),
  );
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

async function openLocalHistoryDatabase() {
  if (typeof indexedDB === "undefined") {
    throw new Error("Device-local history is unavailable in this browser.");
  }
  const request = indexedDB.open(LOCAL_HISTORY_DB, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(LOCAL_HISTORY_STORE)) {
      const store = database.createObjectStore(LOCAL_HISTORY_STORE, {
        keyPath: "id",
      });
      store.createIndex("byFixture", ["network", "fixtureId"], {
        unique: false,
      });
      store.createIndex("byRetrievedAt", "retrievedAt", { unique: false });
    }
  };
  return requestResult(request);
}

async function readAllLocalHistory() {
  const database = await openLocalHistoryDatabase();
  try {
    const transaction = database.transaction(LOCAL_HISTORY_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(LOCAL_HISTORY_STORE).getAll();
    const result = await requestResult(request);
    await done;
    return result as LocalSnapshotEnvelope[];
  } finally {
    database.close();
  }
}

export async function loadLocalSnapshotCoverage(
  network: string,
  fixtureIds: number[],
) {
  return summarizeSnapshotCoverage(
    await readAllLocalHistory(),
    network,
    fixtureIds,
  );
}

export async function loadLocalSnapshotHistory(
  network: string,
  fixtureId: number,
) {
  const retained = retainSnapshotHistory(await readAllLocalHistory());
  const normalizedNetwork = normalizedText(network).toLowerCase();
  return retained.filter(
    (envelope) =>
      envelope.network === normalizedNetwork && envelope.fixtureId === fixtureId,
  );
}

async function persistEnvelope(envelope: LocalSnapshotEnvelope) {
  const allHistory = await readAllLocalHistory();
  const result = ingestSnapshotHistory(allHistory, envelope);
  const retainedIds = new Set(result.history.map((item) => item.id));
  const staleIds = allHistory
    .filter((item) => !retainedIds.has(item.id))
    .map((item) => item.id);

  if (result.inserted || staleIds.length) {
    const database = await openLocalHistoryDatabase();
    try {
      const transaction = database.transaction(LOCAL_HISTORY_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(LOCAL_HISTORY_STORE);
      if (result.inserted) store.put(envelope);
      for (const id of staleIds) store.delete(id);
      await done;
    } finally {
      database.close();
    }
  }

  return {
    stored: result.inserted,
    duplicate: result.duplicate,
    history: result.history.filter(
      (item) =>
        item.network === envelope.network && item.fixtureId === envelope.fixtureId,
    ),
  } satisfies PersistResult;
}

let persistenceQueue: Promise<unknown> = Promise.resolve();

export function persistLocalSnapshot(envelope: LocalSnapshotEnvelope) {
  const task = persistenceQueue.then(() => persistEnvelope(envelope));
  persistenceQueue = task.catch(() => undefined);
  return task;
}
