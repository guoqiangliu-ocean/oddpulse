import { env as workerEnv } from "cloudflare:workers";
import {
  validateOddsProof,
  type OddsProofCheck,
} from "../../lib/odds-proof.ts";
import {
  cachedTxLine,
  listWorldCupFixtures,
  loadOddsSnapshot,
  txLineConfigured,
  txLineNetwork,
} from "../../lib/txline-client.ts";

type RuntimeKey = "TXLINE_RPC_URL" | "TXLINE_VIEW_PAYER";

type QuoteCandidate = {
  fixtureId: number;
  messageId: string;
  sourceTimestamp: number;
  provider: string;
  market: string;
  period: string | null;
  parameters: string | null;
};

type PublicProof = {
  status: "VERIFIED_ONCHAIN" | "PROOF_FETCHED" | "AWAITING_PROOF" | "UNAVAILABLE";
  message: string;
  source: "/api/odds/validation";
  record: QuoteCandidate | null;
  onChain: Pick<
    OddsProofCheck,
    | "attempted"
    | "verified"
    | "programId"
    | "dailyOddsPda"
    | "rootAccountExists"
    | "transactionSubmitted"
    | "treeNodes"
    | "errorCode"
  >;
};

const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers });

const PUBLIC_VIEW_PAYER = "Labu6tAuwzpTvoq6hq6p5r7AxMBgtbvpxW4mMHwXieo";
const PUBLIC_DEVNET_RPC_FALLBACK = "https://solana-devnet.api.onfinality.io/public";

const runtimeValue = (key: RuntimeKey) => {
  const binding = (workerEnv as unknown as Partial<Record<RuntimeKey, string>>)[key];
  return binding || process.env[key];
};

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const read = (source: unknown, ...keys: string[]) => {
  const body = record(source);
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) return body[key];
  }
  return undefined;
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim()
    ? value.normalize("NFC").trim().replace(/\s+/g, " ").slice(0, 500)
    : null;

const integer = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

function selectQuoteCandidate(rows: unknown[], fixtureId: number): QuoteCandidate | null {
  for (const row of rows) {
    const rowFixtureId = integer(read(row, "FixtureId", "fixtureId"));
    const messageId = text(read(row, "MessageId", "messageId"));
    const sourceTimestamp = integer(read(row, "Ts", "ts"));
    const provider = text(read(row, "Bookmaker", "bookmaker"));
    const market = text(read(row, "SuperOddsType", "superOddsType"));
    if (
      rowFixtureId !== fixtureId ||
      !messageId ||
      sourceTimestamp === null ||
      sourceTimestamp < 1 ||
      !provider ||
      !market
    ) {
      continue;
    }
    return {
      fixtureId,
      messageId,
      sourceTimestamp,
      provider,
      market,
      period: text(read(row, "MarketPeriod", "marketPeriod")),
      parameters: text(read(row, "MarketParameters", "marketParameters")),
    };
  }
  return null;
}

function publicOnChain(check: OddsProofCheck) {
  return {
    attempted: check.attempted,
    verified: check.verified,
    programId: check.programId,
    dailyOddsPda: check.dailyOddsPda,
    rootAccountExists: check.rootAccountExists,
    transactionSubmitted: check.transactionSubmitted,
    treeNodes: check.treeNodes,
    errorCode: check.errorCode,
  };
}

const emptyOnChain = (): PublicProof["onChain"] => ({
  attempted: false,
  verified: false,
  programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  dailyOddsPda: null,
  rootAccountExists: false,
  transactionSubmitted: false,
  treeNodes: 0,
  errorCode: null,
});

const proofCache = new Map<string, { expiresAt: number; proof: PublicProof }>();
const proofInFlight = new Map<string, Promise<PublicProof>>();

function cacheQuoteProof(cacheKey: string, proof: PublicProof) {
  const ttlMs = proof.status === "VERIFIED_ONCHAIN" ? 5 * 60_000 : 30_000;
  proofCache.set(cacheKey, { proof, expiresAt: Date.now() + ttlMs });
}

async function resolveQuoteProof(candidate: QuoteCandidate): Promise<PublicProof> {
  const cacheKey = `${candidate.messageId}|${candidate.sourceTimestamp}`;
  const cached = proofCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.proof;
  const pending = proofInFlight.get(cacheKey);
  if (pending) return pending;

  const request = resolveQuoteProofUncached(candidate).finally(() => {
    proofInFlight.delete(cacheKey);
  });
  proofInFlight.set(cacheKey, request);
  return request;
}

async function resolveQuoteProofUncached(
  candidate: QuoteCandidate,
): Promise<PublicProof> {
  const cacheKey = `${candidate.messageId}|${candidate.sourceTimestamp}`;

  let payload: unknown;
  try {
    const query = new URLSearchParams({
      messageId: candidate.messageId,
      ts: String(candidate.sourceTimestamp),
    });
    payload = await cachedTxLine(`/api/odds/validation?${query.toString()}`, 30_000);
  } catch {
    const proof: PublicProof = {
      status: "UNAVAILABLE",
      message:
        "No compatible quote-proof response is available for this quote. No proof badge was issued.",
      source: "/api/odds/validation",
      record: candidate,
      onChain: emptyOnChain(),
    };
    cacheQuoteProof(cacheKey, proof);
    return proof;
  }

  const viewPayer = runtimeValue("TXLINE_VIEW_PAYER") || PUBLIC_VIEW_PAYER;
  const primaryRpc = runtimeValue("TXLINE_RPC_URL") || "https://api.devnet.solana.com";
  let onChain = await validateOddsProof({
    proofPayload: payload,
    rpcUrl: primaryRpc,
    viewPayer,
  });
  if (
    !onChain.verified &&
    /403|429|FORBIDDEN|RATE_LIMIT|RPC_HTTP/.test(onChain.errorCode || "") &&
    primaryRpc !== PUBLIC_DEVNET_RPC_FALLBACK
  ) {
    onChain = await validateOddsProof({
      proofPayload: payload,
      rpcUrl: PUBLIC_DEVNET_RPC_FALLBACK,
      viewPayer,
    });
  }

  const matchesQuote =
    onChain.record?.fixtureId === candidate.fixtureId &&
    onChain.record.messageId === candidate.messageId &&
    onChain.record.sourceTimestamp === candidate.sourceTimestamp &&
    onChain.record.provider === candidate.provider &&
    onChain.record.market === candidate.market &&
    onChain.record.period === candidate.period &&
    onChain.record.parameters === candidate.parameters;
  const proof: PublicProof = !matchesQuote
    ? {
        status: "UNAVAILABLE",
        message: "The proof response did not match the selected quote, so it was rejected.",
        source: "/api/odds/validation",
        record: candidate,
        onChain: publicOnChain(onChain),
      }
    : onChain.verified
      ? {
          status: "VERIFIED_ONCHAIN",
          message:
            "This exact quote was verified against the TxLINE Devnet odds root by read-only simulation.",
          source: "/api/odds/validation",
          record: candidate,
          onChain: publicOnChain(onChain),
        }
      : {
          status: onChain.attempted ? "PROOF_FETCHED" : "UNAVAILABLE",
          message: onChain.attempted
            ? "A proof was fetched, but its on-chain validation did not pass. No proof badge was issued."
            : "The proof response could not be safely validated.",
          source: "/api/odds/validation",
          record: candidate,
          onChain: publicOnChain(onChain),
        };
  cacheQuoteProof(cacheKey, proof);
  return proof;
}

export async function GET(request: Request) {
  if (!txLineConfigured()) {
    return json(
      {
        configured: false,
        mode: "unavailable",
        network: txLineNetwork(),
        message: "TxLINE access is not configured for this deployment.",
      },
      503,
    );
  }

  const fixtureParam = new URL(request.url).searchParams.get("fixtureId") || "";
  if (!/^\d+$/.test(fixtureParam)) {
    return json({ code: "INVALID_FIXTURE", message: "Fixture ID is invalid." }, 400);
  }
  const fixtureId = Number(fixtureParam);
  if (!Number.isSafeInteger(fixtureId) || fixtureId < 1) {
    return json({ code: "INVALID_FIXTURE", message: "Fixture ID is invalid." }, 400);
  }

  try {
    const fixtures = await listWorldCupFixtures();
    const fixture = fixtures.find((item) => item.fixtureId === fixtureId);
    if (!fixture) {
      return json(
        {
          code: "FIXTURE_NOT_AVAILABLE",
          message: "Fixture is outside the authenticated World Cup catalogue.",
        },
        404,
      );
    }
    const candidate = selectQuoteCandidate(await loadOddsSnapshot(fixtureId), fixtureId);
    if (!candidate) {
      return json({
        configured: true,
        mode: "authenticated-odds-proof",
        network: txLineNetwork(),
        fixture,
        proof: {
          status: "AWAITING_PROOF",
          message:
            "No proof-eligible odds record is available for this fixture snapshot yet.",
          source: "/api/odds/validation",
          record: null,
          onChain: emptyOnChain(),
        } satisfies PublicProof,
      });
    }

    return json({
      configured: true,
      mode: "authenticated-odds-proof",
      network: txLineNetwork(),
      fixture,
      proof: await resolveQuoteProof(candidate),
    });
  } catch {
    return json(
      {
        configured: true,
        mode: "unavailable",
        network: txLineNetwork(),
        code: "TXLINE_PROOF_UNAVAILABLE",
        message: "The authenticated quote-proof path is temporarily unavailable.",
      },
      502,
    );
  }
}
