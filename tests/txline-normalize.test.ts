import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProbabilityVector } from "../app/lib/txline-normalize.ts";

test("accepts only a complete coherent fractional or percentage probability vector", () => {
  assert.deepEqual(
    normalizeProbabilityVector(["part1", "draw", "part2"], [0.5, 0.25, 0.25]),
    [0.5, 0.25, 0.25],
  );
  assert.deepEqual(
    normalizeProbabilityVector(["part1", "draw", "part2"], [50, "25", 25]),
    [0.5, 0.25, 0.25],
  );
});

test("fails closed for incomplete, mixed-scale, or implausible probability vectors", () => {
  const names = ["part1", "draw", "part2"];
  assert.deepEqual(normalizeProbabilityVector(names, [50, "NA", 25]), [null, null, null]);
  assert.deepEqual(normalizeProbabilityVector(names, [0.5, 25, 0.25]), [null, null, null]);
  assert.deepEqual(normalizeProbabilityVector(names, [80, 80, 80]), [null, null, null]);
  assert.deepEqual(normalizeProbabilityVector(names, [0.5, 0.5]), [null, null, null]);
});
