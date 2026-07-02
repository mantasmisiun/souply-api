/**
 * Fail-open observability. The receipt save/match/price/learning path deliberately
 * swallows-and-continues on best-effort side effects (fallback propagation, points, alias
 * learning, orphan refill, per-line resolver). That posture is correct — a background
 * hiccup must not fail a user's receipt — but the audit flagged it as INVISIBLE: a
 * systemic failure (pool exhaustion, schema drift) in any of these produced only a
 * console.warn on the VM, so pricing fan-out / points / matching could silently stop while
 * users still got 201s.
 *
 * This is a tiny in-process counter keyed by site. The daily digest reads and resets it,
 * turning a silent outage into a visible number. Not persisted (a restart resets it) —
 * enough to surface a sustained problem in the digest window, without a schema change.
 */

const counts = new Map<string, number>();

/** Record one swallowed best-effort failure at `site`. */
export function countFailOpen(site: string): void {
    counts.set(site, (counts.get(site) ?? 0) + 1);
}

/** Snapshot the current counts (does not reset). */
export function snapshotFailOpen(): Record<string, number> {
    return Object.fromEntries(counts);
}

/** Snapshot AND reset — for the daily digest so each report covers its own window. */
export function drainFailOpen(): Record<string, number> {
    const snap = Object.fromEntries(counts);
    counts.clear();
    return snap;
}
