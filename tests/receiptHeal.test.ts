import {
    healReceipt, isSameReceipt, assessQuality, isUnreadable, hasUsableName,
    type HealLine,
} from '../src/services/receiptHealService.js';

// Line factory — matched+clean by default; override to simulate garble.
const L = (name: string, price: number, o: Partial<HealLine> = {}): HealLine => ({
    name, price, quantity: o.quantity ?? 1,
    matched: o.matched ?? true, confirmed: o.confirmed ?? false,
    confidence: o.confidence ?? 0.9, implausible: o.implausible ?? false,
});
const names = (plan: ReturnType<typeof healReceipt>) => plan.lines.map(l => l.name);

describe('receiptHeal — sequence alignment (inserts recover what a scan missed)', () => {
    it('inserts a line the 1st scan missed in the MIDDLE, keeping later lines aligned', () => {
        const existing = [L('Milk', 1), L('Bread', 2), L('Cheese', 4)];
        const candidate = [L('Milk', 1), L('Bread', 2), L('Eggs', 3), L('Cheese', 4)];
        const plan = healReceipt(existing, candidate, 10);
        expect(names(plan)).toEqual(['Milk', 'Bread', 'Eggs', 'Cheese']);
        expect(plan.insertedCount).toBe(1);
        expect(plan.lines.find(l => l.name === 'Eggs')!.op).toBe('inserted');
        // Cheese stayed aligned to Cheese (not mis-shifted onto Eggs).
        expect(plan.lines.find(l => l.name === 'Cheese')!.op).toBe('kept');
    });

    it('inserts at the END', () => {
        const plan = healReceipt([L('Milk', 1), L('Bread', 2)], [L('Milk', 1), L('Bread', 2), L('Eggs', 3)], 6);
        expect(names(plan)).toEqual(['Milk', 'Bread', 'Eggs']);
        expect(plan.insertedCount).toBe(1);
    });

    it('inserts at the BEGINNING', () => {
        const plan = healReceipt([L('Milk', 1), L('Bread', 2)], [L('Eggs', 3), L('Milk', 1), L('Bread', 2)], 6);
        expect(names(plan)).toEqual(['Eggs', 'Milk', 'Bread']);
        expect(plan.insertedCount).toBe(1);
    });

    it('recovers MULTIPLE consecutive missed lines', () => {
        const existing = [L('Milk', 1), L('Cheese', 4)];
        const candidate = [L('Milk', 1), L('Bread', 2), L('Eggs', 3), L('Cheese', 4)];
        const plan = healReceipt(existing, candidate, 10);
        expect(names(plan)).toEqual(['Milk', 'Bread', 'Eggs', 'Cheese']);
        expect(plan.insertedCount).toBe(2);
    });

    it('KEEPS a line the retake itself missed (never subtracts)', () => {
        const existing = [L('Milk', 1), L('Bread', 2), L('Cheese', 3)];
        const candidate = [L('Milk', 1), L('Cheese', 3)]; // retake dropped Bread
        const plan = healReceipt(existing, candidate, 6);
        expect(names(plan)).toEqual(['Milk', 'Bread', 'Cheese']);
        expect(plan.lines.find(l => l.name === 'Bread')!.op).toBe('kept');
        expect(plan.insertedCount).toBe(0);
    });

    it('DROPS an insert the total does not support (no phantom lines)', () => {
        const existing = [L('Milk', 1), L('Bread', 2)]; // sum 3 == total
        const candidate = [L('Milk', 1), L('Bread', 2), L('Junk', 5)];
        const plan = healReceipt(existing, candidate, 3);
        expect(names(plan)).toEqual(['Milk', 'Bread']);
        expect(plan.insertedCount).toBe(0);
    });
});

describe('receiptHeal — best-of merge (never downgrade)', () => {
    it('heals a garbled+unmatched line to the clean+matched retake reading', () => {
        const existing = [L('x1', 1, { matched: false, confidence: 0.2 })]; // unusable name, unmatched
        const candidate = [L('Milk', 1, { matched: true, confidence: 0.9 })];
        const plan = healReceipt(existing, candidate, 1);
        expect(plan.lines[0].op).toBe('healed');
        expect(plan.lines[0].name).toBe('Milk');
        expect(plan.lines[0].takeCandidateMatch).toBe(true);
        expect(plan.healedCount).toBe(1);
    });

    it('never downgrades a CONFIRMED line, even if the retake reads it worse', () => {
        const existing = [L('Milk', 1, { confirmed: true })];
        const candidate = [L('x1', 1, { matched: false, confidence: 0.2 })];
        const plan = healReceipt(existing, candidate, 1);
        expect(plan.lines[0].op).toBe('kept');
        expect(plan.lines[0].name).toBe('Milk');
        expect(plan.lines[0].takeCandidateMatch).toBe(false);
    });

    it('keeps a good existing name over a garbled retake of the same line', () => {
        const existing = [L('Milk', 1, { matched: true, confidence: 0.85 })];
        const candidate = [L('M1lk', 1, { matched: false, confidence: 0.3 })];
        const plan = healReceipt(existing, candidate, 1);
        expect(plan.lines[0].name).toBe('Milk');
        expect(plan.lines[0].op).toBe('kept');
    });

    it('recovers a missing price from the retake when the stored one was implausible', () => {
        const existing = [L('Milk', 0, { matched: true, implausible: true })];
        const candidate = [L('Milk', 1.29, { matched: true })];
        const plan = healReceipt(existing, candidate, 1.29);
        expect(plan.lines[0].price).toBeCloseTo(1.29);
        expect(plan.lines[0].op).toBe('healed');
    });
});

describe('receiptHeal — same-receipt guard', () => {
    const base = { chainId: 1, receiptNo: 'ABC123', date: '2022-03-04', total: 18.27 };
    it('accepts the same receipt', () => {
        expect(isSameReceipt(base, { ...base, total: 18.30 })).toBe(true);
    });
    it('rejects a different receipt number', () => {
        expect(isSameReceipt(base, { ...base, receiptNo: 'XYZ999' })).toBe(false);
    });
    it('rejects a different chain', () => {
        expect(isSameReceipt({ ...base, receiptNo: null }, { ...base, receiptNo: null, chainId: 2 })).toBe(false);
    });
    it('rejects wildly different totals', () => {
        expect(isSameReceipt(base, { ...base, total: 40 })).toBe(false);
    });
    it('accepts on chain+day when receipt numbers are absent', () => {
        expect(isSameReceipt({ ...base, receiptNo: null }, { ...base, receiptNo: null })).toBe(true);
    });
});

describe('receiptHeal — quality assessment', () => {
    it('clean receipt is not low-quality', () => {
        expect(assessQuality([L('Milk', 1), L('Bread', 2)], 3).lowQuality).toBe(false);
    });
    it('mostly-unreadable lines trip it', () => {
        const q = assessQuality([L('x1', 0, { matched: false }), L('y2', 0, { matched: false }), L('Milk', 1)], null);
        expect(q.unreadableCount).toBe(2);
        expect(q.lowQuality).toBe(true);
    });
    it('a reconciliation gap trips it even with readable lines', () => {
        expect(assessQuality([L('Milk', 1), L('Bread', 2)], 10).lowQuality).toBe(true); // sum 3 vs 10
    });
    it('most-lines-unmatched trips it (garbled scan that still reconciles)', () => {
        // 3 readable-but-unmatched + 1 matched; sum == total, no unreadable lines.
        const q = assessQuality([
            L('Alpha', 1, { matched: false }), L('Beta', 2, { matched: false }),
            L('Gamma', 3, { matched: false }), L('Delta', 4, { matched: true }),
        ], 10);
        expect(q.unmatchedCount).toBe(3);
        expect(q.lowQuality).toBe(true); // 3/4 ≥ 0.6
    });
    it('a FEW unmatched (new products) on a clean scan does NOT trip', () => {
        const q = assessQuality([
            L('Apple', 1), L('Bread', 2), L('Cheese', 3), L('Newone', 4, { matched: false }), L('Newtwo', 5, { matched: false }),
        ], 15);
        expect(q.lowQuality).toBe(false); // 2/5 < 0.6, reconciles, readable
    });
    it('isUnreadable flags garble / no price / veto, not clean-unmatched', () => {
        expect(isUnreadable(L('Milk', 1, { matched: false }))).toBe(false); // clean but unmatched → fine
        expect(isUnreadable(L('x1', 1))).toBe(true);
        expect(isUnreadable(L('Milk', 0))).toBe(true);
        expect(isUnreadable(L('Milk', 1, { implausible: true }))).toBe(true);
        expect(hasUsableName('Milk')).toBe(true);
        expect(hasUsableName('x1')).toBe(false);
    });
});
