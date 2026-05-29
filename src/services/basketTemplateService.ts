/**
 * Pure decision logic for what happens when a user taps a template card.
 * Kept side-effect-free so the same function can be unit-tested without
 * touching the DB and reused by the instantiate endpoint + the daily
 * cleanup cron.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 3.
 */

export interface BasketSnapshot {
    id: number;
    status: 'draft' | 'compared' | 'inProgress' | 'completed' | string;
    hasBeenCalculated: 0 | 1 | boolean;
    userEditedAfterCreation: 0 | 1 | boolean;
}

export type InstantiateDecision =
    | { kind: 'createFresh'; deleteAbandonedIds: number[] }
    | { kind: 'resumeExisting'; basketId: number; deleteAbandonedIds: number[] };

/**
 * A basket is **abandoned** iff:
 *   • it was spawned from a template (`sourceTemplateId IS NOT NULL`, enforced
 *     by the caller's query)
 *   • status is not 'completed'
 *   • `hasBeenCalculated = 0`
 *   • `userEditedAfterCreation = 0`
 *
 * Abandoned baskets are silently discarded on the next template tap and by
 * the daily cleanup cron — there's nothing meaningful to resume.
 */
export function isAbandoned(b: BasketSnapshot): boolean {
    if (b.status === 'completed') return false;
    return !truthy(b.hasBeenCalculated) && !truthy(b.userEditedAfterCreation);
}

/**
 * A basket is **resumable** iff non-completed AND at least one of the two
 * "user touched this" signals fired. The instantiate endpoint surfaces
 * these to the client which prompts "Sukurti naują / Tęsti ankstesnį".
 */
export function isResumable(b: BasketSnapshot): boolean {
    if (b.status === 'completed') return false;
    return truthy(b.hasBeenCalculated) || truthy(b.userEditedAfterCreation);
}

/**
 * Given the user's existing baskets spawned from this template (any status,
 * any combination of flags), decide what the instantiate endpoint should do:
 *
 *   • If a non-completed, resumable basket exists → return its id so the
 *     client can prompt the user. Abandoned siblings (if any — rare but
 *     possible if the user instantiated, abandoned, instantiated again
 *     while disconnected) are listed for deletion.
 *   • Otherwise → return `createFresh`, plus the ids of any abandoned
 *     baskets that should be deleted in the same transaction.
 *
 * `completed` baskets are ignored entirely — they don't block re-instantiation.
 */
export function decideInstantiation(
    existing: BasketSnapshot[],
): InstantiateDecision {
    const abandoned = existing.filter(isAbandoned).map(b => b.id);
    const resumable = existing.filter(isResumable);

    if (resumable.length > 0) {
        // Stable pick: highest id (most recent insert). Spec says "non-trivial
        // instance exists" → show the resume prompt; doesn't matter which
        // one when there are multiple (which is itself a degenerate state
        // that shouldn't normally happen).
        const target = resumable.reduce((a, b) => (b.id > a.id ? b : a));
        return {
            kind: 'resumeExisting',
            basketId: target.id,
            deleteAbandonedIds: abandoned,
        };
    }

    return { kind: 'createFresh', deleteAbandonedIds: abandoned };
}

function truthy(v: 0 | 1 | boolean | undefined): boolean {
    return v === 1 || v === true;
}
