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

/**
 * Strip the redundant per-receipt raw OCR TEXT from a receipt's parsedData before it is
 * stored. Since the ReceiptItem migration each product line's raw text lives in
 * ReceiptItem.rawLines, and the header/footer `rawText` fields duplicate the WHOLE receipt
 * (store + every product + totals + card/loyalty PII — on the IKI thermal path both fields
 * hold the entire receipt). The structured header/footer fields (storeAddress, total,
 * receiptNo…) and the wordsDump geometry are kept, so nothing product-related remains in the
 * Receipt blob — it lives per-item in ReceiptItem. Returns a shallow copy with fresh
 * header/footer objects; the input is not mutated (the caller still needs products[] intact
 * for the ReceiptItem dual-write). Unlike stripReceiptPII this is applied on EVERY save, not
 * only at account deletion.
 */
export function stripProductRawText<T extends Record<string, any>>(parsedData: T): T {
    if (!parsedData || typeof parsedData !== 'object') return parsedData;
    const out: any = { ...parsedData };
    if (out.header && typeof out.header === 'object') {
        const { rawText, ...rest } = out.header;
        out.header = rest;
    }
    if (out.footer && typeof out.footer === 'object') {
        const { rawText, ...rest } = out.footer;
        out.footer = rest;
    }
    return out;
}
