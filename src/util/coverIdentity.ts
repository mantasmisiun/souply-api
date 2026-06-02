/**
 * Pure validators for template cover identity (colour + image). Used by the
 * create / patch / from-basket controllers so an untrusted client can't store
 * a malformed colour or an arbitrary JSON blob in the cover columns.
 */

export type CoverImage =
    | { kind: 'preset'; iconKey: string }
    | { kind: 'emoji'; emoji: string };

/** Accept "#RGB".."#RRGGBBAA" hex strings; anything else → null. */
export function normalizeCoverColor(raw: unknown): string | null {
    return typeof raw === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.trim()) ? raw.trim() : null;
}

/** Accept { kind:'preset', iconKey } | { kind:'emoji', emoji }; else null. */
export function normalizeCoverImage(raw: unknown): CoverImage | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.kind === 'preset' && typeof o.iconKey === 'string') return { kind: 'preset', iconKey: o.iconKey };
    if (o.kind === 'emoji' && typeof o.emoji === 'string') return { kind: 'emoji', emoji: o.emoji };
    return null;
}
