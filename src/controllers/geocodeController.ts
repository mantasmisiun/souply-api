import { Request, Response, NextFunction } from 'express';

/**
 * Nominatim (OpenStreetMap) geocoding proxy.
 *
 * We proxy through the backend for three reasons:
 *   1. Nominatim REQUIRES a descriptive User-Agent on every request — their
 *      usage policy threatens blocking otherwise. Phones can't reliably
 *      supply a consistent UA string across Expo/native builds, so we set
 *      it here.
 *   2. We can cache identical queries across users (different phones
 *      hitting the same address converge on one upstream call).
 *   3. We can rate-limit politely — Nominatim asks for ≤1 req/sec.
 *
 * In-memory LRU-ish cache. Good enough for thesis-scale traffic; if we
 * ever need persistence, swap in Redis. Cache entries never expire in the
 * current app's lifetime since addresses don't typically change geocodes.
 */

interface GeocodeResult {
    lat: number;
    lng: number;
    displayName: string;
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'SouplyApp/1.0 (thesis project, mantas.misiun@gmail.com)';
const TIMEOUT_MS = 5000;
const CACHE_MAX = 500;

const cache = new Map<string, GeocodeResult>();

function normalizeAddress(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cacheGet(key: string): GeocodeResult | null {
    const hit = cache.get(key);
    if (!hit) return null;
    // LRU touch: re-insert to bump recency
    cache.delete(key);
    cache.set(key, hit);
    return hit;
}

function cacheSet(key: string, value: GeocodeResult): void {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
}

export const geocodeAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
        if (!address || address.length < 3) {
            res.status(400).json({ error: 'address is required' });
            return;
        }

        const key = normalizeAddress(address);
        const cached = cacheGet(key);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }

        const url = new URL(NOMINATIM_URL);
        url.searchParams.set('q', address);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '1');
        // Bias toward Lithuania — the app's primary user base. Nominatim
        // still returns addresses elsewhere if Lithuania has no match.
        url.searchParams.set('countrycodes', 'lt');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        // Locally-aliased type: the global fetch Response clashes with the
        // express Response imported at the top of this file, so we type
        // the upstream result as unknown and narrow via duck-typing.
        let upstream: { ok: boolean; status: number; json: () => Promise<any> };
        try {
            upstream = (await fetch(url.toString(), {
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept-Language': 'lt,en',
                },
                signal: controller.signal,
            })) as any;
        } catch (e: any) {
            clearTimeout(timer);
            if (e?.name === 'AbortError') {
                res.status(504).json({ error: 'Geocoding timed out' });
                return;
            }
            throw e;
        }
        clearTimeout(timer);

        if (!upstream.ok) {
            res.status(502).json({ error: `Nominatim responded ${upstream.status}` });
            return;
        }
        const data: any[] = (await upstream.json()) as any[];
        if (!Array.isArray(data) || data.length === 0) {
            res.status(404).json({ error: 'Address not found' });
            return;
        }
        const result: GeocodeResult = {
            lat: Number(data[0].lat),
            lng: Number(data[0].lon),
            displayName: String(data[0].display_name ?? address),
        };
        if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) {
            res.status(502).json({ error: 'Geocoder returned malformed coordinates' });
            return;
        }
        cacheSet(key, result);
        res.json(result);
    } catch (error) {
        next(error);
    }
};
