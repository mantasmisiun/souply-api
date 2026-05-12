type UnitClass = 'mass' | 'volume' | 'piece';

const UNIT_CLASS: Record<string, UnitClass> = {
    g: 'mass',
    kg: 'mass',
    ml: 'volume',
    l: 'volume',
    vnt: 'piece',
    'vnt.': 'piece',
    pcs: 'piece',
};

/**
 * Returns true only when both units are known AND belong to different physical
 * classes (e.g. mass vs volume). Unknown or missing units on either side are
 * treated as "no information" — not a conflict.
 */
export function detectUnitConflict(
    unitA: string | null | undefined,
    unitB: string | null | undefined,
): boolean {
    if (unitA == null || unitB == null) return false;
    const classA = UNIT_CLASS[unitA];
    const classB = UNIT_CLASS[unitB];
    if (classA === undefined || classB === undefined) return false;
    return classA !== classB;
}
