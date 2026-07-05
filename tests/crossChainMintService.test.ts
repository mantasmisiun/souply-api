import { mintProvisionalSp, checkAndPromoteProvisionalSp } from '../src/services/crossChainMintService.js';

/** Scripted connection: answers queries by matching SQL fragments in order-independent
 *  fashion, records writes so assertions can inspect them. */
function makeConn(script: Record<string, any[] | ((params: any[]) => any[])>) {
    const calls: { sql: string; params: any[] }[] = [];
    return {
        _calls: calls,
        query: async (sql: string, params: any[] = []) => {
            calls.push({ sql, params });
            for (const [frag, rows] of Object.entries(script)) {
                if (sql.includes(frag)) {
                    const out = typeof rows === 'function' ? rows(params) : rows;
                    if (sql.trim().startsWith('INSERT')) return [{ insertId: 5555, ...(out?.[0] ?? {}) }];
                    return [out];
                }
            }
            if (sql.trim().startsWith('INSERT')) return [{ insertId: 5555 }];
            if (sql.trim().startsWith('UPDATE')) return [{ affectedRows: 1 }];
            return [[]];
        },
    };
}

const SRC_SP = {
    id: 900, productId: 42, chainId: 2, storeProductName: 'Lietuviški trumpavaisiai agurkai',
    brandName: null, amount: null, unit: null, isWeighable: 1, imageUrl: 'https://img/x.jpg',
};

describe('mintProvisionalSp', () => {
    it('mints a provisional SP copying the source identity onto the same Product', async () => {
        const conn = makeConn({
            'FROM StoreProduct WHERE id = ?': [SRC_SP],
            'provisional = 0': [],          // no real same-chain SP
            'mintedFromSpId = ?': [],       // no provisional twin
        });
        const r = await mintProvisionalSp(3, 900, 'user-1', conn);
        expect(r).toEqual({ storeProductId: 5555, reused: false, provisional: true });
        const ins = conn._calls.find(c => c.sql.includes('INSERT INTO StoreProduct'))!;
        // productId, chainId, name, brand, amount, unit, weighable, image, owner, source
        expect(ins.params[0]).toBe(42);
        expect(ins.params[1]).toBe(3);
        expect(ins.params[2]).toBe('Lietuviški trumpavaisiai agurkai');
        expect(ins.params[7]).toBe('https://img/x.jpg');
        expect(ins.params[8]).toBe('user-1');
        expect(ins.params[9]).toBe(900);
    });

    it('converges on an existing provisional twin (the second-user path) instead of minting', async () => {
        const conn = makeConn({
            'FROM StoreProduct WHERE id = ?': [SRC_SP],
            'provisional = 0': [],
            'mintedFromSpId = ?': [{ id: 777 }],
        });
        const r = await mintProvisionalSp(3, 900, 'user-2', conn);
        expect(r).toEqual({ storeProductId: 777, reused: true, provisional: true });
        expect(conn._calls.some(c => c.sql.includes('INSERT INTO StoreProduct'))).toBe(false);
    });

    it('reuses a REAL same-chain SP of the Product when one exists — no mint needed', async () => {
        const conn = makeConn({
            'FROM StoreProduct WHERE id = ?': [SRC_SP],
            'provisional = 0': [{ id: 321 }],
        });
        const r = await mintProvisionalSp(3, 900, 'user-1', conn);
        expect(r).toEqual({ storeProductId: 321, reused: true, provisional: false });
    });

    it('refuses when the "source" is actually same-chain', async () => {
        const conn = makeConn({ 'FROM StoreProduct WHERE id = ?': [{ ...SRC_SP, chainId: 3 }] });
        expect(await mintProvisionalSp(3, 900, 'u', conn)).toBeNull();
    });
});

describe('checkAndPromoteProvisionalSp — clustered K=2 with price corroboration', () => {
    const base = (confirms: any[], receiptItems: Record<number, any>) => makeConn({
        'SELECT provisional FROM StoreProduct': [{ provisional: 1 }],
        'StoreProductReceiptAliasVote': confirms,
        'FROM ReceiptItem': (params: any[]) => {
            const row = receiptItems[Number(params[0])];
            return row ? [row] : [];
        },
    });

    it('two users, near-identical prints (OCR noise), agreeing prices → PROMOTED', async () => {
        const conn = base([
            { normalizedAlias: 'trumpavaisiai agurkai', userId: 'u1', receiptId: 1 },
            { normalizedAlias: 'trumpavais1ai agurkai', userId: 'u2', receiptId: 2 },   // 1↔i confusion
        ], { 1: { price: 2.99, promoPrice: null }, 2: { price: 3.09, promoPrice: null } });
        expect(await checkAndPromoteProvisionalSp(5555, conn)).toBe(true);
        expect(conn._calls.some(c => c.sql.includes('SET provisional = 0'))).toBe(true);
    });

    it('two users but DIFFERENT prints (different products fuzzing the same SP) → NOT promoted', async () => {
        const conn = base([
            { normalizedAlias: 'agurkai trumpavaisiai', userId: 'u1', receiptId: 1 },
            { normalizedAlias: 'pomidorai slyviniai raudoni', userId: 'u2', receiptId: 2 },
        ], { 1: { price: 2.99, promoPrice: null }, 2: { price: 2.99, promoPrice: null } });
        expect(await checkAndPromoteProvisionalSp(5555, conn)).toBe(false);
    });

    it('same user twice never promotes', async () => {
        const conn = base([
            { normalizedAlias: 'trumpavaisiai agurkai', userId: 'u1', receiptId: 1 },
            { normalizedAlias: 'trumpavaisiai agurkai', userId: 'u1', receiptId: 3 },
        ], { 1: { price: 2.99, promoPrice: null }, 3: { price: 2.99, promoPrice: null } });
        expect(await checkAndPromoteProvisionalSp(5555, conn)).toBe(false);
    });

    it('prices DISAGREE (>1.3×) → two users are not enough; a third promotes', async () => {
        const items = {
            1: { price: 2.99, promoPrice: null },
            2: { price: 6.99, promoPrice: null },   // 2.3× apart
            3: { price: 3.05, promoPrice: null },
        };
        const two = base([
            { normalizedAlias: 'trumpavaisiai agurkai', userId: 'u1', receiptId: 1 },
            { normalizedAlias: 'trumpavaisiai agurkai', userId: 'u2', receiptId: 2 },
        ], items);
        expect(await checkAndPromoteProvisionalSp(5555, two)).toBe(false);

        const three = base([
            { normalizedAlias: 'trumpavaisiai agurkai', userId: 'u1', receiptId: 1 },
            { normalizedAlias: 'trumpavaisiai agurkai', userId: 'u2', receiptId: 2 },
            { normalizedAlias: 'trumpavaisiai agurka1', userId: 'u3', receiptId: 3 },
        ], items);
        expect(await checkAndPromoteProvisionalSp(5555, three)).toBe(true);
    });

    it('non-provisional SP is a no-op', async () => {
        const conn = makeConn({ 'SELECT provisional FROM StoreProduct': [{ provisional: 0 }] });
        expect(await checkAndPromoteProvisionalSp(123, conn)).toBe(false);
    });
});
