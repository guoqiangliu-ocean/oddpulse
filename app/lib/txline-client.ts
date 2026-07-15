import { env as workerEnv } from "cloudflare:workers";

type RuntimeKey =
  | "TXLINE_API_TOKEN"
  | "TXLINE_BASE_URL"
  | "TXLINE_NETWORK"
  | "TXLINE_SESSION_JWT";

type JsonRecord = Record<string, unknown>;

export type TxLineFixture = {
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

export class TxLineUpstreamError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("TxLINE upstream request failed.");
    this.status = status;
  }
}

const runtimeValue = (key: RuntimeKey) => {
  const binding = (workerEnv as unknown as Partial<Record<RuntimeKey, string>>)[key];
  return binding || process.env[key];
};

export const txLineConfigured = () => Boolean(runtimeValue("TXLINE_API_TOKEN"));
export const txLineBaseUrl = () =>
  (runtimeValue("TXLINE_BASE_URL") || "https://txline-dev.txodds.com").replace(
    /\/$/,
    "",
  );
export const txLineNetwork = () =>
  runtimeValue("TXLINE_NETWORK") ||
  (txLineBaseUrl().includes("txline-dev") ? "devnet" : "mainnet");

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

const integer = (value: unknown) => {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

let guestSession: { token: string; expiresAt: number } | null = runtimeValue(
  "TXLINE_SESSION_JWT",
)
  ? {
      token: runtimeValue("TXLINE_SESSION_JWT")!,
      expiresAt: Date.now() + 60_000,
    }
  : null;
let guestRefresh: Promise<string> | null = null;
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

async function guestJwt(forceRefresh = false) {
  if (!forceRefresh && guestSession && guestSession.expiresAt > Date.now()) {
    return guestSession.token;
  }
  if (!guestRefresh) {
    guestRefresh = fetch(`${txLineBaseUrl()}/auth/guest/start`, {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    })
      .then(async (response) => {
        if (!response.ok) throw new TxLineUpstreamError(response.status);
        const body = (await response.json()) as { token?: unknown };
        if (typeof body.token !== "string" || !body.token) {
          throw new TxLineUpstreamError(502);
        }
        guestSession = { token: body.token, expiresAt: Date.now() + 8 * 60_000 };
        return body.token;
      })
      .finally(() => {
        guestRefresh = null;
      });
  }
  return guestRefresh;
}

export async function fetchTxLine(path: string) {
  let jwt = await guestJwt();
  const request = () =>
    fetch(`${txLineBaseUrl()}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": runtimeValue("TXLINE_API_TOKEN") || "",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  let response = await request();
  if (response.status === 401) {
    jwt = await guestJwt(true);
    response = await request();
  }
  if (!response.ok) throw new TxLineUpstreamError(response.status);
  return response.json() as Promise<unknown>;
}

export async function cachedTxLine(path: string, ttlMs: number) {
  const cached = responseCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = inFlight.get(path);
  if (pending) return pending;
  const request = fetchTxLine(path)
    .then((value) => {
      responseCache.set(path, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inFlight.delete(path));
  inFlight.set(path, request);
  return request;
}

export function txLineRows(value: unknown) {
  if (Array.isArray(value)) return value;
  const body = record(value);
  for (const key of ["data", "items", "fixtures", "records", "odds"]) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  return [] as unknown[];
}

export function normalizeFixture(raw: unknown): TxLineFixture | null {
  const fixtureId = integer(read(raw, "FixtureId", "fixtureId"));
  if (fixtureId === null || fixtureId < 1) return null;
  const participant1 = textValue(
    read(raw, "Participant1", "participant1"),
    "Participant 1",
  );
  const participant2 = textValue(
    read(raw, "Participant2", "participant2"),
    "Participant 2",
  );
  const participant1IsHome =
    read(raw, "Participant1IsHome", "participant1IsHome") !== false;
  return {
    fixtureId,
    participant1,
    participant2,
    participant1IsHome,
    home: participant1IsHome ? participant1 : participant2,
    away: participant1IsHome ? participant2 : participant1,
    startTime: (read(raw, "StartTime", "startTime") as string | number | null) ?? null,
    competition: textValue(read(raw, "Competition", "competition"), "Unknown competition"),
    gameState: (read(raw, "GameState", "gameState") as string | number) ?? "unknown",
  };
}

export async function listWorldCupFixtures() {
  const fixtures = txLineRows(await cachedTxLine("/api/fixtures/snapshot", 60_000))
    .map(normalizeFixture)
    .filter((fixture): fixture is TxLineFixture => Boolean(fixture))
    .filter((fixture) => fixture.competition.toLowerCase().includes("world cup"));
  return [...new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture])).values()];
}

export async function loadOddsSnapshot(fixtureId: number) {
  return txLineRows(await cachedTxLine(`/api/odds/snapshot/${fixtureId}`, 12_000));
}
