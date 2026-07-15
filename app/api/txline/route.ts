import {
  listWorldCupFixtures,
  loadOddsSnapshot,
  txLineConfigured,
  txLineNetwork,
} from "../../lib/txline-client.ts";
import { normalizeProbabilityVector } from "../../lib/txline-normalize.ts";

type JsonRecord = Record<string, unknown>;

const jsonHeaders = { "Cache-Control": "no-store" };

const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const read = (source: unknown, ...keys: string[]) => {
  const sourceRecord = record(source);
  for (const key of keys) {
    if (sourceRecord[key] !== undefined && sourceRecord[key] !== null) {
      return sourceRecord[key];
    }
  }
  return undefined;
};

const textValue = (value: unknown, fallback = "") => {
  if (typeof value !== "string") return fallback;
  return value.normalize("NFC").trim().replace(/\s+/g, " ").slice(0, 180);
};

const finiteNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const values = (value: unknown) => (Array.isArray(value) ? value : []);

function normalizeMarket(raw: unknown) {
  const names = values(read(raw, "PriceNames", "priceNames"));
  const prices = values(read(raw, "Prices", "prices"));
  const percentages = values(read(raw, "Pct", "pct"));
  const probabilities = normalizeProbabilityVector(names, percentages);
  return {
    fixtureId: finiteNumber(read(raw, "FixtureId", "fixtureId")),
    // Missing upstream time must stay missing. Using retrieval time here would
    // create artificial history and could make repeated polls look like a move.
    timestamp: finiteNumber(read(raw, "Ts", "ts")),
    provider: textValue(read(raw, "Bookmaker", "bookmaker"), "TxLINE StablePrice"),
    market: textValue(read(raw, "SuperOddsType", "superOddsType"), "unknown"),
    parameters: textValue(read(raw, "MarketParameters", "marketParameters")),
    period: textValue(read(raw, "MarketPeriod", "marketPeriod"), "match"),
    inRunning: read(raw, "InRunning", "inRunning") === true,
    gameState: read(raw, "GameState", "gameState") ?? "unknown",
    outcomes: names.map((name, index) => ({
      name: textValue(name, `Outcome ${index + 1}`),
      rawPrice: finiteNumber(prices[index]),
      probability: probabilities[index] ?? null,
    })),
  };
}

export async function GET(request: Request) {
  if (!txLineConfigured()) {
    return Response.json(
      {
        configured: false,
        mode: "schema-compatible replay",
        network: txLineNetwork(),
        message:
          "TxLINE credentials are not configured. The dashboard is using an explicitly labelled deterministic replay.",
      },
      { headers: jsonHeaders },
    );
  }

  const url = new URL(request.url);
  const fixtureParam = url.searchParams.get("fixtureId");
  try {
    const fixtures = await listWorldCupFixtures();
    if (!fixtureParam) {
      return Response.json(
        {
          configured: true,
          network: txLineNetwork(),
          mode: "authenticated-snapshot",
          fetchedAt: Date.now(),
          fixtures,
        },
        { headers: jsonHeaders },
      );
    }

    if (!/^\d+$/.test(fixtureParam)) {
      return Response.json(
        { code: "INVALID_FIXTURE", message: "Fixture ID is invalid." },
        { status: 400, headers: jsonHeaders },
      );
    }
    const fixtureId = Number(fixtureParam);
    const fixture = fixtures.find((item) => item.fixtureId === fixtureId);
    if (!Number.isSafeInteger(fixtureId) || fixtureId < 1 || !fixture) {
      return Response.json(
        {
          code: "FIXTURE_NOT_AVAILABLE",
          message: "Fixture is outside the authenticated World Cup catalogue.",
        },
        { status: 404, headers: jsonHeaders },
      );
    }

    const raw = await loadOddsSnapshot(fixtureId);
    return Response.json(
      {
        configured: true,
        network: txLineNetwork(),
        mode: "authenticated-snapshot",
        fetchedAt: Date.now(),
        markets: raw
          .map(normalizeMarket)
          .filter((market) => market.fixtureId === fixtureId),
      },
      { headers: jsonHeaders },
    );
  } catch {
    return Response.json(
      {
        configured: true,
        upstreamAvailable: false,
        code: "TXLINE_UNAVAILABLE",
        message: "The authenticated TxLINE snapshot is temporarily unavailable.",
      },
      { status: 502, headers: jsonHeaders },
    );
  }
}
