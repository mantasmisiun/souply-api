/** Small inner-layer retry for scraper HTTP calls: one quick re-attempt on a
 *  transient failure (network hiccup / 5xx), so a single blip doesn't burn a
 *  whole run attempt (the outer runScraperWithRetry layer waits 1h between
 *  attempts). Non-ok responses count as failures. */
export async function fetchWithRetry(url: string, init?: RequestInit, retries = 1): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, init);
            if (res.ok) return res;
            lastErr = new Error(`HTTP ${res.status} for ${url}`);
        } catch (e) {
            lastErr = e;
        }
        if (attempt < retries) await new Promise(r => setTimeout(r, 1500));
    }
    throw lastErr;
}

/** Prepend the brand to the display name unless it is already present
 *  (case-insensitive). Shared by Lidl (raw.brand) and Barbora (brand_name). */
export function joinBrand(brand: unknown, name: string): string {
    const b = typeof brand === 'string' ? brand.trim() : '';
    if (!b) return name;
    return name.toLowerCase().includes(b.toLowerCase()) ? name : `${b} ${name}`;
}
