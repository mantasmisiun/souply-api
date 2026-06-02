/**
 * Realised savings to accrue onto a template's collectiveSavingsEur. Only
 * positive, finite amounts count — a NaN / negative / zero delta accrues
 * nothing. Keeps a bad client payload from corrupting the running total.
 */
export function clampSavings(eur: number): number {
    return Number.isFinite(eur) && eur > 0 ? eur : 0;
}
