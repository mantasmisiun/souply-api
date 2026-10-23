import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { stemToken, foldLithuanian, normalizeForSearch } from '../src/utils/searchStem.js';

/**
 * Souply 2.0 three-arm search: full-token name match (rank 0) → stemmed name
 * match (rank 1) → vocabulary (receipt aliases + translations/synonyms, rank 2).
 * The user cases that motivated it: "saldi bulve" → "Saldžiosios bulvės" +
 * batatai synonym; "sojos padazas" / "soy sauce" → "Sojų padažas".
 */

const CAT_ID = 9963;
const CHAIN_ID = 9963;
let productSoy: number;
let productBatat: number;
let spSoy: number;
let spBatat: number;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    await q('INSERT INTO Category (id, name, parentCategoryId) VALUES (?,?,NULL) ON DUPLICATE KEY UPDATE name=VALUES(name)', [CAT_ID, 'SearchVocab Cat']);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'SearchVocab Chain']);

    const p1: any = await q('INSERT INTO Product (categoryId, name, globalScore) VALUES (?,?,1)', [CAT_ID, 'Sojų padažas KIKKOMAN']);
    productSoy = p1.insertId;
    const p2: any = await q('INSERT INTO Product (categoryId, name, globalScore) VALUES (?,?,1)', [CAT_ID, 'Saldžiosios bulvės']);
    productBatat = p2.insertId;

    const s1: any = await q('INSERT INTO StoreProduct (chainId, productId, storeProductName) VALUES (?,?,?)', [CHAIN_ID, productSoy, 'Sojų padažas KIKKOMAN 250ml']);
    spSoy = s1.insertId;
    const s2: any = await q('INSERT INTO StoreProduct (chainId, productId, storeProductName) VALUES (?,?,?)', [CHAIN_ID, productBatat, 'Saldžiosios bulvės, 1kg']);
    spBatat = s2.insertId;

    // Vocabulary rows: EN translation + LT synonym (what the import writes).
    await q('INSERT IGNORE INTO StoreProductTranslation (storeProductId, lang, text, normalized) VALUES (?,?,?,?)',
        [spSoy, 'en', 'Soy sauce', normalizeForSearch('Soy sauce')]);
    await q('INSERT IGNORE INTO StoreProductTranslation (storeProductId, lang, text, normalized) VALUES (?,?,?,?)',
        [spBatat, 'lt', 'Batatai', normalizeForSearch('Batatai')]);
});

afterAll(async () => {
    await q('DELETE FROM StoreProductTranslation WHERE storeProductId IN (?,?)', [spSoy, spBatat]);
    await q('DELETE FROM StoreProduct WHERE id IN (?,?)', [spSoy, spBatat]);
    await q('DELETE FROM Product WHERE id IN (?,?)', [productSoy, productBatat]);
    await q('DELETE FROM Category WHERE id = ?', [CAT_ID]);
    await (pool as any).end();
});

const search = async (query: string) =>
    (await request(app).get(`/api/products/search?q=${encodeURIComponent(query)}`)).body as any[];

describe('stemmer', () => {
    it('folds diacritics and strips one inflectional ending', () => {
        expect(foldLithuanian('Sojų')).toBe('soju');
        expect(stemToken('sojos')).toBe('soj');
        expect(stemToken('sojų')).toBe('soj');
        expect(stemToken('saldi')).toBe('sald');
        expect(stemToken('bulvės')).toBe('bulv');
        expect(stemToken('padažas')).toBe('padaz');
        // short tokens survive untouched
        expect(stemToken('po')).toBe('po');
    });
});

describe('three-arm search', () => {
    it('inflected query finds the product via the stem arm: "sojos padazas"', async () => {
        const results = await search('sojos padazas');
        expect(results.map((r) => r.id)).toContain(productSoy);
    });

    it('adjective inflection: "saldi bulve" → Saldžiosios bulvės', async () => {
        const results = await search('saldi bulve');
        expect(results.map((r) => r.id)).toContain(productBatat);
    });

    it('English translation arm: "soy sauce" → Sojų padažas', async () => {
        const results = await search('soy sauce');
        expect(results.map((r) => r.id)).toContain(productSoy);
    });

    it('Lithuanian synonym arm: "batatai" → Saldžiosios bulvės', async () => {
        const results = await search('batatai');
        expect(results.map((r) => r.id)).toContain(productBatat);
    });

    it('SP-name arm: token only present in the store product name', async () => {
        // "250ml" exists only on the SP ("Sojų padažas KIKKOMAN 250ml"),
        // not the product name — arm 3 must catch it.
        const results = await search('kikkoman 250ml');
        expect(results.map((r) => r.id)).toContain(productSoy);
    });

    it('exact name matches rank above vocabulary-only matches', async () => {
        const results = await search('sojų padažas');
        const ids = results.map((r) => r.id);
        expect(ids[0]).toBe(productSoy); // direct name hit leads
    });
});
