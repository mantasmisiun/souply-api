/**
 * Minimal dependency-free semver comparison for the client version gate. Handles the
 * `MAJOR.MINOR.PATCH` release shape the app.json `version` uses, plus an optional
 * `-prerelease` suffix (a prerelease sorts BELOW its release, per semver). Missing numeric
 * parts default to 0 ("1.2" == "1.2.0"). Anything unparseable returns null so callers can
 * FAIL OPEN (treat as ok) rather than block on a garbage version string.
 *
 * Returns -1 if a < b, 0 if equal, 1 if a > b, or null if either side can't be parsed.
 */
function parse(v: string): { nums: number[]; pre: string | null } | null {
    if (typeof v !== 'string') return null;
    const cleaned = v.trim().replace(/^v/i, '');
    // Split off build metadata (+...) — ignored in precedence — then the prerelease (-...).
    const noBuild = cleaned.split('+')[0];
    const dash = noBuild.indexOf('-');
    const core = dash >= 0 ? noBuild.slice(0, dash) : noBuild;
    const pre = dash >= 0 ? noBuild.slice(dash + 1) : null;
    const parts = core.split('.');
    if (parts.length === 0 || parts.length > 3) return null;
    const nums: number[] = [];
    for (const p of parts) {
        if (!/^\d+$/.test(p)) return null;
        nums.push(parseInt(p, 10));
    }
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
}

export function semverCompare(a: string, b: string): number | null {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) {
        if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
    }
    // Cores equal → a release outranks a prerelease of the same core.
    if (pa.pre === pb.pre) return 0;
    if (pa.pre === null) return 1; // a is the release
    if (pb.pre === null) return -1; // b is the release
    // Both prereleases: lexical dotted compare (good enough for the gate).
    return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

/** True when `version` is STRICTLY BELOW `floor`. FAIL-OPEN: unparseable/empty → false
 *  (never blocked). An empty floor (null) also means "nobody is below it". */
export function isBelow(version: string | null | undefined, floor: string | null | undefined): boolean {
    if (!floor || !version) return false;
    const cmp = semverCompare(version, floor);
    return cmp === null ? false : cmp < 0;
}
