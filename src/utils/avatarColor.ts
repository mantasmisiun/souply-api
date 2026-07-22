/**
 * Curated avatar palette — colours that all read clearly with white text and
 * sit alongside the beet/teal brand without clashing. The client offers the
 * same set in its colour picker; the server picks one at random the first time
 * a user sets a display name (so everyone gets a distinct-ish circle without
 * having to choose).
 */
export const AVATAR_PALETTE = [
    '#EB6784', // beet
    '#5EA29A', // teal
    '#E8894D', // orange
    '#6C8AE4', // blue
    '#B07CD6', // purple
    '#E0A93B', // amber
    '#58B368', // green
    '#E06C9F', // pink
    '#4CA0B3', // cyan
    '#C76B6B', // clay
] as const;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const isValidAvatarColor = (v: unknown): v is string =>
    typeof v === 'string' && HEX_RE.test(v);

export const randomAvatarColor = (): string =>
    AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)];
