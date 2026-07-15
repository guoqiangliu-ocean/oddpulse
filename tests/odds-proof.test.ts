import assert from "node:assert/strict";
import test from "node:test";

import { prepareOddsProof } from "../app/lib/odds-proof.ts";

const sourceTimestamp = Date.UTC(2026, 6, 15, 2, 25, 31, 659);
const bytes32 = () => Array.from({ length: 32 }, () => -1);

function validPayload() {
  return {
    odds: {
      FixtureId: 18_241_006,
      MessageId: "proof-record-001",
      Ts: sourceTimestamp,
      Bookmaker: "TxLINE StablePrice",
      BookmakerId: 9,
      SuperOddsType: "MATCH_RESULT",
      GameState: "PREMATCH",
      InRunning: false,
      MarketParameters: "",
      MarketPeriod: "MATCH",
      PriceNames: ["part1", "draw", "part2"],
      Prices: [2_000, 3_200, 4_000],
    },
    summary: {
      fixtureId: 18_241_006,
      updateStats: {
        updateCount: 3,
        minTimestamp: sourceTimestamp - 1_000,
        maxTimestamp: sourceTimestamp + 1_000,
      },
      oddsSubTreeRoot: bytes32(),
    },
    subTreeProof: [{ hash: bytes32(), isRightSibling: false }],
    mainTreeProof: [{ hash: bytes32(), isRightSibling: true }],
  };
}

test("prepares a complete odds proof and converts signed hash bytes safely", () => {
  const prepared = prepareOddsProof(validPayload());

  assert.equal(prepared.publicRecord.fixtureId, 18_241_006);
  assert.equal(prepared.publicRecord.sourceTimestamp, sourceTimestamp);
  assert.equal(prepared.oddsSnapshot.fixtureId.toString(), "18241006");
  assert.equal(prepared.summary.oddsSubTreeRoot[0], 255);
  assert.equal(prepared.subTreeProof[0].hash[0], 255);
  assert.equal(prepared.mainTreeProof[0].isRightSibling, true);
});

test("rejects a proof with a mismatched fixture, incomplete price vector, or out-of-batch time", () => {
  const mismatchedFixture = validPayload();
  mismatchedFixture.summary.fixtureId = 18_241_007;
  assert.throws(() => prepareOddsProof(mismatchedFixture), /INVALID_ODDS_PROOF_CONSISTENCY/);

  const incompleteVector = validPayload();
  incompleteVector.odds.Prices = [2_000, 3_200];
  assert.throws(() => prepareOddsProof(incompleteVector), /INVALID_ODDS_PROOF_CONSISTENCY/);

  const outOfBatch = validPayload();
  outOfBatch.summary.updateStats.maxTimestamp = sourceTimestamp - 1;
  assert.throws(() => prepareOddsProof(outOfBatch), /INVALID_ODDS_PROOF_CONSISTENCY/);
});
