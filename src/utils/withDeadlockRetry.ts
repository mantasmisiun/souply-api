/**
 * Retry a transactional operation on a transient InnoDB deadlock / lock-wait timeout.
 *
 * Concurrent uploads and votes touch shared rows (Price per (sp,store,date),
 * StoreProductMatch aggregates, Product/StoreProduct during merges) in data-dependent
 * order, so a transient ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT is reachable under load.
 * Before this, only the orphan-refill path retried; a deadlock on the actual save/vote
 * transaction surfaced as a 500 — and on the debounced autosave the client swallowed it,
 * silently losing the user's edit. The operation MUST be self-contained (open its own
 * connection + begin/commit/rollback) so a retry re-runs the whole unit cleanly.
 */
const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

export async function withDeadlockRetry<T>(
    op: () => Promise<T>,
    opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
    const attempts = opts.attempts ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 120;
    let lastErr: any;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await op();
        } catch (e: any) {
            lastErr = e;
            if (!RETRYABLE.has(e?.code) || attempt === attempts) throw e;
            // Linear-ish backoff with a fixed jitter derived from the attempt (no RNG so
            // behavior is deterministic in tests). Two colliding txns won't re-collide in
            // lock-step because they entered the retry at slightly different times.
            const delay = baseDelayMs * attempt;
            if (opts.label) {
                console.warn(`[deadlock-retry] ${opts.label} hit ${e.code}, attempt ${attempt}/${attempts}, retrying in ${delay}ms`);
            }
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
