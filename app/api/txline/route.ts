import { env as workerEnv } from "cloudflare:workers";

type TxLineFixture = {
  FixtureId?: number;
  fixtureId?: number;
  Participant1?: string;
  participant1?: string;
  Participant2?: string;
  participant2?: string;
  Participant1IsHome?: boolean;
  participant1IsHome?: boolean;
  StartTime?: string | number;
  startTime?: string | number;
  Competition?: string;
  competition?: string;
  GameState?: string | number;
  gameState?: string | number;
};

type TxLineMarket = {
  FixtureId?: number;
  fixtureId?: number;
  Ts?: number;
  ts?: number;
  Bookmaker?: string;
  bookmaker?: string;
  SuperOddsType?: string;
  superOddsType?: string;
  MarketParameters?: string;
  marketParameters?: string;
  MarketPeriod?: string;
  marketPeriod?: string;
  PriceNames?: string[];
  priceNames?: string[];
  Prices?: number[];
  prices?: number[];
  Pct?: string[];
  pct?: string[];
  InRunning?: boolean;
  inRunning?: boolean;
  GameState?: string;
  gameState?: string;
};

type RuntimeKey =
  | "TXLINE_API_TOKEN"
  | "TXLINE_BASE_URL"
  | "TXLINE_NETWORK"
  | "TXLINE_SESSION_JWT";

const runtimeValue = (key: RuntimeKey) => {
  const binding = (workerEnv as unknown as Partial<Record<RuntimeKey, string>>)[
    key
  ];
  return binding || process.env[key];
};

const configured = () => Boolean(runtimeValue("TXLINE_API_TOKEN"));

const baseUrl = () =>
  (runtimeValue("TXLINE_BASE_URL") || "https://txline-dev.txodds.com").replace(
    /\/$/,
    "",
  );

const network = () =>
  runtimeValue("TXLINE_NETWORK") ||
  (baseUrl().includes("txline-dev") ? "devnet" : "mainnet");

let guestSession: { token: string; expiresAt: number } | null =
  runtimeValue("TXLINE_SESSION_JWT")
    ? {
        token: runtimeValue("TXLINE_SESSION_JWT")!,
        expiresAt: Date.now() + 60_000,
      }
    : null;
let guestRefresh: Promise<string> | null = null;

async function getGuestJwt(forceRefresh = false) {
  if (!forceRefresh && guestSession && guestSession.expiresAt > Date.now()) {
    return guestSession.token;
  }

  if (!guestRefresh) {
    guestRefresh = fetch(`${baseUrl()}/auth/guest/start`, {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`TxLINE guest auth responded with ${response.status}`);
        }
        const body = (await response.json()) as { token?: string };
        if (!body.token) throw new Error("TxLINE guest auth returned no token");
        guestSession = {
          token: body.token,
          expiresAt: Date.now() + 8 * 60_000,
        };
        return body.token;
      })
      .finally(() => {
        guestRefresh = null;
      });
  }

  return guestRefresh;
}

const upstreamHeaders = (jwt: string) => ({
  Authorization: `Bearer ${jwt}`,
  "X-Api-Token": runtimeValue("TXLINE_API_TOKEN") || "",
  Accept: "application/json",
});

async function fetchUpstream(path: string) {
  let jwt = await getGuestJwt();
  let response = await fetch(`${baseUrl()}${path}`, {
    headers: upstreamHeaders(jwt),
    cache: "no-store",
  });
  if (response.status === 401) {
    jwt = await getGuestJwt(true);
    response = await fetch(`${baseUrl()}${path}`, {
      headers: upstreamHeaders(jwt),
      cache: "no-store",
    });
  }
  if (!response.ok) {
    throw new Error(`TxLINE responded with ${response.status}`);
  }
  return response.json();
}

function normalizeFixture(raw: TxLineFixture) {
  const participant1 = raw.Participant1 ?? raw.participant1 ?? "Participant 1";
  const participant2 = raw.Participant2 ?? raw.participant2 ?? "Participant 2";
  const participant1IsHome =
    raw.Participant1IsHome ?? raw.participant1IsHome ?? true;
  return {
    fixtureId: raw.FixtureId ?? raw.fixtureId,
    participant1,
    participant2,
    participant1IsHome,
    home: participant1IsHome ? participant1 : participant2,
    away: participant1IsHome ? participant2 : participant1,
    startTime: raw.StartTime ?? raw.startTime,
    competition: raw.Competition ?? raw.competition ?? "unknown",
    gameState: raw.GameState ?? raw.gameState ?? "unknown",
  };
}

function normalizeMarket(raw: TxLineMarket) {
  const names = raw.PriceNames ?? raw.priceNames ?? [];
  const prices = raw.Prices ?? raw.prices ?? [];
  const percentages = raw.Pct ?? raw.pct ?? [];
  return {
    fixtureId: raw.FixtureId ?? raw.fixtureId,
    // Missing upstream time must stay missing. Using retrieval time here would
    // create artificial history and could make repeated polls look like a move.
    timestamp: raw.Ts ?? raw.ts ?? null,
    provider: raw.Bookmaker ?? raw.bookmaker ?? "TxLINE StablePrice",
    market: raw.SuperOddsType ?? raw.superOddsType ?? "unknown",
    parameters: raw.MarketParameters ?? raw.marketParameters ?? "",
    period: raw.MarketPeriod ?? raw.marketPeriod ?? "match",
    inRunning: raw.InRunning ?? raw.inRunning ?? false,
    gameState: raw.GameState ?? raw.gameState ?? "unknown",
    outcomes: names.map((name, index) => {
      const percentage = percentages[index];
      const parsed = percentage && percentage !== "NA" ? Number(percentage) : null;
      return {
        name,
        rawPrice: prices[index] ?? null,
        probability:
          parsed === null || !Number.isFinite(parsed)
            ? null
            : parsed > 1
              ? parsed / 100
              : parsed,
      };
    }),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fixtureId = url.searchParams.get("fixtureId");

  if (!configured()) {
    return Response.json({
      configured: false,
      mode: "schema-compatible replay",
      network: network(),
      message:
        "TxLINE credentials are not configured. The dashboard is using an explicitly labelled deterministic replay.",
    });
  }

  try {
    if (fixtureId) {
      const raw = (await fetchUpstream(
        `/api/odds/snapshot/${encodeURIComponent(fixtureId)}`,
      )) as TxLineMarket[];
      return Response.json({
        configured: true,
        network: network(),
        mode: "authenticated-snapshot",
        fetchedAt: Date.now(),
        markets: raw.map(normalizeMarket),
      });
    }

    const raw = (await fetchUpstream("/api/fixtures/snapshot")) as TxLineFixture[];
    return Response.json({
      configured: true,
      network: network(),
      mode: "authenticated-snapshot",
      fetchedAt: Date.now(),
      fixtures: raw
        .map(normalizeFixture)
        .filter(
          (fixture) =>
            Number.isSafeInteger(fixture.fixtureId) &&
            Number(fixture.fixtureId) > 0,
        ),
    });
  } catch (error) {
    return Response.json(
      {
        configured: true,
        upstreamAvailable: false,
        message:
          error instanceof Error ? error.message : "TxLINE request failed",
      },
      { status: 502 },
    );
  }
}
