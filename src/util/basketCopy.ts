/**
 * When copying a basket, decide which template (if any) the copy inherits its
 * identity from.
 *
 * An EDITED basket has diverged from the creator's original, so its copy is
 * "plain": no template link → no inherited emoji/colour/@attribution, and it
 * behaves like a manual basket (user can name it / save it as a template).
 *
 * An UNEDITED basket still matches the creator's original, so its copy keeps
 * the template link and the inherited identity.
 */
export function copiedSourceTemplateId(
    sourceTemplateId: number | null,
    userEdited: boolean,
): number | null {
    return userEdited ? null : (sourceTemplateId ?? null);
}
