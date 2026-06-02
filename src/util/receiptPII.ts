/**
 * Strip personally-identifying raw text from a receipt's parsedData. Used by
 * account deletion ('anonymize' mode): the structured purchase data (products,
 * prices, dates, store) is retained for the price database, but the raw OCR
 * text — which can contain partial card numbers, loyalty IDs, cashier IDs,
 * payment RRNs — is removed. Returns a sanitized deep copy; the input is not
 * mutated.
 *
 *   footer.rawText   — card/loyalty/payment fragments
 *   header.rawText   — cashier identifier
 *   products[].rawLines — raw OCR lines (redundant; structured fields kept)
 */
export function stripReceiptPII<T>(parsedData: T): T {
    if (!parsedData || typeof parsedData !== 'object') return parsedData;
    const d: any = structuredClone(parsedData);
    if (d.footer && typeof d.footer === 'object') delete d.footer.rawText;
    if (d.header && typeof d.header === 'object') delete d.header.rawText;
    if (Array.isArray(d.products)) {
        for (const p of d.products) {
            if (p && typeof p === 'object') delete p.rawLines;
        }
    }
    return d;
}
