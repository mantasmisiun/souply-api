/**
 * Wilson score interval — lower bound of a binomial proportion at a given
 * confidence level. Used by the vote state machine: raw ratios like 2/3
 * look the same as 200/300 but only the latter has enough evidence, and
 * Wilson's lower bound captures that distinction.
 *
 *   https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval
 *
 * `positives` and `total` must be non-negative integers with positives ≤ total.
 * Returns 0 when total is 0 (no evidence ≠ lower bound of 0 is a safe default).
 */

export function wilsonLowerBound(
    positives: number,
    total: number,
    z: number = 1.96
): number {
    if (total <= 0) return 0;
    if (positives < 0) positives = 0;
    if (positives > total) positives = total;

    const pHat = positives / total;
    const z2 = z * z;
    const denom = 1 + z2 / total;
    const centre = pHat + z2 / (2 * total);
    const margin = z * Math.sqrt((pHat * (1 - pHat) + z2 / (4 * total)) / total);
    return (centre - margin) / denom;
}
