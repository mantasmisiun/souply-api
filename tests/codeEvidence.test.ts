/**
 * Umbrella variant resolution via receipt code evidence (integration, test DB).
 * Fixture mirrors the real VALSOIA case: one umbrella SP holding 3 codes.
 */
import { jest } from '@jest/globals';
import pool from '../src/config/db.js';
import { recordCodeEvidence } from '../src/services/codeEvidenceService.js';

const CHAIN = 5;
const NEPRISKIRTA = 688;
let umbrellaProductId: number;
let umbrellaSpId: number;

beforeAll(async () => {
    await pool.query('INSERT IGNORE INTO StoreChain (id, name) VALUES (?, "Lidl")', [CHAIN]);
    const [p]: any = await pool.query(
        'INSERT INTO Product (categoryId, name) VALUES (?, ?)', [NEPRISKIRTA, 'CE-TEST Augalinis gėrimas']);
    umbrellaProductId = p.insertId;
    const [sp]: any = await pool.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName, amount, unit) VALUES (?, ?, ?, 1, "l")',
        [umbrellaProductId, CHAIN, 'CE-TEST Augalinis gėrimas']);
    umbrellaSpId = sp.insertId;
    await pool.query(
        'INSERT INTO StoreProductCode (chainId, code, storeProductId) VALUES (?, "9908825", ?), (?, "9908826", ?), (?, "9908827", ?)',
        [CHAIN, umbrellaSpId, CHAIN, umbrellaSpId, CHAIN, umbrellaSpId]);
});

afterAll(async () => {
    await pool.query('DELETE FROM StoreProductCodeEvidence WHERE chainId = ? AND code LIKE "99088%"', [CHAIN]);
    await pool.query('DELETE FROM StoreProductCode WHERE chainId = ? AND code LIKE "99088%"', [CHAIN]);
    await pool.query('DELETE FROM StoreProduct WHERE storeProductName LIKE "CE-TEST%"');
    await pool.query('DELETE FROM Product WHERE name LIKE "CE-TEST%"');
    await pool.end();
});

describe('recordCodeEvidence — umbrella resolution', () => {
    it('first sighting only records evidence (K=2 gate)', async () => {
        const r = await recordCodeEvidence(CHAIN, '9908825', 'CE-TEST Avižų gėrimas 1L');
        expect(r.action).toBe('recorded');
        const [ev]: any = await pool.query(
            'SELECT seenCount, resolvedSpId FROM StoreProductCodeEvidence WHERE chainId = ? AND code = "9908825"', [CHAIN]);
        expect(Number(ev[0].seenCount)).toBe(1);
        expect(ev[0].resolvedSpId).toBeNull();
        // code still on the umbrella
        const [map]: any = await pool.query(
            'SELECT storeProductId FROM StoreProductCode WHERE chainId = ? AND code = "9908825"', [CHAIN]);
        expect(Number(map[0].storeProductId)).toBe(umbrellaSpId);
    });

    it('second sighting promotes: dedicated SP minted, code re-pointed', async () => {
        const r = await recordCodeEvidence(CHAIN, '9908825', 'CE-TEST Avižų gėrimas 1L');
        expect(['promoted_minted', 'promoted_existing']).toContain(r.action);
        expect(r.spId).toBeDefined();
        expect(r.spId).not.toBe(umbrellaSpId);
        // code now maps to the dedicated SP
        const [map]: any = await pool.query(
            'SELECT storeProductId FROM StoreProductCode WHERE chainId = ? AND code = "9908825"', [CHAIN]);
        expect(Number(map[0].storeProductId)).toBe(r.spId);
        // dedicated SP carries the printed full name + parsed size
        const [sp]: any = await pool.query('SELECT storeProductName, amount, unit FROM StoreProduct WHERE id = ?', [r.spId]);
        expect(sp[0].storeProductName).toContain('Avižų');
        expect(Number(sp[0].amount)).toBe(1);
        expect(sp[0].unit).toBe('l');
        // evidence row stamped
        const [ev]: any = await pool.query(
            'SELECT resolvedSpId FROM StoreProductCodeEvidence WHERE chainId = ? AND code = "9908825"', [CHAIN]);
        expect(Number(ev[0].resolvedSpId)).toBe(r.spId);
    });

    it('remaining codes stay on the umbrella', async () => {
        const [maps]: any = await pool.query(
            'SELECT code FROM StoreProductCode WHERE chainId = ? AND storeProductId = ? ORDER BY code', [CHAIN, umbrellaSpId]);
        expect((maps as any[]).map(m => m.code)).toEqual(['9908826', '9908827']);
    });

    it('a resolved (single-code) SP is not split again', async () => {
        const r1 = await recordCodeEvidence(CHAIN, '9908825', 'CE-TEST Avižų gėrimas 1L');
        expect(r1.action).toBe('already_resolved');
    });

    it('zero-padded receipt codes normalize to the same mapping', async () => {
        const r = await recordCodeEvidence(CHAIN, '0009908826', 'CE-TEST Sojų gėrimas 1L');
        expect(r.action).toBe('recorded'); // sighting 1 of 2 for this code
        const [ev]: any = await pool.query(
            'SELECT code FROM StoreProductCodeEvidence WHERE chainId = ? AND normalizedName LIKE "%soju%"', [CHAIN]);
        expect(ev[0].code).toBe('9908826');
    });
});
