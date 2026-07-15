const finiteNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A standalone percentage is not enough to label an odds record as a fair
 * probability. Only return values when every outcome is present and the whole
 * vector has one coherent fraction or percent scale.
 */
export function normalizeProbabilityVector(
  names: unknown[],
  rawPercentages: unknown[],
) {
  const unavailable = names.map(() => null as number | null);
  if (!names.length || names.length !== rawPercentages.length) return unavailable;
  const parsed = rawPercentages.map((value) => {
    if (value === "NA" || value === null || value === undefined || value === "") {
      return null;
    }
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : null;
  });
  if (parsed.some((value) => value === null)) return unavailable;

  const values = parsed as number[];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.every((value) => value <= 1) && total >= 0.8 && total <= 1.2) {
    return values;
  }
  if (values.every((value) => value <= 100) && total >= 80 && total <= 120) {
    return values.map((value) => value / 100);
  }
  return unavailable;
}
