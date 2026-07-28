import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';

/**
 * Perf audit #1 — the receipts list must NOT ship the parsedData OCR blob.
 *
 *   - explicit column list (no `r.*`): parsedData absent, everything the three
 *     list consumers read still present
 *   - `receiptFooterDate` = JSON `$.footer.date` with the client's legacy
 *     `$.date` fallback; empty/whitespace, JSON-null and invalid JSON → null
 *   - keyset pagination: no params → legacy plain array (back-compat);
 *     `limit`/`cursor` → `{ receipts, nextCursor }` envelope, id-DESC walk
 *     with no gaps or overlaps
 */

const USER = 'rcptlist-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'rcptlist-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHAIN_ID = 9975;
const STORE_ID = 99751;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const BIG_DUMP = JSON.stringify({ words: Array.from({ length: 200 }, (_, i) => ({ t: `word${i}`, x: i, y: i * 2, w: 40, h: 12 })) });

let ids: number[] = [];         // inserted receipt ids, insertion order
let deletedId: number;

const insertReceipt = async (parsedData: string | null, extra: Record<string, any> = {}): Promise<number> => {
    const cols: Record<string, any> = {
        userId: USER, storeId: STORE_ID, filePath: 'slim.jpg', fileType: 'image/jpeg',
        processingStatus: 'completed', receiptDate: '2026-03-01 10:00:00', parsedData,
        ...extra,
    };
    const [r]: any = await pool.query(
        `INSERT INTO Receipt (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`,
        Object.values(cols));
    return r.insertId;
};

beforeAll(async () => {
    await primeTokens(USER, OTHER);
    await q('DELETE FROM Receipt WHERE userId IN (?,?)', [USER, OTHER]);
    for (const u of [USER, OTHER]) await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    await q('INSERT INTO StoreChain (id, name, logoUrl, miniLogoUrl) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [CHAIN_ID, 'Slim Chain', 'logo.png', 'mini.png']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [STORE_ID, CHAIN_ID, 'Slim Store', 'Slim St. 1']);

    ids = [];
    // 1: footer.date present + heavy wordsDump — the date must arrive WITHOUT the blob
    ids.push(await insertReceipt(JSON.stringify({ footer: { date: '2026-03-05' }, wordsDump: BIG_DUMP, products: [] })));
    // 2: legacy blob shape — top-level date only
    ids.push(await insertReceipt(JSON.stringify({ date: '2026-03-06', products: [] })));
    // 3: footer.date empty string → null (client treated '' as no date, no $.date fallthrough)
    ids.push(await insertReceipt(JSON.stringify({ footer: { date: '' }, products: [] })));
    // 4: footer.date JSON null → falls through to $.date (JS `??` semantics)
    ids.push(await insertReceipt(JSON.stringify({ footer: { date: null }, date: '2026-03-07', products: [] })));
    // 5: parsedData NULL → null. (Invalid JSON is untestable here: the schema
    // has a CHECK on Receipt.parsedData — the query's JSON_VALID guard only
    // protects legacy environments without that constraint.)
    ids.push(await insertReceipt(null));
    // soft-deleted → must not appear
    deletedId = await insertReceipt(JSON.stringify({ footer: { date: '2026-03-08' } }), { userDeletedAt: '2026-03-09 00:00:00' });
});

afterAll(async () => {
    await q('DELETE FROM Receipt WHERE userId IN (?,?)', [USER, OTHER]);
    await q('DELETE FROM Store WHERE id = ?', [STORE_ID]);
    await q('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
    await q('DELETE FROM User WHERE id IN (?,?)', [USER, OTHER]);
    await (pool as any).end();
});

const list = (query = '') => asUser(app, USER).get(`/api/users/${USER}/receipts${query}`);

describe('GET /users/:userId/receipts (slim rows + pagination)', () => {
    it('no params → legacy plain array, id DESC, soft-deleted excluded', async () => {
        const r = await list();
        expect(r.status).toBe(200);
        expect(Array.isArray(r.body)).toBe(true);
        expect(r.body.map((x: any) => x.id)).toEqual([...ids].reverse());
        expect(r.body.some((x: any) => x.id === deletedId)).toBe(false);
    });

    it('ships NO parsedData/OCR blob on any row', async () => {
        const r = await list();
        for (const row of r.body) {
            expect(row).not.toHaveProperty('parsedData');
            expect(JSON.stringify(row)).not.toContain('wordsDump');
        }
    });

    it('keeps every field the list consumers read (superset minus the blob)', async () => {
        const r = await list();
        const row = r.body.find((x: any) => x.id === ids[0]);
        for (const key of ['id', 'filePath', 'fileType', 'processingStatus', 'receiptDate',
            'receiptNo', 'chainName', 'chainLogoUrl', 'chainMiniLogoUrl', 'storeName',
            'storeAddress', 'mandatorySwipesRequired', 'mandatorySwipesCompleted',
            'shoppingListId', 'receiptFooterDate']) {
            expect(row).toHaveProperty(key);
        }
        expect(row.chainName).toBe('Slim Chain');
        expect(row.storeName).toBe('Slim Store');
        expect(row.storeAddress).toBe('Slim St. 1');
    });

    it('receiptFooterDate mirrors the client\'s old parsedData logic exactly', async () => {
        const r = await list();
        const byId = new Map(r.body.map((x: any) => [x.id, x]));
        expect((byId.get(ids[0]) as any).receiptFooterDate).toBe('2026-03-05'); // footer.date
        expect((byId.get(ids[1]) as any).receiptFooterDate).toBe('2026-03-06'); // legacy $.date
        expect((byId.get(ids[2]) as any).receiptFooterDate).toBeNull();         // '' → no date
        expect((byId.get(ids[3]) as any).receiptFooterDate).toBe('2026-03-07'); // JSON null → $.date
        expect((byId.get(ids[4]) as any).receiptFooterDate).toBeNull();         // NULL blob
    });

    it('limit/cursor → envelope; the walk covers all rows once, then nextCursor null', async () => {
        const seen: number[] = [];
        let cursor: string | null = null;
        for (let hop = 0; hop < 10; hop++) {
            const r = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            expect(r.status).toBe(200);
            expect(Array.isArray(r.body.receipts)).toBe(true);
            expect(r.body.receipts.length).toBeLessThanOrEqual(2);
            seen.push(...r.body.receipts.map((x: any) => x.id));
            cursor = r.body.nextCursor;
            if (cursor == null) break;
        }
        expect(cursor).toBeNull();
        expect(seen).toEqual([...ids].reverse()); // complete, ordered, no dupes
    });

    it('a malformed cursor falls back to the first page instead of erroring', async () => {
        const r = await list('?limit=3&cursor=zzzz-not-a-cursor');
        expect(r.status).toBe(200);
        expect(r.body.receipts.map((x: any) => x.id)).toEqual([...ids].reverse().slice(0, 3));
    });

    it('remains self-scoped', async () => {
        const r = await asUser(app, OTHER).get(`/api/users/${USER}/receipts`);
        expect([403, 404]).toContain(r.status);
    });
});
