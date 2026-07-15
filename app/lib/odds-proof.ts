import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import txoracleIdl from "./txoracle-devnet.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const COMPUTE_UNIT_LIMIT = 1_400_000;
const PLACEHOLDER_BLOCKHASH = SystemProgram.programId.toBase58();
const RPC_TIMEOUT_MS = 12_000;

type JsonRecord = Record<string, unknown>;

type ProofNode = { hash: number[]; isRightSibling: boolean };

type PreparedOddsProof = {
  targetTs: number;
  publicRecord: {
    fixtureId: number;
    messageId: string;
    sourceTimestamp: number;
    provider: string;
    market: string;
    period: string | null;
    parameters: string | null;
  };
  oddsSnapshot: {
    fixtureId: anchor.BN;
    messageId: string;
    ts: anchor.BN;
    bookmaker: string;
    bookmakerId: number;
    superOddsType: string;
    gameState: string | null;
    inRunning: boolean;
    marketParameters: string | null;
    marketPeriod: string | null;
    priceNames: string[];
    prices: number[];
  };
  summary: {
    fixtureId: anchor.BN;
    updateStats: {
      updateCount: number;
      minTimestamp: anchor.BN;
      maxTimestamp: anchor.BN;
    };
    oddsSubTreeRoot: number[];
  };
  subTreeProof: ProofNode[];
  mainTreeProof: ProofNode[];
};

export type OddsProofCheck = {
  attempted: boolean;
  verified: boolean;
  programId: string;
  dailyOddsPda: string | null;
  rootAccountExists: boolean;
  transactionSubmitted: false;
  record: {
    fixtureId: number | null;
    messageId: string | null;
    sourceTimestamp: number | null;
    provider: string | null;
    market: string | null;
    period: string | null;
    parameters: string | null;
  } | null;
  treeNodes: number;
  errorCode: string | null;
};

type LegacyTransaction = Parameters<NonNullable<anchor.Provider["simulate"]>>[0] & {
  instructions?: ConstructorParameters<typeof TransactionMessage>[0]["instructions"];
};

type RpcSimulationBody = {
  result?: {
    value?: {
      err: unknown;
      logs: string[] | null;
    };
  };
  error?: { code?: number; message?: string };
};

const object = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const read = (source: unknown, ...keys: string[]) => {
  const sourceRecord = object(source);
  for (const key of keys) {
    if (sourceRecord[key] !== undefined && sourceRecord[key] !== null) {
      return sourceRecord[key];
    }
  }
  return undefined;
};

const integer = (value: unknown, label: string) => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`INVALID_${label}`);
  return number;
};

const requiredText = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_${label}`);
  return value.normalize("NFC").trim().slice(0, 500);
};

const optionalText = (value: unknown, label: string) => {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label);
};

const bytes32 = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length !== 32) throw new Error(`INVALID_${label}`);
  return value.map((entry) => {
    if (!Number.isInteger(entry) || entry < -128 || entry > 255) {
      throw new Error(`INVALID_${label}`);
    }
    return entry < 0 ? entry + 256 : entry;
  });
};

const proofNodes = (value: unknown, label: string) => {
  if (!Array.isArray(value)) throw new Error(`INVALID_${label}`);
  return value.map((node, index) => {
    const source = object(node);
    return {
      hash: bytes32(source.hash, `${label}_${index}_HASH`),
      isRightSibling: source.isRightSibling === true,
    };
  });
};

const stringVector = (value: unknown, label: string) => {
  if (!Array.isArray(value) || !value.length) throw new Error(`INVALID_${label}`);
  return value.map((entry, index) => requiredText(entry, `${label}_${index}`));
};

const i32Vector = (value: unknown, label: string) => {
  if (!Array.isArray(value) || !value.length) throw new Error(`INVALID_${label}`);
  return value.map((entry) => {
    const parsed = integer(entry, label);
    if (parsed < -2_147_483_648 || parsed > 2_147_483_647) {
      throw new Error(`INVALID_${label}`);
    }
    return parsed;
  });
};

export function prepareOddsProof(payload: unknown): PreparedOddsProof {
  const validation = object(payload);
  const odds = object(read(validation, "odds", "Odds"));
  const summary = object(read(validation, "summary", "Summary"));
  const updateStats = object(read(summary, "updateStats", "UpdateStats"));
  const fixtureId = integer(read(odds, "FixtureId", "fixtureId"), "FIXTURE_ID");
  const targetTs = integer(read(odds, "Ts", "ts"), "TIMESTAMP");
  const messageId = requiredText(read(odds, "MessageId", "messageId"), "MESSAGE_ID");
  const bookmaker = requiredText(read(odds, "Bookmaker", "bookmaker"), "BOOKMAKER");
  const bookmakerId = integer(read(odds, "BookmakerId", "bookmakerId"), "BOOKMAKER_ID");
  const superOddsType = requiredText(
    read(odds, "SuperOddsType", "superOddsType"),
    "MARKET",
  );
  const priceNames = stringVector(read(odds, "PriceNames", "priceNames"), "PRICE_NAMES");
  const prices = i32Vector(read(odds, "Prices", "prices"), "PRICES");
  const summaryFixtureId = integer(read(summary, "fixtureId", "FixtureId"), "SUMMARY_FIXTURE_ID");
  const minTimestamp = integer(
    read(updateStats, "minTimestamp", "MinTimestamp"),
    "MIN_TIMESTAMP",
  );
  const maxTimestamp = integer(
    read(updateStats, "maxTimestamp", "MaxTimestamp"),
    "MAX_TIMESTAMP",
  );
  const updateCount = integer(read(updateStats, "updateCount", "UpdateCount"), "UPDATE_COUNT");
  const inRunning = read(odds, "InRunning", "inRunning");

  if (
    fixtureId < 1 ||
    targetTs < 1 ||
    summaryFixtureId !== fixtureId ||
    minTimestamp < 1 ||
    maxTimestamp < minTimestamp ||
    targetTs < minTimestamp ||
    targetTs > maxTimestamp ||
    updateCount < 1 ||
    priceNames.length !== prices.length ||
    typeof inRunning !== "boolean"
  ) {
    throw new Error("INVALID_ODDS_PROOF_CONSISTENCY");
  }

  const gameState = optionalText(read(odds, "GameState", "gameState"), "GAME_STATE");
  const marketParameters = optionalText(
    read(odds, "MarketParameters", "marketParameters"),
    "MARKET_PARAMETERS",
  );
  const marketPeriod = optionalText(
    read(odds, "MarketPeriod", "marketPeriod"),
    "MARKET_PERIOD",
  );
  const subTreeProof = proofNodes(read(validation, "subTreeProof", "SubTreeProof"), "SUB_TREE_PROOF");
  const mainTreeProof = proofNodes(read(validation, "mainTreeProof", "MainTreeProof"), "MAIN_TREE_PROOF");

  return {
    targetTs,
    publicRecord: {
      fixtureId,
      messageId,
      sourceTimestamp: targetTs,
      provider: bookmaker,
      market: superOddsType,
      period: marketPeriod,
      parameters: marketParameters,
    },
    oddsSnapshot: {
      fixtureId: new anchor.BN(String(fixtureId)),
      messageId,
      ts: new anchor.BN(String(targetTs)),
      bookmaker,
      bookmakerId,
      superOddsType,
      gameState,
      inRunning,
      marketParameters,
      marketPeriod,
      priceNames,
      prices,
    },
    summary: {
      fixtureId: new anchor.BN(String(summaryFixtureId)),
      updateStats: {
        updateCount,
        minTimestamp: new anchor.BN(String(minTimestamp)),
        maxTimestamp: new anchor.BN(String(maxTimestamp)),
      },
      oddsSubTreeRoot: bytes32(
        read(summary, "oddsSubTreeRoot", "OddsSubTreeRoot"),
        "ODDS_SUB_TREE_ROOT",
      ),
    },
    subTreeProof,
    mainTreeProof,
  };
}

function safeErrorCode(error: unknown) {
  const candidate = error as { code?: string | number; message?: string };
  if (candidate?.code !== undefined) return String(candidate.code).slice(0, 80);
  const message = String(candidate?.message || "ONCHAIN_SIMULATION_FAILED");
  const direct = message.match(/^[A-Z][A-Z0-9_]{2,100}$/)?.[0];
  if (direct) return direct;
  return (
    message
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "ONCHAIN_SIMULATION_FAILED"
  );
}

/**
 * Use Solana's replacement-blockhash simulation path: this performs the
 * exact program view without a signature, wallet action, or transaction.
 */
function installSingleRequestSimulator(args: {
  provider: anchor.AnchorProvider;
  rpcUrl: string;
  payer: PublicKey;
}) {
  args.provider.simulate = async (transaction, signers) => {
    if (signers?.length) throw new Error("READ_ONLY_SIMULATION_REJECTS_SIGNERS");
    if (transaction instanceof VersionedTransaction) {
      throw new Error("UNEXPECTED_VERSIONED_VIEW_TRANSACTION");
    }
    const legacy = transaction as LegacyTransaction;
    if (!Array.isArray(legacy.instructions)) throw new Error("INVALID_VIEW_TRANSACTION");
    const message = new TransactionMessage({
      payerKey: args.payer,
      recentBlockhash: PLACEHOLDER_BLOCKHASH,
      instructions: legacy.instructions,
    }).compileToV0Message();
    const encoded = Buffer.from(new VersionedTransaction(message).serialize()).toString(
      "base64",
    );
    const response = await fetch(args.rpcUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [
          encoded,
          {
            encoding: "base64",
            commitment: "confirmed",
            sigVerify: false,
            replaceRecentBlockhash: true,
          },
        ],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
    const body = (await response.json()) as RpcSimulationBody;
    if (body.error) throw new Error(`RPC_${body.error.code ?? "ERROR"}`);
    const value = body.result?.value;
    if (!value) throw new Error("RPC_SIMULATION_RESULT_MISSING");
    if (value.err) throw new Error("ONCHAIN_PROGRAM_REJECTED");
    return { ...value, logs: value.logs ?? [] } as Awaited<
      ReturnType<NonNullable<anchor.Provider["simulate"]>>
    >;
  };
}

export async function validateOddsProof(args: {
  proofPayload: unknown;
  rpcUrl: string;
  viewPayer: string;
}): Promise<OddsProofCheck> {
  const base: OddsProofCheck = {
    attempted: false,
    verified: false,
    programId: PROGRAM_ID.toBase58(),
    dailyOddsPda: null,
    rootAccountExists: false,
    transactionSubmitted: false,
    record: null,
    treeNodes: 0,
    errorCode: null,
  };

  try {
    const material = prepareOddsProof(args.proofPayload);
    base.record = material.publicRecord;
    base.treeNodes = material.subTreeProof.length + material.mainTreeProof.length;
    const epochDay = Math.floor(material.targetTs / 86_400_000);
    if (epochDay < 0 || epochDay > 65_535) throw new Error("INVALID_PROOF_EPOCH_DAY");

    const idl = txoracleIdl as anchor.Idl;
    if ((idl as anchor.Idl & { address?: string }).address !== PROGRAM_ID.toBase58()) {
      throw new Error("INVALID_DEVNET_IDL_ADDRESS");
    }
    const payer = new PublicKey(args.viewPayer);
    const [dailyOddsPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("daily_batch_roots"),
        new anchor.BN(epochDay).toArrayLike(Buffer, "le", 2),
      ],
      PROGRAM_ID,
    );
    base.dailyOddsPda = dailyOddsPda.toBase58();

    const wallet = {
      publicKey: payer,
      signTransaction: async () => {
        throw new Error("READ_ONLY_WALLET_MUST_NOT_SIGN");
      },
      signAllTransactions: async () => {
        throw new Error("READ_ONLY_WALLET_MUST_NOT_SIGN");
      },
    } as unknown as anchor.Wallet;
    const provider = new anchor.AnchorProvider(new Connection(args.rpcUrl, "confirmed"), wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    installSingleRequestSimulator({ provider, rpcUrl: args.rpcUrl, payer });
    const program = new anchor.Program(idl, provider);
    if (!program.programId.equals(PROGRAM_ID)) throw new Error("INVALID_PROGRAM_ADDRESS");

    const method = program.methods
      .validateOdds(
        new anchor.BN(String(material.targetTs)),
        material.oddsSnapshot,
        material.summary,
        material.subTreeProof,
        material.mainTreeProof,
      )
      .accounts({ dailyOddsMerkleRoots: dailyOddsPda });

    base.attempted = true;
    const result = await method
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ])
      .view();
    base.verified = result === true;
    base.rootAccountExists = base.verified;
    return base;
  } catch (error) {
    return { ...base, errorCode: safeErrorCode(error) };
  }
}
