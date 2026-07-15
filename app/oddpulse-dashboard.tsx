"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  evaluateOddsMovement,
  type OddsTick,
  type SignalAssessment,
} from "./lib/signal-engine";
import {
  analyzeSnapshotHistory,
  buildAuditSeries,
  buildAuthenticatedEnvelope,
  loadLocalSnapshotHistory,
  loadLocalSnapshotCoverage,
  LOCAL_CAPTURE_INTERVAL_MS,
  nextBackgroundCaptureTarget,
  persistLocalSnapshot,
  snapshotHistoryToCsv,
  type AuditSeriesPoint,
  type LocalSnapshotEnvelope,
  type SnapshotMarket,
} from "./lib/snapshot-history";

type FixtureDefinition = {
  id: string;
  home: string;
  away: string;
  score: string;
  clock: string;
  market: string;
  selection: string;
  phase: "LIVE" | "PREMATCH";
  probabilities: number[];
  drawShare: number;
};

type ConnectorState = {
  status: "checking" | "replay" | "ready" | "error";
  network: string;
  fixtureCount: number;
  worldCupCount: number;
  message: string;
};

type TxLineFixtureSnapshot = {
  fixtureId: number;
  participant1: string;
  participant2: string;
  participant1IsHome: boolean;
  home: string;
  away: string;
  startTime: string | number | null;
  competition: string;
  gameState: string | number;
};

type TxLineMarketSnapshot = SnapshotMarket;

type SnapshotState = {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  fixtures: TxLineFixtureSnapshot[];
  markets: TxLineMarketSnapshot[];
  fetchedAt: number | null;
  message: string;
};

type QuoteProofState = {
  status:
    | "idle"
    | "loading"
    | "verified"
    | "fetched"
    | "awaiting"
    | "unavailable"
    | "error";
  fixtureId: number | null;
  sourceTimestamp: number | null;
  provider: string | null;
  market: string | null;
  messageId: string | null;
  dailyOddsPda: string | null;
  treeNodes: number;
  message: string;
};

type LocalHistoryState = {
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  history: LocalSnapshotEnvelope[];
  lastWrite: "stored" | "duplicate" | null;
  message: string;
};

type FixtureCaptureState = {
  status: "waiting" | "capturing" | "stored" | "unchanged" | "empty" | "error";
  savedSnapshots: number;
  marketCount: number;
  lastAttemptAt: number | null;
  lastStoredAt: number | null;
  message: string;
};

type AlertRecord = {
  id: string;
  fixtureId: string;
  match: string;
  selection: string;
  direction: "up" | "down" | "flat";
  shift: number;
  confidence: number;
  level: SignalAssessment["level"];
  time: string;
};

const DEMO_START = Date.UTC(2026, 6, 14, 19, 12, 0);
const FRAME_MS = 15_000;
const PROVIDERS = ["TX-CONSENSUS-A", "TX-CONSENSUS-B", "TX-CONSENSUS-C"];
const PROVIDER_OFFSETS = [0, 0.0012, -0.001];
const BACKGROUND_CAPTURE_INTERVAL_MS = 60_000;
const BACKGROUND_CAPTURE_START_DELAY_MS = 4_000;
const BACKGROUND_CAPTURE_MAX_BACKOFF_MS = 5 * 60_000;

const FIXTURES: FixtureDefinition[] = [
  {
    id: "replay-fr-es",
    home: "France",
    away: "Spain",
    score: "1 — 1",
    clock: "72:45",
    market: "MATCH_RESULT",
    selection: "France",
    phase: "LIVE",
    probabilities: [
      0.43, 0.432, 0.434, 0.436, 0.438, 0.441, 0.447, 0.462, 0.486,
      0.514, 0.526, 0.532, 0.535, 0.533, 0.536, 0.539, 0.541, 0.543,
    ],
    drawShare: 0.48,
  },
  {
    id: "replay-eng-arg",
    home: "England",
    away: "Argentina",
    score: "0 — 0",
    clock: "PRE",
    market: "MATCH_RESULT",
    selection: "England",
    phase: "PREMATCH",
    probabilities: [
      0.361, 0.362, 0.361, 0.364, 0.363, 0.365, 0.366, 0.365, 0.367,
      0.366, 0.368, 0.367, 0.369, 0.368, 0.37, 0.369, 0.371, 0.37,
    ],
    drawShare: 0.44,
  },
  {
    id: "replay-bra-ger",
    home: "Brazil",
    away: "Germany",
    score: "2 — 1",
    clock: "61:18",
    market: "MATCH_RESULT",
    selection: "Germany",
    phase: "LIVE",
    probabilities: [
      0.322, 0.321, 0.323, 0.319, 0.316, 0.309, 0.298, 0.283, 0.267,
      0.254, 0.248, 0.246, 0.244, 0.245, 0.243, 0.241, 0.24, 0.239,
    ],
    drawShare: 0.51,
  },
];

function virtualTime(frame: number) {
  return DEMO_START + frame * FRAME_MS;
}

function formatClock(timestamp: number) {
  const date = new Date(timestamp);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(
    date.getUTCMinutes(),
  ).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")} UTC`;
}

function formatSnapshotTime(timestamp: string | number | null) {
  if (timestamp === null || timestamp === undefined) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 10)} ${date
    .toISOString()
    .slice(11, 19)} UTC`;
}

function abbreviateRecordId(value: string | null) {
  if (!value) return "—";
  return value.length <= 18 ? value : `${value.slice(0, 9)}…${value.slice(-7)}`;
}

function quoteProofStatusLabel(status: QuoteProofState["status"]) {
  if (status === "verified") return "VERIFIED ONCHAIN";
  if (status === "fetched") return "PROOF FETCHED · NOT VERIFIED";
  if (status === "awaiting") return "AWAITING PROOF";
  if (status === "unavailable") return "PROOF UNAVAILABLE";
  if (status === "error") return "PROOF CHECK FAILED";
  if (status === "loading") return "CHECKING BATCH PROOF";
  return "WAITING FOR QUOTE";
}

function snapshotOutcomeLabel(
  name: string,
  fixture: TxLineFixtureSnapshot | undefined,
) {
  const normalized = name.toLowerCase();
  if (normalized === "part1" || normalized === "participant1") {
    return fixture?.participant1 ?? "Participant 1";
  }
  if (normalized === "part2" || normalized === "participant2") {
    return fixture?.participant2 ?? "Participant 2";
  }
  if (normalized === "draw") return "Draw";
  return name.replaceAll("_", " ");
}

function buildTicks(fixture: FixtureDefinition, frame: number): OddsTick[] {
  const ticks: OddsTick[] = [];
  const lastFrame = Math.min(frame, fixture.probabilities.length - 1);

  for (let index = 0; index <= lastFrame; index += 1) {
    for (let providerIndex = 0; providerIndex < PROVIDERS.length; providerIndex += 1) {
      const fairProb = Math.max(
        0.02,
        Math.min(
          0.95,
          fixture.probabilities[index] + PROVIDER_OFFSETS[providerIndex],
        ),
      );
      const timestamp = virtualTime(index);
      ticks.push({
        eventId: fixture.id,
        market: fixture.market,
        period: "MATCH",
        selection: fixture.selection,
        provider: PROVIDERS[providerIndex],
        decimalOdds: 1 / fairProb,
        fairProb,
        sourceTs: timestamp - 280 - providerIndex * 90,
        receivedAt: timestamp,
        phase: fixture.phase,
        gameState: fixture.phase === "LIVE" ? "IN_PLAY" : "SCHEDULED",
      });
    }
  }

  return ticks;
}

function formatProbability(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatShift(value: number) {
  const amount = (value * 100).toFixed(1);
  return `${value > 0 ? "+" : ""}${amount}pp`;
}

function formatDuration(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function auditPointValue(
  point: AuditSeriesPoint,
  mode: "probability" | "raw" | "unavailable",
) {
  return mode === "probability" ? point.probability : point.rawPrice;
}

function formatAuditValue(value: number | null, mode: "probability" | "raw") {
  if (value === null) return "—";
  if (mode === "probability" && (value < 0.002 || value > 0.998)) {
    return "ineligible";
  }
  return mode === "probability" ? formatProbability(value) : `raw ${value}`;
}

function captureStatusLabel(state: FixtureCaptureState | undefined) {
  if (!state || state.status === "waiting") return "QUEUED";
  if (state.status === "capturing") return "POLLING";
  if (state.status === "stored") return "SAVED";
  if (state.status === "unchanged") return "UNCHANGED";
  if (state.status === "empty") return "NO ODDS";
  return "ERROR";
}

function signalLabel(level: SignalAssessment["level"]) {
  if (level === "high") return "HIGH CONFIDENCE";
  if (level === "confirmed") return "CONFIRMED";
  if (level === "provisional") return "PROVISIONAL";
  return "NO TRIGGER";
}

function fixtureOutcomes(fixture: FixtureDefinition, frame: number) {
  const focus = fixture.probabilities[Math.min(frame, fixture.probabilities.length - 1)];
  const remainder = 1 - focus;
  const draw = remainder * fixture.drawShare;
  const other = remainder - draw;
  const focusIsHome = fixture.selection === fixture.home;
  return focusIsHome
    ? [
        { label: fixture.home, probability: focus },
        { label: "Draw", probability: draw },
        { label: fixture.away, probability: other },
      ]
    : [
        { label: fixture.home, probability: other },
        { label: "Draw", probability: draw },
        { label: fixture.away, probability: focus },
      ];
}

export function OddPulseDashboard() {
  const [frame, setFrame] = useState(9);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [sensitivity, setSensitivity] = useState(1);
  const [selectedId, setSelectedId] = useState(FIXTURES[0].id);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(
    null,
  );
  const [snapshotRefresh, setSnapshotRefresh] = useState(0);
  const [collectionTick, setCollectionTick] = useState(0);
  const [collectorEnabled, setCollectorEnabled] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  const [selectedAuditSeriesKey, setSelectedAuditSeriesKey] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [fixtureCoverage, setFixtureCoverage] = useState<
    Record<number, FixtureCaptureState>
  >({});
  const [snapshot, setSnapshot] = useState<SnapshotState>({
    status: "idle",
    fixtures: [],
    markets: [],
    fetchedAt: null,
    message: "Waiting for an authenticated TxLINE snapshot.",
  });
  const [quoteProof, setQuoteProof] = useState<QuoteProofState>({
    status: "idle",
    fixtureId: null,
    sourceTimestamp: null,
    provider: null,
    market: null,
    messageId: null,
    dailyOddsPda: null,
    treeNodes: 0,
    message: "Select an authenticated quote to request a read-only proof check.",
  });
  const [localHistory, setLocalHistory] = useState<LocalHistoryState>({
    status: "idle",
    history: [],
    lastWrite: null,
    message: "Preparing device-local authenticated history.",
  });
  const [connector, setConnector] = useState<ConnectorState>({
    status: "checking",
    network: "devnet",
    fixtureCount: 0,
    worldCupCount: 0,
    message: "Checking the TxLINE adapter…",
  });
  const seenAlerts = useRef(new Set<string>());
  const historyRequest = useRef(0);
  const backgroundCursor = useRef(0);
  const foregroundCaptureBusy = useRef(false);
  const foregroundRequestId = useRef(0);
  const worldCupFixtureIds = useMemo(
    () =>
      snapshot.fixtures
        .filter(
          (fixture) =>
            fixture.competition.toLowerCase() === "world cup" &&
            Number.isSafeInteger(fixture.fixtureId) &&
            fixture.fixtureId > 0,
        )
        .map((fixture) => fixture.fixtureId),
    [snapshot.fixtures],
  );
  const worldCupFixtureKey = worldCupFixtureIds.join("|");

  useEffect(() => {
    const syncVisibility = () => {
      setTabVisible(document.visibilityState === "visible");
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setConnector((current) => ({
      ...current,
      status: "checking",
      message: "Refreshing authenticated TxLINE fixtures…",
    }));
    fetch("/api/txline", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.message || "TxLINE adapter request failed");
        }
        if (body.configured) {
          const fixtures = Array.isArray(body.fixtures)
            ? (body.fixtures as TxLineFixtureSnapshot[]).filter(
                (fixture) => Number.isFinite(fixture.fixtureId),
              )
            : [];
          const worldCupFixtures = fixtures.filter(
            (fixture) => fixture.competition.toLowerCase() === "world cup",
          );
          setSelectedSnapshotId((current) => {
            if (
              current !== null &&
              fixtures.some((fixture) => fixture.fixtureId === current)
            ) {
              return current;
            }
            return worldCupFixtures[0]?.fixtureId ?? fixtures[0]?.fixtureId ?? null;
          });
          setSnapshot((current) => ({
            ...current,
            status: fixtures.length ? current.status : "empty",
            fixtures,
            fetchedAt: current.fetchedAt ?? body.fetchedAt ?? Date.now(),
            message: fixtures.length
              ? current.message
              : "The authenticated fixture snapshot is empty.",
          }));
          setConnector({
            status: "ready",
            network: body.network ?? "devnet",
            fixtureCount: fixtures.length,
            worldCupCount: worldCupFixtures.length,
            message: "Authenticated snapshot connected; replay remains separate.",
          });
        } else {
          setSnapshot({
            status: "empty",
            fixtures: [],
            markets: [],
            fetchedAt: null,
            message: "Credentials are not loaded; authenticated snapshots are unavailable.",
          });
          setConnector({
            status: "replay",
            network: body.network ?? "devnet",
            fixtureCount: 0,
            worldCupCount: 0,
            message: "Schema-compatible deterministic replay; no live claim.",
          });
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSnapshot((current) => ({
          ...current,
          status: "error",
          message: "Authenticated fixture snapshot could not be loaded.",
        }));
        setConnector({
          status: "error",
          network: "devnet",
          fixtureCount: 0,
          worldCupCount: 0,
          message: "Adapter unavailable; replay remains operational.",
        });
      });
    return () => controller.abort();
  }, [snapshotRefresh]);

  useEffect(() => {
    if (connector.status !== "ready" || !worldCupFixtureIds.length) return;
    let cancelled = false;
    loadLocalSnapshotCoverage(connector.network, worldCupFixtureIds)
      .then((coverage) => {
        if (cancelled) return;
        setFixtureCoverage((current) => {
          const next: Record<number, FixtureCaptureState> = {};
          for (const item of coverage) {
            const existing = current[item.fixtureId];
            next[item.fixtureId] = {
              status:
                existing?.status ?? (item.snapshotCount ? "unchanged" : "waiting"),
              savedSnapshots: Math.max(
                existing?.savedSnapshots ?? 0,
                item.snapshotCount,
              ),
              marketCount: existing?.marketCount ?? 0,
              lastAttemptAt: existing?.lastAttemptAt ?? item.latestRetrievedAt,
              lastStoredAt: existing?.lastStoredAt ?? item.latestRetrievedAt,
              message:
                existing?.message ??
                (item.snapshotCount
                  ? "Saved device-local history restored."
                  : "Waiting for the first authenticated capture."),
            };
          }
          return next;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setFixtureCoverage(
          Object.fromEntries(
            worldCupFixtureIds.map((fixtureId) => [
              fixtureId,
              {
                status: "error",
                savedSnapshots: 0,
                marketCount: 0,
                lastAttemptAt: null,
                lastStoredAt: null,
                message:
                  error instanceof Error
                    ? error.message
                    : "Device-local coverage could not be loaded.",
              } satisfies FixtureCaptureState,
            ]),
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    connector.network,
    connector.status,
    worldCupFixtureIds,
    worldCupFixtureKey,
  ]);

  useEffect(() => {
    if (selectedSnapshotId === null) return;
    const requestId = ++historyRequest.current;
    setLocalHistory((current) => ({
      ...current,
      status: "loading",
      lastWrite: null,
      message: "Loading device-local history for the selected fixture.",
    }));
    loadLocalSnapshotHistory(connector.network, selectedSnapshotId)
      .then((history) => {
        if (requestId !== historyRequest.current) return;
        setLocalHistory({
          status: "ready",
          history,
          lastWrite: null,
          message: history.length
            ? "Device-local authenticated history restored."
            : "No saved history yet; the next authenticated snapshot will start it.",
        });
      })
      .catch((error) => {
        if (requestId !== historyRequest.current) return;
        setLocalHistory({
          status: "unsupported",
          history: [],
          lastWrite: null,
          message:
            error instanceof Error
              ? error.message
              : "Device-local history is unavailable.",
        });
      });
  }, [connector.network, selectedSnapshotId]);

  useEffect(() => {
    if (selectedSnapshotId === null) return;
    const controller = new AbortController();
    const foregroundId = ++foregroundRequestId.current;
    const attemptAt = Date.now();
    foregroundCaptureBusy.current = true;
    setFixtureCoverage((current) => ({
      ...current,
      [selectedSnapshotId]: {
        status: "capturing",
        savedSnapshots: current[selectedSnapshotId]?.savedSnapshots ?? 0,
        marketCount: current[selectedSnapshotId]?.marketCount ?? 0,
        lastAttemptAt: attemptAt,
        lastStoredAt: current[selectedSnapshotId]?.lastStoredAt ?? null,
        message: "Foreground authenticated capture in progress.",
      },
    }));
    setSnapshot((current) => ({
      ...current,
      status: current.markets.length ? "ready" : "loading",
      message: "Loading authenticated odds for the selected fixture…",
    }));
    fetch(`/api/txline?fixtureId=${encodeURIComponent(selectedSnapshotId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (
          controller.signal.aborted ||
          foregroundId !== foregroundRequestId.current
        ) {
          return;
        }
        if (!response.ok) {
          throw new Error(body.message || "TxLINE odds snapshot failed");
        }
        const markets = Array.isArray(body.markets)
          ? (body.markets as TxLineMarketSnapshot[])
          : [];
        const fetchedAt = body.fetchedAt ?? Date.now();
        if (!markets.length) {
          setFixtureCoverage((current) => ({
            ...current,
            [selectedSnapshotId]: {
              status: "empty",
              savedSnapshots: current[selectedSnapshotId]?.savedSnapshots ?? 0,
              marketCount: 0,
              lastAttemptAt: fetchedAt,
              lastStoredAt: current[selectedSnapshotId]?.lastStoredAt ?? null,
              message: "Authenticated fixture currently has no odds markets.",
            },
          }));
        }
        setSnapshot((current) => ({
          ...current,
          status: markets.length ? "ready" : "empty",
          markets,
          fetchedAt,
          message: markets.length
            ? "Authenticated odds snapshot loaded and offered to local history."
            : "No odds snapshot is currently available for this fixture.",
        }));

        const envelope = buildAuthenticatedEnvelope({
          configured: body.configured === true,
          mode: body.mode ?? "",
          network: body.network ?? "devnet",
          fixtureId: selectedSnapshotId,
          fetchedAt,
          markets,
        });
        if (!envelope) {
          if (markets.length) {
            setFixtureCoverage((current) => ({
              ...current,
              [selectedSnapshotId]: {
                status: "error",
                savedSnapshots: current[selectedSnapshotId]?.savedSnapshots ?? 0,
                marketCount: markets.length,
                lastAttemptAt: fetchedAt,
                lastStoredAt: current[selectedSnapshotId]?.lastStoredAt ?? null,
                message: "Snapshot did not meet authenticated storage provenance.",
              },
            }));
          }
          return;
        }

        const requestId = ++historyRequest.current;
        void persistLocalSnapshot(envelope)
          .then((result) => {
            if (
              controller.signal.aborted ||
              foregroundId !== foregroundRequestId.current ||
              requestId !== historyRequest.current
            ) {
              return;
            }
            setLocalHistory({
              status: "ready",
              history: result.history,
              lastWrite: result.stored ? "stored" : "duplicate",
              message: result.stored
                ? "A new authenticated snapshot was saved on this device."
                  : "The upstream snapshot was unchanged; no duplicate was added.",
            });
            setFixtureCoverage((current) => ({
              ...current,
              [selectedSnapshotId]: {
                status: result.stored ? "stored" : "unchanged",
                savedSnapshots: result.history.length,
                marketCount: markets.length,
                lastAttemptAt: fetchedAt,
                lastStoredAt: result.stored
                  ? fetchedAt
                  : (current[selectedSnapshotId]?.lastStoredAt ?? null),
                message: result.stored
                  ? "New foreground snapshot saved locally."
                  : "Foreground snapshot was unchanged.",
              },
            }));
          })
          .catch((error) => {
            if (
              controller.signal.aborted ||
              foregroundId !== foregroundRequestId.current ||
              requestId !== historyRequest.current
            ) {
              return;
            }
            setLocalHistory((current) => ({
              ...current,
              status: "error",
              lastWrite: null,
              message:
                error instanceof Error
                  ? error.message
                    : "The authenticated snapshot could not be saved locally.",
            }));
            setFixtureCoverage((current) => ({
              ...current,
              [selectedSnapshotId]: {
                status: "error",
                savedSnapshots: current[selectedSnapshotId]?.savedSnapshots ?? 0,
                marketCount: markets.length,
                lastAttemptAt: fetchedAt,
                lastStoredAt: current[selectedSnapshotId]?.lastStoredAt ?? null,
                message: "Foreground snapshot could not be saved locally.",
              },
            }));
          });
      })
      .catch((error) => {
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          foregroundId !== foregroundRequestId.current
        ) {
          return;
        }
        setSnapshot((current) => ({
          ...current,
          status: "error",
          markets: [],
          message: "The selected odds snapshot could not be loaded.",
        }));
        setFixtureCoverage((current) => ({
          ...current,
          [selectedSnapshotId]: {
            status: "error",
            savedSnapshots: current[selectedSnapshotId]?.savedSnapshots ?? 0,
            marketCount: current[selectedSnapshotId]?.marketCount ?? 0,
            lastAttemptAt: Date.now(),
            lastStoredAt: current[selectedSnapshotId]?.lastStoredAt ?? null,
            message: "Foreground authenticated capture failed.",
          },
        }));
      })
      .finally(() => {
        if (foregroundId === foregroundRequestId.current) {
          foregroundCaptureBusy.current = false;
        }
      });
    return () => controller.abort();
  }, [collectionTick, selectedSnapshotId, snapshotRefresh]);

  useEffect(() => {
    if (
      !collectorEnabled ||
      !tabVisible ||
      selectedSnapshotId === null ||
      connector.status !== "ready"
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setCollectionTick((current) => current + 1);
    }, LOCAL_CAPTURE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [collectorEnabled, connector.status, selectedSnapshotId, tabVisible]);

  useEffect(() => {
    if (
      !collectorEnabled ||
      !tabVisible ||
      connector.status !== "ready" ||
      !worldCupFixtureIds.length
    ) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let failureCount = 0;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = window.setTimeout(captureNext, delay);
    };

    const captureNext = async () => {
      if (cancelled || inFlight) return;
      if (foregroundCaptureBusy.current) {
        schedule(5_000);
        return;
      }

      const target = nextBackgroundCaptureTarget(
        worldCupFixtureIds,
        selectedSnapshotId,
        backgroundCursor.current,
      );
      if (!target) return;
      backgroundCursor.current = target.nextCursor;
      inFlight = true;
      controller = new AbortController();
      const attemptAt = Date.now();
      setFixtureCoverage((current) => ({
        ...current,
        [target.fixtureId]: {
          status: "capturing",
          savedSnapshots: current[target.fixtureId]?.savedSnapshots ?? 0,
          marketCount: current[target.fixtureId]?.marketCount ?? 0,
          lastAttemptAt: attemptAt,
          lastStoredAt: current[target.fixtureId]?.lastStoredAt ?? null,
          message: "Background authenticated capture in progress.",
        },
      }));

      try {
        const response = await fetch(
          `/api/txline?fixtureId=${encodeURIComponent(target.fixtureId)}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.message || "Background TxLINE snapshot failed");
        }
        const normalizedNetwork = String(body.network ?? "").toLowerCase();
        const markets = Array.isArray(body.markets)
          ? (body.markets as TxLineMarketSnapshot[])
          : [];
        if (
          body.configured !== true ||
          body.mode !== "authenticated-snapshot" ||
          normalizedNetwork !== connector.network.toLowerCase() ||
          !Number.isFinite(body.fetchedAt) ||
          markets.some((market) => market.fixtureId !== target.fixtureId)
        ) {
          throw new Error("Background snapshot failed authenticated provenance checks");
        }
        if (cancelled || controller.signal.aborted) return;

        if (!markets.length) {
          failureCount = 0;
          setFixtureCoverage((current) => ({
            ...current,
            [target.fixtureId]: {
              status: "empty",
              savedSnapshots: current[target.fixtureId]?.savedSnapshots ?? 0,
              marketCount: 0,
              lastAttemptAt: body.fetchedAt,
              lastStoredAt: current[target.fixtureId]?.lastStoredAt ?? null,
              message: "Authenticated fixture currently has no odds markets.",
            },
          }));
          return;
        }

        const envelope = buildAuthenticatedEnvelope({
          configured: true,
          mode: body.mode,
          network: normalizedNetwork,
          fixtureId: target.fixtureId,
          fetchedAt: body.fetchedAt,
          markets,
        });
        if (!envelope) {
          throw new Error("Background snapshot could not be normalized safely");
        }
        const result = await persistLocalSnapshot(envelope);
        if (cancelled || controller.signal.aborted) return;
        failureCount = 0;
        setFixtureCoverage((current) => ({
          ...current,
          [target.fixtureId]: {
            status: result.stored ? "stored" : "unchanged",
            savedSnapshots: result.history.length,
            marketCount: markets.length,
            lastAttemptAt: body.fetchedAt,
            lastStoredAt: result.stored
              ? body.fetchedAt
              : (current[target.fixtureId]?.lastStoredAt ?? null),
            message: result.stored
              ? "New background snapshot saved locally."
              : "Background snapshot was unchanged.",
          },
        }));
      } catch (error) {
        if (
          cancelled ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        failureCount += 1;
        setFixtureCoverage((current) => ({
          ...current,
          [target.fixtureId]: {
            status: "error",
            savedSnapshots: current[target.fixtureId]?.savedSnapshots ?? 0,
            marketCount: current[target.fixtureId]?.marketCount ?? 0,
            lastAttemptAt: Date.now(),
            lastStoredAt: current[target.fixtureId]?.lastStoredAt ?? null,
            message:
              error instanceof Error
                ? error.message
                : "Background authenticated capture failed.",
          },
        }));
      } finally {
        inFlight = false;
        controller = null;
        if (!cancelled) {
          const delay = Math.min(
            BACKGROUND_CAPTURE_INTERVAL_MS *
              2 ** Math.max(0, failureCount - 1),
            BACKGROUND_CAPTURE_MAX_BACKOFF_MS,
          );
          schedule(delay);
        }
      }
    };

    schedule(BACKGROUND_CAPTURE_START_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [
    collectorEnabled,
    connector.network,
    connector.status,
    selectedSnapshotId,
    tabVisible,
    worldCupFixtureIds,
    worldCupFixtureKey,
  ]);

  useEffect(() => {
    if (paused) return;
    const delay = Math.max(500, 5_000 / speed);
    const timer = window.setInterval(() => {
      setFrame((current) =>
        current >= FIXTURES[0].probabilities.length - 1 ? 4 : current + 1,
      );
    }, delay);
    return () => window.clearInterval(timer);
  }, [paused, speed]);

  const assessments = useMemo(
    () =>
      FIXTURES.map((fixture) => ({
        fixture,
        ticks: buildTicks(fixture, frame),
        assessment: evaluateOddsMovement(
          buildTicks(fixture, frame),
          virtualTime(frame),
          sensitivity,
        ),
      })),
    [frame, sensitivity],
  );

  useEffect(() => {
    for (const item of assessments) {
      const { fixture, assessment } = item;
      if (assessment.level !== "confirmed" && assessment.level !== "high") continue;
      const alertKey = `${assessment.key}|${assessment.direction}`;
      if (seenAlerts.current.has(alertKey)) continue;
      seenAlerts.current.add(alertKey);
      setAlerts((current) =>
        [
          {
            id: `${alertKey}|${frame}`,
            fixtureId: fixture.id,
            match: `${fixture.home} · ${fixture.away}`,
            selection: fixture.selection,
            direction: assessment.direction,
            shift: assessment.deltaProb,
            confidence: assessment.confidence,
            level: assessment.level,
            time: formatClock(virtualTime(frame)),
          },
          ...current,
        ].slice(0, 8),
      );
    }
  }, [assessments, frame]);

  const selected =
    assessments.find((item) => item.fixture.id === selectedId) ?? assessments[0];
  const selectedSeries = selected.fixture.probabilities.slice(0, frame + 1);
  const seriesMin = Math.min(...selectedSeries);
  const seriesMax = Math.max(...selectedSeries);
  const range = Math.max(0.01, seriesMax - seriesMin);
  const outcomes = fixtureOutcomes(selected.fixture, frame);
  const activeSignals = assessments.filter(
    (item) => item.assessment.level === "confirmed" || item.assessment.level === "high",
  );
  const maxShift = Math.max(
    ...assessments.map((item) => Math.abs(item.assessment.deltaProb)),
  );
  const worldCupSnapshots = snapshot.fixtures.filter((fixture) =>
    worldCupFixtureIds.includes(fixture.fixtureId),
  );
  const visibleSnapshotFixtures = worldCupSnapshots.length
    ? worldCupSnapshots
    : snapshot.fixtures;
  const selectedSnapshotFixture = snapshot.fixtures.find(
    (fixture) => fixture.fixtureId === selectedSnapshotId,
  );
  const sourceAsOf = snapshot.markets.reduce<number | null>(
    (latest, market) => {
      if (market.timestamp === null || !Number.isFinite(market.timestamp)) {
        return latest;
      }
      return latest === null || market.timestamp > latest ? market.timestamp : latest;
    },
    null,
  );
  useEffect(() => {
    if (selectedSnapshotId === null || connector.status !== "ready") {
      setQuoteProof({
        status: "idle",
        fixtureId: null,
        sourceTimestamp: null,
        provider: null,
        market: null,
        messageId: null,
        dailyOddsPda: null,
        treeNodes: 0,
        message: "Select an authenticated quote to request a read-only proof check.",
      });
      return;
    }

    const controller = new AbortController();
    setQuoteProof({
      status: "loading",
      fixtureId: selectedSnapshotId,
      sourceTimestamp: null,
      provider: null,
      market: null,
      messageId: null,
      dailyOddsPda: null,
      treeNodes: 0,
      message: "Requesting a proof receipt for the selected authenticated quote.",
    });
    fetch(`/api/txline-proof?fixtureId=${encodeURIComponent(selectedSnapshotId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          message?: unknown;
          proof?: {
            status?: unknown;
            message?: unknown;
            record?: {
              fixtureId?: unknown;
              sourceTimestamp?: unknown;
              provider?: unknown;
              market?: unknown;
              messageId?: unknown;
            } | null;
            onChain?: {
              dailyOddsPda?: unknown;
              treeNodes?: unknown;
            };
          };
        };
        if (!response.ok || !body.proof) {
          throw new Error(
            typeof body.message === "string"
              ? body.message
              : "The quote-proof request could not be completed.",
          );
        }
        const proof = body.proof;
        const status =
          proof.status === "VERIFIED_ONCHAIN"
            ? "verified"
            : proof.status === "PROOF_FETCHED"
              ? "fetched"
              : proof.status === "AWAITING_PROOF"
                ? "awaiting"
                : "unavailable";
        const rawSourceTimestamp = proof.record?.sourceTimestamp;
        const sourceTimestamp =
          typeof rawSourceTimestamp === "number" ||
          typeof rawSourceTimestamp === "string"
            ? Number(rawSourceTimestamp)
            : Number.NaN;
        const treeNodes = Number(proof.onChain?.treeNodes);
        if (!controller.signal.aborted) {
          setQuoteProof({
            status,
            fixtureId:
              typeof proof.record?.fixtureId === "number"
                ? proof.record.fixtureId
                : selectedSnapshotId,
            sourceTimestamp: Number.isFinite(sourceTimestamp)
              ? sourceTimestamp
              : null,
            provider:
              typeof proof.record?.provider === "string" ? proof.record.provider : null,
            market:
              typeof proof.record?.market === "string" ? proof.record.market : null,
            messageId:
              typeof proof.record?.messageId === "string"
                ? proof.record.messageId
                : null,
            dailyOddsPda:
              typeof proof.onChain?.dailyOddsPda === "string"
                ? proof.onChain.dailyOddsPda
                : null,
            treeNodes: Number.isSafeInteger(treeNodes) && treeNodes >= 0 ? treeNodes : 0,
            message:
              typeof proof.message === "string"
                ? proof.message
                : "The quote-proof receipt did not include a status message.",
          });
        }
      })
      .catch((error) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        setQuoteProof({
          status: "error",
          fixtureId: selectedSnapshotId,
          sourceTimestamp: null,
          provider: null,
          market: null,
          messageId: null,
          dailyOddsPda: null,
          treeNodes: 0,
          message: "The quote-proof check is temporarily unavailable. No proof badge was issued.",
        });
      });
    return () => controller.abort();
  }, [connector.status, selectedSnapshotId, sourceAsOf]);
  const historyObservation = useMemo(
    () => analyzeSnapshotHistory(localHistory.history),
    [localHistory.history],
  );
  const auditSeries = useMemo(
    () =>
      buildAuditSeries(localHistory.history, {
        network: connector.network,
        fixtureId: selectedSnapshotId ?? undefined,
      }),
    [connector.network, localHistory.history, selectedSnapshotId],
  );
  useEffect(() => {
    setSelectedAuditSeriesKey((current) =>
      current && auditSeries.some((series) => series.key === current)
        ? current
        : (auditSeries[0]?.key ?? ""),
    );
    setExportStatus("");
  }, [auditSeries, selectedSnapshotId]);
  const selectedAuditSeries =
    auditSeries.find((series) => series.key === selectedAuditSeriesKey) ??
    auditSeries[0];
  const auditChartPoints = (selectedAuditSeries?.points ?? [])
    .filter((point) => {
      if (point.conflict || selectedAuditSeries?.valueMode === "unavailable") {
        return false;
      }
      if (
        selectedAuditSeries?.valueMode === "probability" &&
        point.sourceAt === null
      ) {
        return false;
      }
      return auditPointValue(point, selectedAuditSeries.valueMode) !== null;
    })
    .slice(-60);
  const auditChartValues = auditChartPoints
    .map((point) => auditPointValue(point, selectedAuditSeries?.valueMode ?? "raw"))
    .filter((value): value is number => value !== null);
  const auditChartTimes = auditChartPoints.map(
    (point) => point.sourceAt ?? point.retrievedAt,
  );
  const auditChartMin = auditChartValues.length ? Math.min(...auditChartValues) : 0;
  const auditChartMax = auditChartValues.length ? Math.max(...auditChartValues) : 0;
  const auditChartRange = Math.max(auditChartMax - auditChartMin, Number.EPSILON);
  const auditTimeMin = auditChartTimes.length ? Math.min(...auditChartTimes) : 0;
  const auditTimeMax = auditChartTimes.length ? Math.max(...auditChartTimes) : 0;
  const auditTimeRange = Math.max(auditTimeMax - auditTimeMin, 1);
  const auditTablePoints = [...(selectedAuditSeries?.points ?? [])]
    .slice(-8)
    .reverse();
  const coveredFixtureCount = worldCupSnapshots.filter(
    (fixture) =>
      typeof fixtureCoverage[fixture.fixtureId]?.lastAttemptAt === "number",
  ).length;
  const totalSavedSnapshots = worldCupSnapshots.reduce(
    (total, fixture) =>
      total + (fixtureCoverage[fixture.fixtureId]?.savedSnapshots ?? 0),
    0,
  );
  const activeCaptureFixture = worldCupSnapshots.find(
    (fixture) => fixtureCoverage[fixture.fixtureId]?.status === "capturing",
  );
  const observationLabel =
    localHistory.status === "unsupported" || localHistory.status === "error"
      ? "LOCAL HISTORY UNAVAILABLE"
      : historyObservation.status === "observed"
        ? historyObservation.providerCount > 1
          ? "MULTI-SOURCE MOVE OBSERVED"
          : "SINGLE-SOURCE MOVE OBSERVED"
        : historyObservation.status === "stable"
          ? "NO MATERIAL MOVE"
          : historyObservation.reason.startsWith("Raw snapshots")
            ? "COLLECTING RAW SNAPSHOTS · MOVEMENT NOT ELIGIBLE"
            : "BASELINE FORMING";
  const connectionLabel =
    connector.status === "ready"
      ? "TXLINE SNAPSHOT CONNECTED"
      : connector.status === "checking"
        ? "CHECKING TXLINE"
        : "REPLAY ONLY";

  const restartReplay = () => {
    seenAlerts.current.clear();
    setAlerts([]);
    setFrame(4);
    setPaused(false);
  };

  const refreshSnapshot = () => {
    setSnapshotRefresh((current) => current + 1);
  };

  const exportSelectedEvidence = () => {
    if (!selectedAuditSeries || selectedSnapshotId === null) return;
    const csv = snapshotHistoryToCsv(localHistory.history, {
      network: connector.network,
      fixtureId: selectedSnapshotId,
      seriesKey: selectedAuditSeries.key,
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replaceAll(":", "-").replace(".000", "");
    const safeNetwork = connector.network.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    link.href = url;
    link.download = `oddpulse-authenticated-history-${safeNetwork}-fixture-${selectedSnapshotId}-${stamp}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setExportStatus("CSV prepared locally. No upload was performed.");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="OddPulse home">
          <span className="brand-mark" aria-hidden="true">
            OP
          </span>
          <span>
            <strong>OddPulse</strong>
            <small>verifiable movement intelligence</small>
          </span>
        </a>
        <div className="topbar-meta">
          <span className={`connection-pill ${connector.status}`}>
            <i aria-hidden="true" />
            {connectionLabel}
          </span>
          <span className="deadline-pill">SUBMISSION · 19 JUL 23:59 UTC</span>
        </div>
      </header>

      <section className="intro" id="top">
        <div>
          <p className="eyebrow">AUTONOMOUS SIGNAL DESK / WORLD CUP</p>
          <h1>See the move. Verify the signal. Know why it fired.</h1>
          <p className="intro-copy">
            OddPulse pairs provider quotes, removes noisy one-book moves, and
            escalates only persistent probability shifts with defensible evidence.
          </p>
        </div>
        <div className="run-controls" aria-label="Replay controls">
          <button
            className="control-button primary"
            type="button"
            onClick={() => setPaused((value) => !value)}
          >
            <span aria-hidden="true">{paused ? "▶" : "Ⅱ"}</span>
            {paused ? "Resume agent" : "Pause agent"}
          </button>
          <label className="select-control">
            <span>Replay speed</span>
            <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
              <option value={1}>1×</option>
              <option value={4}>4×</option>
              <option value={12}>12×</option>
            </select>
          </label>
          <button className="control-button ghost" type="button" onClick={restartReplay}>
            Restart
          </button>
        </div>
      </section>

      <section
        className={`panel snapshot-panel ${snapshot.status}`}
        aria-label="Authenticated TxLINE snapshot"
      >
        <div className="panel-heading compact snapshot-heading">
          <div>
            <span className="section-kicker">AUTHENTICATED DEVNET SNAPSHOT</span>
            <h2>TxLINE source desk</h2>
          </div>
          <div className="snapshot-actions">
            <span className="source-label">NOT A LIVE STREAM</span>
            <button
              className="control-button ghost snapshot-refresh"
              type="button"
              onClick={refreshSnapshot}
              disabled={snapshot.status === "loading"}
            >
              {snapshot.status === "loading" ? "Refreshing…" : "Refresh snapshot"}
            </button>
          </div>
        </div>

        <div className="snapshot-summary">
          <span>{connector.network.toUpperCase()} · SERVER-AUTHENTICATED</span>
          <span>
            {connector.worldCupCount} WORLD CUP / {connector.fixtureCount} AVAILABLE
          </span>
          <span>FETCHED {formatSnapshotTime(snapshot.fetchedAt)}</span>
        </div>

        <div
          className={`local-history ${historyObservation.status} ${localHistory.status}`}
          aria-label="Device-local authenticated snapshot history"
        >
          <div className="local-history-state">
            <span>DEVICE-LOCAL AUTHENTICATED HISTORY</span>
            <strong>
              {collectorEnabled && tabVisible
                ? "RUNNING · TAB VISIBLE ONLY"
                : collectorEnabled
                  ? "PAUSED · TAB HIDDEN"
                : "LOCAL POLLING PAUSED"}
            </strong>
            <small>
              Selected every {Math.round(LOCAL_CAPTURE_INTERVAL_MS / 1_000)}s ·
              others round-robin {Math.round(
                BACKGROUND_CAPTURE_INTERVAL_MS / 1_000,
              )}s slots
            </small>
          </div>

          <div className="local-history-observation">
            <span>{observationLabel}</span>
            <strong
              className={
                historyObservation.deltaProbability === null
                  ? "flat"
                  : historyObservation.deltaProbability > 0
                    ? "up"
                    : historyObservation.deltaProbability < 0
                      ? "down"
                      : "flat"
              }
            >
              {historyObservation.deltaProbability === null
                ? "—"
                : formatShift(historyObservation.deltaProbability)}
            </strong>
            <small>
              {historyObservation.selection
                ? `${snapshotOutcomeLabel(
                    historyObservation.selection,
                    selectedSnapshotFixture,
                  )} · ${historyObservation.market?.replaceAll("_", " ")} · ${formatDuration(
                    historyObservation.elapsedMs,
                  )}`
                : historyObservation.reason}
            </small>
          </div>

          <div className="local-history-control">
            <button
              className="control-button ghost snapshot-refresh"
              type="button"
              onClick={() => setCollectorEnabled((current) => !current)}
            >
              {collectorEnabled ? "Pause all capture" : "Resume all capture"}
            </button>
            <small>
              {localHistory.lastWrite === "stored"
                ? "new snapshot saved"
                : localHistory.lastWrite === "duplicate"
                  ? "unchanged snapshot skipped"
                  : localHistory.message}
            </small>
          </div>
        </div>

        <div className="snapshot-grid">
          <div className="snapshot-fixtures">
            <div className="snapshot-column-title">
              <strong>Covered fixtures</strong>
              <small>All explicitly labelled World Cup fixtures</small>
            </div>
            <div
              className={`coverage-summary ${
                collectorEnabled && tabVisible ? "running" : "paused"
              }`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span>ALL WORLD CUP FIXTURES</span>
              <strong>
                {coveredFixtureCount}/{worldCupSnapshots.length} COVERED ·{" "}
                {totalSavedSnapshots} SAVED
              </strong>
              <small>
                {!collectorEnabled
                  ? "Capture paused. Saved evidence remains available."
                  : !tabVisible
                    ? "Tab hidden · no requests are running."
                    : activeCaptureFixture
                      ? `Polling ${activeCaptureFixture.home} · ${activeCaptureFixture.away}`
                      : "Selected 15s · other fixtures round-robin 60s"}
              </small>
            </div>
            <div className="snapshot-fixture-list">
              {visibleSnapshotFixtures.length ? (
                visibleSnapshotFixtures.map((fixture) => (
                  <button
                    className={
                      fixture.fixtureId === selectedSnapshotId ? "selected" : ""
                    }
                    key={fixture.fixtureId}
                    type="button"
                    aria-pressed={fixture.fixtureId === selectedSnapshotId}
                    onClick={() => setSelectedSnapshotId(fixture.fixtureId)}
                  >
                    <span>
                      <strong>{fixture.home} · {fixture.away}</strong>
                      <small>
                        {fixture.competition} · {formatSnapshotTime(fixture.startTime)}
                      </small>
                      <small className="fixture-capture-line">
                        {fixture.fixtureId === selectedSnapshotId
                          ? `FG · EVERY ${Math.round(
                              LOCAL_CAPTURE_INTERVAL_MS / 1_000,
                            )}S`
                          : `BG · ROUND-ROBIN ${Math.round(
                              BACKGROUND_CAPTURE_INTERVAL_MS / 1_000,
                            )}S SLOT`}
                        {" · "}
                        {fixtureCoverage[fixture.fixtureId]?.savedSnapshots ?? 0} SAVED
                        {" · "}
                        {captureStatusLabel(fixtureCoverage[fixture.fixtureId])}
                      </small>
                    </span>
                    <b>#{fixture.fixtureId}</b>
                  </button>
                ))
              ) : (
                <div className="snapshot-empty">No authenticated fixtures available.</div>
              )}
            </div>
          </div>

          <div className="snapshot-markets">
            <div className="snapshot-column-title">
              <span>
                <strong>
                  {selectedSnapshotFixture
                    ? `${selectedSnapshotFixture.home} · ${selectedSnapshotFixture.away}`
                    : "Select a fixture"}
                </strong>
                <small>
                  Source as of {formatSnapshotTime(sourceAsOf)} · snapshot only
                </small>
              </span>
              <b>{snapshot.markets.length} MARKETS</b>
            </div>

            {snapshot.status === "loading" ? (
              <div className="snapshot-empty">Loading authenticated odds…</div>
            ) : snapshot.status === "error" || snapshot.status === "empty" ? (
              <div className="snapshot-empty">{snapshot.message}</div>
            ) : (
              <div className="snapshot-market-list">
                {snapshot.markets.slice(0, 4).map((market) => (
                  <article
                    className="snapshot-market-card"
                    key={`${market.fixtureId}|${market.market}|${market.period}|${market.parameters}|${market.provider}|${market.timestamp}`}
                  >
                    <div>
                      <span>{market.market.replaceAll("_", " ")}</span>
                      <small>
                        {market.period || "match"}
                        {market.parameters ? ` · ${market.parameters}` : ""}
                      </small>
                    </div>
                    <p>{market.provider}</p>
                    <div className="snapshot-outcomes">
                      {market.outcomes.map((outcome) => (
                        <span key={`${market.timestamp}|${outcome.name}`}>
                          <small>
                            {snapshotOutcomeLabel(outcome.name, selectedSnapshotFixture)}
                          </small>
                          <strong>
                            {outcome.probability === null
                              ? "—"
                              : formatProbability(outcome.probability)}
                          </strong>
                          <em>
                            {outcome.rawPrice === null
                              ? "raw —"
                              : `raw ${outcome.rawPrice}`}
                          </em>
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>

        <section
          className={`quote-proof ${quoteProof.status}`}
          aria-label="Read-only quote proof receipt"
        >
          <div className="quote-proof-heading">
            <div>
              <span className="section-kicker">QUOTE PROOF · READ-ONLY CHECK</span>
              <h3>Selected quote receipt</h3>
            </div>
            <strong className="quote-proof-status" aria-live="polite">
              {quoteProofStatusLabel(quoteProof.status)}
            </strong>
          </div>

          <div className="quote-proof-grid">
            <span>
              <small>Source time</small>
              <strong>{formatSnapshotTime(quoteProof.sourceTimestamp)}</strong>
            </span>
            <span>
              <small>Record</small>
              <strong>{abbreviateRecordId(quoteProof.messageId)}</strong>
            </span>
            <span>
              <small>Market</small>
              <strong>{quoteProof.market?.replaceAll("_", " ") ?? "—"}</strong>
            </span>
            <span>
              <small>Odds root</small>
              <strong>{abbreviateRecordId(quoteProof.dailyOddsPda)}</strong>
            </span>
          </div>

          <p>{quoteProof.message}</p>
          <small className="quote-proof-boundary">
            It checks the selected quote against TxLINE&apos;s daily odds root. It never
            signs, submits a transaction, turns the replay into a live signal, or
            places a bet.
            {quoteProof.provider
              ? ` Provider: ${quoteProof.provider}.`
              : ""}
            {quoteProof.treeNodes
              ? ` Proof nodes inspected: ${quoteProof.treeNodes}.`
              : ""}
          </small>
        </section>

        <section
          className="evidence-panel"
          aria-label="Device-local authenticated evidence"
        >
          <div className="evidence-heading">
            <div>
              <span className="section-kicker">
                DEVICE-LOCAL AUTHENTICATED EVIDENCE
              </span>
              <h3>Saved exact series</h3>
            </div>
            <span className="source-label">REAL HISTORY · LOCAL ONLY</span>
          </div>

          <div className="evidence-controls">
            <label htmlFor="evidence-series">
              <span>Exact series</span>
              <select
                id="evidence-series"
                value={selectedAuditSeries?.key ?? ""}
                onChange={(event) => setSelectedAuditSeriesKey(event.target.value)}
                disabled={!auditSeries.length}
              >
                {auditSeries.length ? (
                  auditSeries.map((series) => (
                    <option key={series.key} value={series.key}>
                      {snapshotOutcomeLabel(series.outcome, selectedSnapshotFixture)} ·{" "}
                      {series.market.replaceAll("_", " ")} / {series.period}
                      {series.parameters ? ` / ${series.parameters}` : ""} ·{" "}
                      {series.provider}
                    </option>
                  ))
                ) : (
                  <option value="">No saved authenticated series</option>
                )}
              </select>
            </label>
            <div>
              <button
                className="control-button ghost evidence-export"
                type="button"
                onClick={exportSelectedEvidence}
                disabled={!selectedAuditSeries?.points.length}
              >
                Export selected CSV
              </button>
              <small>Local file only · no upload</small>
              <span className="sr-status" aria-live="polite">
                {exportStatus}
              </span>
            </div>
          </div>

          {selectedAuditSeries ? (
            <div className="evidence-body">
              <div className="evidence-series-meta">
                <span>
                  {selectedAuditSeries.provider} · {selectedAuditSeries.inRunning
                    ? "IN-PLAY"
                    : "PREMATCH"}
                </span>
                <span>
                  {selectedAuditSeries.points.length} ROWS ·{" "}
                  {selectedAuditSeries.points.filter((point) => point.conflict).length}{" "}
                  CONFLICTS
                </span>
              </div>

              <div className="evidence-timeline-block">
                <div className="evidence-timeline-title">
                  <strong>
                    {selectedAuditSeries.valueMode === "probability"
                      ? "VERIFIED PROBABILITY TIMELINE"
                      : selectedAuditSeries.valueMode === "raw"
                        ? "RAW-ONLY EVENTS · NO VALUE SCALE"
                        : "VALUE UNAVAILABLE"}
                  </strong>
                  <small>
                    {selectedAuditSeries.valueMode === "probability" &&
                    auditChartValues.length
                      ? `${formatProbability(auditChartMin)} — ${formatProbability(
                          auditChartMax,
                        )}`
                      : selectedAuditSeries.valueMode === "raw"
                        ? "Raw values are retained exactly; probability is unavailable."
                        : "Waiting for a usable authenticated value."}
                  </small>
                </div>
                <div className="evidence-timeline-scroll">
                  <div className="evidence-timeline" aria-hidden="true">
                    <span className="evidence-axis" />
                    {auditChartPoints.map((point, index) => {
                      const value = auditPointValue(
                        point,
                        selectedAuditSeries.valueMode,
                      );
                      const left =
                        auditChartPoints.length === 1
                          ? 50
                          : (((point.sourceAt ?? point.retrievedAt) - auditTimeMin) /
                              auditTimeRange) *
                            100;
                      const height =
                        selectedAuditSeries.valueMode === "probability" && value !== null
                          ? 14 + ((value - auditChartMin) / auditChartRange) * 70
                          : 12;
                      return (
                        <span
                          className={`evidence-point ${selectedAuditSeries.valueMode}`}
                          key={`${point.sourceAt}|${point.retrievedAt}|${point.fingerprint}|${index}`}
                          style={{ left: `${left}%`, height: `${height}%` }}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="evidence-table-block">
                <div className="evidence-table-title">
                  <strong>Latest authenticated evidence rows</strong>
                  <small>Source and retrieval time remain separate</small>
                </div>
                <div className="evidence-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">SOURCE UTC</th>
                        <th scope="col">RETRIEVED UTC</th>
                        <th scope="col">PROBABILITY</th>
                        <th scope="col">RAW PRICE (UNSCALED)</th>
                        <th scope="col">QUALITY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditTablePoints.map((point, index) => (
                        <tr
                          className={point.conflict ? "conflict" : ""}
                          key={`${point.sourceAt}|${point.retrievedAt}|${point.fingerprint}|table-${index}`}
                        >
                          <td>
                            {point.sourceAt === null ? (
                              "missing"
                            ) : (
                              <time dateTime={new Date(point.sourceAt).toISOString()}>
                                {formatSnapshotTime(point.sourceAt)}
                              </time>
                            )}
                          </td>
                          <td>
                            <time dateTime={new Date(point.retrievedAt).toISOString()}>
                              {formatSnapshotTime(point.retrievedAt)}
                            </time>
                          </td>
                          <td>
                            {formatAuditValue(point.probability, "probability")}
                          </td>
                          <td>{formatAuditValue(point.rawPrice, "raw")}</td>
                          <td>
                            {point.conflict
                              ? "CONFLICT"
                              : point.timestampQuality === "source"
                                ? "SOURCE-TIMED"
                                : "RETRIEVAL-ONLY"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="snapshot-empty evidence-empty">
              No authenticated history yet. Keep this tab open to collect.
            </div>
          )}
        </section>
        <p className="snapshot-boundary">
          This panel is real TxLINE data and the history stays on this device. Raw-only
          or single-source changes remain observations, never confirmed signals. The
          timeline and CSV contain authenticated device-local history only. The replay
          below stays synthetic until strict multi-source evidence exists. Collection
          runs only while this tab is visible; it is not a server background job.
        </p>
      </section>

      <section className="hero-grid" aria-label="Primary signal view">
        <article className={`signal-card ${selected.assessment.level}`}>
          <div className="panel-heading">
            <div>
              <span className="section-kicker">
                FOCUS SIGNAL · DETERMINISTIC REPLAY
              </span>
              <h2>
                {selected.fixture.home} <span>vs</span> {selected.fixture.away}
              </h2>
            </div>
            <span className={`signal-badge ${selected.assessment.level}`}>
              {signalLabel(selected.assessment.level)}
            </span>
          </div>

          <div className="replay-disclosure">
            SYNTHETIC PRICES · SYNTHETIC SCORE/CLOCK · NOT TXLINE MATCH STATE
          </div>

          <div className="match-strip">
            <div>
              <span>{selected.fixture.clock}</span>
              <strong>{selected.fixture.score}</strong>
            </div>
            <div>
              <small>MARKET</small>
              <b>{selected.fixture.market.replaceAll("_", " ")}</b>
            </div>
            <div>
              <small>AGENT ACTION</small>
              <b className={`action-${selected.assessment.action.toLowerCase()}`}>
                {selected.assessment.action}
              </b>
            </div>
          </div>

          <div className="movement-hero">
            <div>
              <span className="movement-label">{selected.fixture.selection} fair probability</span>
              <strong>{formatProbability(selected.assessment.currentProb)}</strong>
              <em className={selected.assessment.direction}>
                {formatShift(selected.assessment.deltaProb)} · {selected.assessment.direction}
              </em>
            </div>
            <div className="confidence-ring" style={{ "--confidence": selected.assessment.confidence } as React.CSSProperties}>
              <span>{selected.assessment.confidence}</span>
              <small>CONFIDENCE</small>
            </div>
          </div>

          <div className="spark-chart" aria-label="Probability replay chart">
            {selectedSeries.map((value, index) => {
              const height = 20 + ((value - seriesMin) / range) * 78;
              const isCurrent = index === selectedSeries.length - 1;
              return (
                <span className="spark-column" key={`${selected.fixture.id}-${index}`}>
                  <i
                    className={isCurrent ? "current" : ""}
                    style={{ height: `${height}%` }}
                  />
                </span>
              );
            })}
            <span className="threshold-line" aria-hidden="true" />
          </div>

          <p className="signal-reason">
            <span aria-hidden="true">↳</span> {selected.assessment.reason}
          </p>
        </article>

        <aside className="metrics-stack">
          <div className="metric-card accent">
            <span>ACTIVE SIGNALS</span>
            <strong>{activeSignals.length.toString().padStart(2, "0")}</strong>
            <small>
              {activeSignals.length
                ? "replay decisions generated"
                : "replay thresholds monitoring"}
            </small>
          </div>
          <div className="metric-card">
            <span>PAIRED SOURCES</span>
            <strong>{PROVIDERS.length}</strong>
            <small>rogue-source rejection enabled</small>
          </div>
          <div className="metric-card">
            <span>MAX WINDOW MOVE</span>
            <strong>{(maxShift * 100).toFixed(1)}<sup>pp</sup></strong>
            <small>fast horizon · 8–60 seconds</small>
          </div>
          <div className="metric-card">
            <span>VIRTUAL CLOCK</span>
            <strong className="clock-value">{formatClock(virtualTime(frame)).replace(" UTC", "")}</strong>
            <small>schema-compatible replay</small>
          </div>
        </aside>
      </section>

      <section className="desk-grid">
        <article className="panel fixture-panel">
          <div className="panel-heading compact">
            <div>
              <span className="section-kicker">MARKET WATCH</span>
              <h2>Replay scenarios</h2>
            </div>
            <span className="muted-count">{FIXTURES.length} synthetic</span>
          </div>
          <div className="fixture-list">
            {assessments.map(({ fixture, assessment }) => (
              <button
                className={`fixture-row ${fixture.id === selected.fixture.id ? "selected" : ""}`}
                key={fixture.id}
                type="button"
                onClick={() => setSelectedId(fixture.id)}
              >
                <span className={`row-status ${assessment.level}`} aria-hidden="true" />
                <span className="fixture-name">
                  <strong>{fixture.home} · {fixture.away}</strong>
                  <small>{fixture.clock} · {fixture.score}</small>
                </span>
                <span className="fixture-move">
                  <strong className={assessment.direction}>{formatShift(assessment.deltaProb)}</strong>
                  <small>{assessment.confidence}% conf.</small>
                </span>
                <span className="row-action">{assessment.action}</span>
              </button>
            ))}
          </div>
        </article>

        <article className="panel price-panel">
          <div className="panel-heading compact">
            <div>
              <span className="section-kicker">CONSENSUS PRICE</span>
              <h2>Fair probability</h2>
            </div>
            <span className="source-label">NO-VIG VIEW</span>
          </div>
          <div className="outcome-grid">
            {outcomes.map((outcome) => (
              <div className="outcome-card" key={outcome.label}>
                <span>{outcome.label}</span>
                <strong>{formatProbability(outcome.probability)}</strong>
                <small>{(1 / outcome.probability).toFixed(2)} fair odds</small>
              </div>
            ))}
          </div>
          <div className="sensitivity-control">
            <div>
              <label htmlFor="sensitivity">Trigger threshold</label>
              <span>{sensitivity.toFixed(2)}× profile</span>
            </div>
            <input
              id="sensitivity"
              type="range"
              min="0.7"
              max="1.3"
              step="0.05"
              value={sensitivity}
              onChange={(event) => setSensitivity(Number(event.target.value))}
            />
            <div className="range-labels">
              <span>more sensitive</span>
              <span>more selective</span>
            </div>
          </div>
        </article>
      </section>

      <section className="lower-grid">
        <article className="panel alert-panel">
          <div className="panel-heading compact">
            <div>
              <span className="section-kicker">AUTONOMOUS REPLAY OUTPUT</span>
              <h2>Replay signal ledger</h2>
            </div>
            <span className="muted-count">synthetic · deduplicated</span>
          </div>
          <div className="alert-table" role="table" aria-label="Detected signals">
            <div className="alert-row header" role="row">
              <span>TIME</span>
              <span>FIXTURE / SELECTION</span>
              <span>MOVE</span>
              <span>CONF.</span>
              <span>STATE</span>
            </div>
            {alerts.length ? (
              alerts.map((alert) => (
                <div className="alert-row" role="row" key={alert.id}>
                  <span>{alert.time.replace(" UTC", "")}</span>
                  <span>
                    <strong>{alert.match}</strong>
                    <small>{alert.selection}</small>
                  </span>
                  <span className={alert.direction}>{formatShift(alert.shift)}</span>
                  <span>{alert.confidence}%</span>
                  <span>
                    <b className={`ledger-state ${alert.level}`}>{signalLabel(alert.level)}</b>
                  </span>
                </div>
              ))
            ) : (
              <div className="empty-ledger">No confirmed movement in this replay window yet.</div>
            )}
          </div>
        </article>

        <aside className="panel integrity-panel">
          <div className="panel-heading compact">
            <div>
              <span className="section-kicker">DATA INTEGRITY</span>
              <h2>What the agent trusts</h2>
            </div>
          </div>
          <ul className="integrity-list">
            <li>
              <span className="check">01</span>
              <div>
                <strong>Paired quotes only</strong>
                <small>Never compares different providers or market lines.</small>
              </div>
            </li>
            <li>
              <span className="check">02</span>
              <div>
                <strong>Breadth before alarm</strong>
                <small>At least 67% of matched sources must agree.</small>
              </div>
            </li>
            <li>
              <span className="check">03</span>
              <div>
                <strong>Event-aware labels</strong>
                <small>Score changes are separated from unexplained repricing.</small>
              </div>
            </li>
          </ul>
          <div className={`adapter-status ${connector.status}`}>
            <span>
              <i aria-hidden="true" />
              TXLINE ADAPTER · {connector.network.toUpperCase()}
            </span>
            <strong>
              {connector.status === "ready"
                ? `${connector.worldCupCount} WORLD CUP · ${connector.fixtureCount} AVAILABLE`
                : "SNAPSHOT NOT CONNECTED"}
            </strong>
            <small>{connector.message}</small>
          </div>
        </aside>
      </section>

      <footer>
        <span>ODDPULSE / BUILT FOR TXLINE WORLD CUP HACKATHON</span>
        <span>SIMULATION IS LABELLED · NO BETTING EXECUTION · EXPLAINABLE SIGNALS</span>
      </footer>
    </main>
  );
}
