import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds the OddPulse dashboard and server entry", async () => {
  const [layout, dashboard, worker] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/oddpulse-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    access(new URL("../dist/server/index.js", import.meta.url)),
  ]);

  assert.match(layout, /OddPulse — Verifiable Odds Movement Intelligence/);
  assert.match(dashboard, /See the move\. Verify the signal\. Know why it fired\./);
  assert.match(dashboard, /TXLINE ADAPTER/);
  assert.match(dashboard, /WORLD CUP/);
  assert.match(worker, /Content-Security-Policy/);
  assert.match(worker, /X-Content-Type-Options/);
  assert.match(worker, /frame-ancestors 'none'/);
  assert.doesNotMatch(dashboard, /Your site is taking shape|Codex is working/);
});

test("keeps TxLINE credentials and quote proofs on the server boundary", async () => {
  const [route, proofRoute, client, dashboard, envExample, gitignore] = await Promise.all([
    readFile(new URL("../app/api/txline/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/txline-proof/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/txline-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/oddpulse-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.match(client, /env as workerEnv.*cloudflare:workers/);
  assert.match(client, /process\.env\[key\]/);
  assert.match(client, /"X-Api-Token"/);
  assert.match(dashboard, /fetch\("\/api\/txline"(?:,|\))/);
  assert.match(dashboard, /fetch\(`\/api\/txline-proof\?fixtureId=/);
  assert.match(dashboard, /QUOTE PROOF · READ-ONLY CHECK/);
  assert.match(proofRoute, /validateOddsProof/);
  assert.match(proofRoute, /transactionSubmitted: false/);
  assert.match(proofRoute, /VERIFIED_ONCHAIN/);
  assert.equal(
    proofRoute.includes("onChain.record.provider === candidate.provider"),
    true,
  );
  assert.equal(
    proofRoute.includes("onChain.record.market === candidate.market"),
    true,
  );
  assert.doesNotMatch(dashboard, /TXLINE_API_TOKEN|X-Api-Token|TXLINE_SESSION_JWT/);
  assert.doesNotMatch(proofRoute, /TXLINE_API_TOKEN|X-Api-Token|TXLINE_SESSION_JWT/);
  assert.match(envExample, /^TXLINE_API_TOKEN=\s*$/m);
  assert.match(gitignore, /^\.env\*$/m);
});

test("keeps authenticated snapshots distinct from synthetic replay", async () => {
  const [route, client, dashboard, history] = await Promise.all([
    readFile(new URL("../app/api/txline/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/txline-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/oddpulse-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/snapshot-history.ts", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /AUTHENTICATED DEVNET SNAPSHOT/);
  assert.match(dashboard, /NOT A LIVE STREAM/);
  assert.match(dashboard, /DETERMINISTIC REPLAY/);
  assert.match(dashboard, /SYNTHETIC PRICES/);
  assert.match(dashboard, /DEVICE-LOCAL AUTHENTICATED HISTORY/);
  assert.match(dashboard, /LOCAL POLLING/);
  assert.match(dashboard, /MOVEMENT NOT ELIGIBLE/);
  assert.match(dashboard, /DEVICE-LOCAL AUTHENTICATED EVIDENCE/);
  assert.match(dashboard, /Export selected CSV/);
  assert.match(dashboard, /RAW-ONLY EVENTS · NO VALUE SCALE/);
  assert.match(dashboard, /ALL WORLD CUP FIXTURES/);
  assert.match(dashboard, /ROUND-ROBIN/);
  assert.match(dashboard, /BACKGROUND_CAPTURE_INTERVAL_MS = 60_000/);
  assert.match(dashboard, /document\.visibilityState === "visible"/);
  assert.match(dashboard, /nextBackgroundCaptureTarget/);
  assert.match(dashboard, /foregroundRequestId/);
  assert.match(dashboard, /not a server background job/);
  assert.match(dashboard, /new Blob/);
  assert.match(dashboard, /URL\.createObjectURL/);
  assert.match(dashboard, /id: "replay-fr-es"/);
  assert.doesNotMatch(dashboard, /id: "18237038"|id: "18241006"/);
  assert.match(client, /participant1IsHome/);
  assert.match(route, /mode: "authenticated-snapshot"/);
  assert.match(route, /fetchedAt: Date\.now\(\)/);
  assert.match(route, /normalizeProbabilityVector/);
  assert.match(route, /timestamp: finiteNumber\(read\(raw, "Ts", "ts"\)\)/);
  assert.match(route, /FIXTURE_NOT_AVAILABLE/);
  assert.match(route, /listWorldCupFixtures/);
  assert.match(history, /oddpulse-local/);
  assert.match(history, /mode !== "authenticated-snapshot"/);
  assert.match(history, /snapshotHistoryToCsv/);
  assert.match(history, /snapshot_fingerprint/);
  assert.doesNotMatch(history, /TXLINE_API_TOKEN|X-Api-Token|walletSecret/);
});
