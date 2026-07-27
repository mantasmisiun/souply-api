import pool from '../src/config/db.js';
import { parseIngredientLine } from '../src/services/recipes/ingredientParser.js';
import { matchIngredient, shoppingAmount } from '../src/services/recipes/recipeMatcher.js';
import type { Lang } from '../src/services/recipes/types.js';

/**
 * RECIPE → CATALOG, against a real catalog.
 *
 * Every rule pinned here was learned from a sweep over 63 real recipes, and each
 * one existed as a wrong shopping list first. The products below are the actual
 * shapes that caused the trouble: a branded plain product, a variant that scores
 * better than the plain one, a "X su Y" product that merely CONTAINS the
 * ingredient, and a piece of kitchenware named after food.
 */

const CAT = 990220;
const CHAIN = 990221;
const STORE = 990222;
/** The REAL seed-packet category id, because the matcher excludes it by id:
 *  seed packets are named exactly like the vegetable ("Bulvės SOLTASTIC H"),
 *  and only the category can tell them apart from food. */
const SEED_CAT = 656;
/** The two REAL shelves that separate a living herb from a jar of dried leaves —
 *  the names on them are identical, so only the category tells them apart. */
const FRESH_HERB_CAT = 9;
const DRIED_SPICE_CAT = 245;
/** The REAL produce-axis shelves (verified against the dev tree 2026-07-27):
 *  fresh tomatoes, the frozen-berry shelf that counts as fresh-side for the
 *  wrong-shelf rule, and the dried-berry shelf it demotes. */
const FRESH_TOMATO_CAT = 3;
const FROZEN_BERRY_CAT = 309;
const DRIED_BERRY_CAT = 667;
const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

/** A catalog product: a Product, a StoreProduct with a size, and a scraped
 *  (receiptId IS NULL) Price — which is what makes it `isCatalog`. */
const addProduct = async (
    name: string,
    opts: { amount?: number | null; unit?: string | null; weighable?: boolean; categoryId?: number } = {},
): Promise<number> => {
    const p = await q(`INSERT INTO Product (categoryId, name) VALUES (?, ?)`, [opts.categoryId ?? CAT, name]);
    const productId = Number(p.insertId);
    const sp = await q(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, amount, unit, isWeighable)
         VALUES (?,?,?,?,?,?)`,
        [productId, CHAIN, name, opts.amount ?? null, opts.unit ?? null, opts.weighable ? 1 : 0],
    );
    await q(
        `INSERT INTO Price (storeProductId, storeId, price, date) VALUES (?,?,?,CURDATE())`,
        [Number(sp.insertId), STORE, 1.99],
    );
    return productId;
};

const ids: Record<string, number> = {};

const match = async (line: string, lang: Lang = 'lt') => {
    const parsed = parseIngredientLine(line, lang)[0];
    return matchIngredient(parsed, lang);
};

beforeAll(async () => {
    await q(`INSERT INTO Category (id, name) VALUES (?, 'RecipeMatchCat')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Daržovių sėklos')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [SEED_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Prieskoninės daržovės ir žolelės')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [FRESH_HERB_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Grynieji prieskoniai ir žolelės')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [DRIED_SPICE_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Pomidorai ir agurkai')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [FRESH_TOMATO_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Šaldytos uogos ir vaisiai')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [FROZEN_BERRY_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Džiovintos uogos')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [DRIED_BERRY_CAT]);
    await q(`INSERT INTO StoreChain (id, name) VALUES (?, 'RecipeMatchChain')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [CHAIN]);
    await q(`INSERT INTO Store (id, chainId, name, address) VALUES (?,?,'RM Store','X 1')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [STORE, CHAIN]);

    // Plain sugar, branded — and the variants that outscore it on name similarity.
    ids.sugar = await addProduct('Cukrus EXTRA LINE', { amount: 1, unit: 'kg' });
    ids.vanillaSugar = await addProduct('Vanilinis cukrus', { amount: 8, unit: 'g' });
    // A product that CONTAINS sugar but is not sugar.
    ids.doughnut = await addProduct('Varškės spurga su cukrumi', { amount: 90, unit: 'g' });
    // Brand-first naming, the common Lithuanian dairy shape.
    ids.butter = await addProduct('ROKIŠKIO sviestas, 82 % rieb.', { amount: 200, unit: 'g' });
    // Sold loose by weight.
    ids.garlic = await addProduct('Česnakai', { amount: 1, unit: 'kg', weighable: true });
    // Kitchenware wearing an ingredient's name.
    ids.sifter = await addProduct('Cukraus pudros sijotuvas VIVE');
    // A packaged liquid, for the "how many packs" arithmetic.
    ids.milk = await addProduct('UAT pienas MŪ, 3,5 % rieb.', { amount: 1, unit: 'l' });

    // A variant that ALSO leads with the noun — only the score may separate it
    // from the plain milk, never a mis-read head token.
    ids.lactoseFreeMilk = await addProduct('Pienas be laktozės A2, >3,5 % rieb.', { amount: 1, unit: 'l' });
    // "X skonio Y" — the product is Y wearing X's flavour, and it reaches the
    // candidate pool only through the recipe's own genitive phrase.
    ids.butterOil = await addProduct('Sviesto skonio OBELIŲ rapsų aliejus', { amount: 500, unit: 'ml' });
    // A genitive-modifier product: "Druskos dribsniai" is a product OF salt.
    ids.saltFlakes = await addProduct('Druskos dribsniai ICA', { amount: 250, unit: 'g' });
    ids.salt = await addProduct('Rožinė druska malūnėlyje', { amount: 90, unit: 'g' });
    // Real produce vs the seed packet with the same head noun.
    ids.potatoes = await addProduct('Lietuviškos didelės bulvės', { amount: 1, unit: 'kg', weighable: true });
    ids.seedPotatoes = await addProduct('Bulvės SOLTASTIC H', { categoryId: SEED_CAT });
    // A vegetable whose ONLY namesakes are seed packets.
    ids.seedCourgette = await addProduct('Cukinijos Di Nizza', { categoryId: SEED_CAT });
    // Exists ONLY because the recipe-phrase arm adds a real word ("šaldytų").
    ids.frozenBerryMix = await addProduct('Šaldytas uogų mišinys BILLA', { amount: 400, unit: 'g' });
    ids.blackPepper = await addProduct('Juodieji pipirai SAUDA', { amount: 50, unit: 'g' });
    ids.oliveOil = await addProduct('Alyvuogių aliejus BASSO', { amount: 500, unit: 'ml' });
    ids.carrots = await addProduct('Plautos morkos', { amount: 1, unit: 'kg', weighable: true });
    // The deli shape: contains every query word, IS none of them — and the
    // product the head-noun fallback should surface next to it.
    ids.starchDessert = await addProduct('Virtas bulvių krakmolo desertas, a. r.', { amount: 200, unit: 'g' });
    ids.tapiocaStarch = await addProduct('Tapijokos krakmolas AJI', { amount: 400, unit: 'g' });
    // The universal wrong answer for any "X milteliai".
    ids.cocoa = await addProduct('Kakavos milteliai MOČIUTĖS', { amount: 100, unit: 'g' });

    // --- THE SECOND HOLDOUT ROUND: seven products a recipe was given silently.
    // Sweet and hot peppers share a word on the shelf; heat must be ASKED for.
    ids.sweetPepper = await addProduct('Raud. saldžiosios paprikos (80+)', { amount: 1, unit: 'kg', weighable: true });
    ids.hotPepper = await addProduct('Aitriosios paprikos PADRON', { amount: 200, unit: 'g' });
    // ...and the deli item that won the sweet query once the chillies stopped.
    ids.stuffedPepper = await addProduct('Saldžiosios paprikos įd.sūriu', { amount: 200, unit: 'g' });
    // A whole composed DISH named after its main ingredient.
    // The real shelf shape: a plain herring that OPENS with the noun. (The
    // salted "Silpnai sūdyta silkė" opens with the adjective AND advertises a
    // preparation, so it is correctly not the plain answer.)
    ids.herring = await addProduct('Silkė be aliejaus ZIGMAS', { amount: 250, unit: 'g' });
    ids.herringSalad = await addProduct('Silkė pataluose', { amount: 400, unit: 'g' });
    // Frozen mix vs frozen breaded patties.
    ids.frozenVegMix = await addProduct('Šaldytas daržovių mišinys HORTEX', { amount: 400, unit: 'g' });
    ids.frozenVegPatties = await addProduct('Šaldyti daržovių kepsniai APETIT', { amount: 300, unit: 'g' });
    // Raw seeds vs a punnet of living sprouts.
    ids.sunflowerSeeds = await addProduct('Baltos saulėgrąžos YES', { amount: 200, unit: 'g' });
    ids.sproutedSeeds = await addProduct('Daigintos saulėgrąžos', { amount: 100, unit: 'g' });
    // The fresh root vs the spice jar: bare "ginger" is the jar, a CHUNK is not.
    ids.freshGinger = await addProduct('Imbieras', { amount: 1, unit: 'kg', weighable: true });
    ids.groundGinger = await addProduct('Malti imbierai SAUDA', { amount: 30, unit: 'g' });
    // Tied with plain salt at the same score, one coin-flip from seasoning a
    // recipe with garlic.
    ids.garlicSalt = await addProduct('Česnakinė druska SANTA MARIA', { amount: 90, unit: 'g' });
    // Same word, two shelves.
    // Sold by the piece for real — the counting rule must survive the bunch rule.
    ids.eggs = await addProduct('Kiaušiniai RIDO, M dydžio', { amount: 10, unit: 'vnt' });
    // --- HOLDOUT 2: "Y su X" is Y WITH something, a different product.
    ids.buckwheat = await addProduct('Grikiai BIORINA', { amount: 400, unit: 'g' });
    ids.buckwheatMeal = await addProduct('Grikiai su mėsa', { amount: 240, unit: 'g' });
    ids.prawns = await addProduct('Atit. krevetės RIMI, ASC', { amount: 200, unit: 'g' });
    ids.prawnSnack = await addProduct('Krevetės džiūvėsėliuose su padažu ASC', { amount: 225, unit: 'g' });
    // Uncategorised AND unsized — how a BOOK reached a recipe. Category 688 is
    // deliberately reachable (most fresh produce lives there), so the guard is
    // the missing size, not the category.
    ids.fishBook = await addProduct('Knyga ŽUVIS VANDENYJE', { categoryId: 688 });
    // --- MEAT: a tin outscores a fresh cut on name alone, every time.
    ids.beefTin = await addProduct('Troškinta jautiena SGK', { amount: 240, unit: 'g' });
    ids.beefFresh = await addProduct('Šviežia smulkinta jautiena, riebumas ne didesnis kaip 10 %',
        { amount: 500, unit: 'g' });
    ids.beefBlend = await addProduct('Liet. smulk. kiauliena ir jautiena, rieb. ne did. kaip 20 %',
        { amount: 500, unit: 'g' });
    ids.fishFillet = await addProduct('Aliaskinės žuvies filė', { amount: 400, unit: 'g', categoryId: 688 });
    ids.freshBasil = await addProduct('Bazilikai WELL DONE', { categoryId: FRESH_HERB_CAT });
    ids.driedBasil = await addProduct('Bazilikai SALDVA', { amount: 10, unit: 'g', categoryId: DRIED_SPICE_CAT });

    // --- THE THIRD VALIDATION ROUND: 19 silent errors over 60 recipes, the
    // three biggest classes reproduced below with the real offending shapes.
    // Fresh produce vs the processed jar that outscores it on name. The
    // marinated jar sits in 688 'Nepriskirta' — NO category to demote it by —
    // which is why the "Mar." abbreviation has to be a PREPARED marker.
    ids.freshCherryToms = await addProduct('Vyšniniai pomidorai ZEBRINO', {
        amount: 250, unit: 'g', categoryId: FRESH_TOMATO_CAT });
    ids.marinatedCherryToms = await addProduct('Mar. vyšniniai pomidorai RIMI, 690 g', {
        amount: 690, unit: 'g', categoryId: 688 });
    // Berries: the frozen bag is the fresh-side answer, the sweetened dried
    // ones (667 'Džiovintos uogos') and the chocolate-coated ones are not.
    ids.frozenCranberries = await addProduct('Šaldytos spanguolės WELL DONE', {
        amount: 400, unit: 'g', categoryId: FROZEN_BERRY_CAT });
    ids.driedCranberries = await addProduct('Dž. spanguolės NATURFOOD', {
        amount: 150, unit: 'g', categoryId: DRIED_BERRY_CAT });
    ids.frozenBlueberries = await addProduct('Šaldytos mėlynės BERIBU', {
        amount: 400, unit: 'g', categoryId: FROZEN_BERRY_CAT });
    ids.chocBlueberries = await addProduct('Mėlynės šokolade LAIMA', { amount: 90, unit: 'g' });
    // A generic category word's favourite wrong answers.
    ids.currySpice = await addProduct('Prieskoniai CURRY KOTANYI', { amount: 50, unit: 'g' });
    ids.meatSkewers = await addProduct('Mėsos iešmeliai su marinatu', { amount: 500, unit: 'g' });
    // The ground-spice jar a counted "1 vienetas paprika" must NOT buy.
    ids.groundPaprika = await addProduct('Malta saldžioji paprika ALVO', { amount: 100, unit: 'g' });
}, 60_000);   // ~40 products × (Product + StoreProduct + Price) — well past Jest's 5 s default

afterAll(async () => {
    const productIds = Object.values(ids);
    if (productIds.length > 0) {
        await q(`DELETE p FROM Price p JOIN StoreProduct sp ON sp.id = p.storeProductId
                 WHERE sp.productId IN (?)`, [productIds]);
        await q(`DELETE FROM StoreProduct WHERE productId IN (?)`, [productIds]);
        await q(`DELETE FROM Product WHERE id IN (?)`, [productIds]);
    }
    await q(`DELETE FROM Store WHERE id = ?`, [STORE]);
    await q(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN]);
    await q(`DELETE FROM Category WHERE id = ?`, [CAT]);
    await q(`DELETE FROM Category WHERE id = ?`, [SEED_CAT]);
    await q(`DELETE FROM Category WHERE id IN (?)`,
        [[FRESH_HERB_CAT, DRIED_SPICE_CAT, FRESH_TOMATO_CAT, FROZEN_BERRY_CAT, DRIED_BERRY_CAT]]);
    await (pool as any).end();
}, 60_000);

describe('picking the product a recipe meant', () => {
    /**
     * The plain product is BRANDED, so it scores worse than a variant whose name
     * is shorter — "Cukrus EXTRA LINE" 0.78 against "Vanilinis cukrus" 0.97. In
     * Lithuanian the head noun leads and the brand follows, so leading with the
     * query is the signal that separates them.
     */
    it('prefers plain sugar over vanilla sugar', async () => {
        const m = await match('200 gramų cukraus');
        expect(m.product?.productId).toBe(ids.sugar);
    });

    /**
     * "X su Y" lists what a product CONTAINS. A doughnut with sugar contains
     * sugar; it is not sugar, and it must never be auto-accepted as sugar.
     */
    it('never auto-accepts a product that merely contains the ingredient', async () => {
        const m = await match('125 gramų cukraus pudros');
        if (m.product?.productId === ids.doughnut) expect(m.confident).toBe(false);
        expect(m.product?.productId).not.toBe(ids.sifter);
    });

    /** Kitchenware is not an ingredient, whatever it is named after. */
    it('never offers kitchenware', async () => {
        const m = await match('125 gramų cukraus pudros');
        const everything = [m.product, ...m.alternatives].filter(Boolean);
        expect(everything.map(p => p!.productId)).not.toContain(ids.sifter);
    });

    /**
     * Brand-first names cost points the product does not deserve to lose: the
     * whole query survives inside the name, so this is the right butter even at
     * 0.78, and asking the shopper about it would be noise.
     */
    it('accepts a brand-led product whose name still contains the whole query', async () => {
        const m = await match('100 gramų sviesto');
        expect(m.product?.productId).toBe(ids.butter);
        expect(m.confident).toBe(true);
    });

    /**
     * The weighable flag in the ingredient table says how shops USUALLY sell a
     * thing. The matcher treats that flag as a hard form gate, and passing it
     * rejected every avocado in the catalog — so the catalog decides, and the hint
     * is only used afterwards to choose kilograms or units.
     */
    it('finds a weighable product for an ingredient, and shops it in kilograms', async () => {
        const m = await match('4 skiltelės česnako');
        expect(m.product?.productId).toBe(ids.garlic);
        expect(m.shopUnit).toBe('kg');
        expect(m.shopQuantity).toBeGreaterThan(0);
    });

    it('translates an English ingredient into a Lithuanian product', async () => {
        const m = await match('2 tbsp butter', 'en');
        expect(m.product?.productId).toBe(ids.butter);
    });

    /** Tap water is recognised and measured, and never shopped. */
    it('refuses to shop for tap water', async () => {
        const m = await match('200 mililitrų vandens');
        expect(m.product).toBeNull();
        expect(m.measure.qty).toBe(200);
        expect(m.pantry).toBe(true);
    });

    it('reports why a match needs review', async () => {
        const m = await match('125 gramų cukraus pudros');
        if (!m.confident && m.product) {
            expect(['low_score', 'dropped_word', 'generic_fallback']).toContain(m.reviewReason);
        }
    });
});

/**
 * The 2026-07 diagnosis: five ways a WRONG product went into a basket silently.
 * Each test below is a real failure shape reproduced with seeded products —
 * butter-flavoured oil sold as butter, salt flakes sold as salt, a seed packet
 * sold as potatoes, a deli product sold as fresh meat, cocoa sold as onion
 * powder. Wrong-and-silent is the failure class; review or null is the fix.
 */
describe('a wrong product must never be added silently', () => {
    /**
     * The recipe's genitive ("sviesto") is exactly the form a catalog name uses
     * when the noun MODIFIES another product, so the recipe-phrase query arm
     * found "Sviesto skonio … aliejus" and its exact-token score beat every
     * real butter. The arm now runs only when the phrase ADDS a content word.
     */
    it('buys butter, not butter-flavoured oil', async () => {
        const m = await match('100 gramų sviesto');
        expect(m.product?.productId).toBe(ids.butter);
        expect(m.confident).toBe(true);
        expect([m.product, ...m.alternatives].map(p => p!.productId)).not.toContain(ids.butterOil);
    });

    it('buys salt, not salt flakes', async () => {
        const m = await match('1 šaukštelis druskos');
        expect(m.product?.productId).toBe(ids.salt);
        expect(m.confident).toBe(true);
        expect([m.product, ...m.alternatives].map(p => p!.productId)).not.toContain(ids.saltFlakes);
    });

    /**
     * The other side of the arm gate: "šaldytų" IS a new content word over
     * "Uogos", so the phrase still earns its own query — deleting the arm
     * outright loses the frozen mix (scored [] against the bare canonical).
     */
    it('still lets the recipe phrase find what the canonical name cannot', async () => {
        const m = await match('200 g šaldytų uogų');
        expect(m.product?.productId).toBe(ids.frozenBerryMix);
        expect(m.confident).toBe(true);
    });

    /**
     * Seed packets (category 656) are named exactly like the vegetable and
     * head-noun-first, so they beat real produce on score AND the lead rule.
     * Excluded by CATEGORY id — a `sėkl` name regex would also kill real foods
     * like "Skrudintos sezamų sėklos".
     */
    it('never offers a seed packet for a vegetable', async () => {
        const m = await match('bulvių');
        expect(m.product?.productId).toBe(ids.potatoes);
        expect([m.product, ...m.alternatives].map(p => p!.productId)).not.toContain(ids.seedPotatoes);
    });

    /** When every namesake is a seed packet, null is the honest answer. */
    it('returns nothing when only seed packets carry the name', async () => {
        const m = await match('cukinijų');
        expect(m.product).toBeNull();
        expect(m.confident).toBe(false);
        expect([...m.alternatives].map(p => p.productId)).not.toContain(ids.seedCourgette);
    });

    /**
     * English recipes had NO dropped-word guard at all (the check bailed on
     * lang !== 'lt'), which is how "red pepper" became black pepper. The lookup
     * now reports the window it matched, and an identity-changing word outside
     * that window goes to review in both languages.
     */
    it('flags an identity qualifier the lookup dropped (EN)', async () => {
        const m = await match('2 purple carrots', 'en');
        expect(m.product?.productId).toBe(ids.carrots);
        expect(m.confident).toBe(false);
        expect(m.reviewReason).toBe('dropped_word');
    });

    it('never confidently sells black pepper for a red pepper', async () => {
        const m = await match('1 red pepper', 'en');
        if (m.product?.productId === ids.blackPepper) expect(m.confident).toBe(false);
    });

    /** Marketing grades are not identity — flagging them re-drowns the review
     *  pile in correct matches and trains the shopper to tap through. */
    it('keeps a dropped marketing grade off the review pile', async () => {
        const m = await match('2 tbsp extra-virgin olive oil', 'en');
        expect(m.product?.productId).toBe(ids.oliveOil);
        expect(m.confident).toBe(true);
    });

    /**
     * The head-noun fallback used to fire only on ZERO rows, so a single
     * survivor that merely CONTAINS the query — a cooked dessert of potato
     * starch, a deli kumpelis of chicken thigh meat — was auto-accepted as the
     * thing itself. A lone survivor that does not carry the query as its own
     * head now widens the net and everything goes to review.
     */
    it('does not trust a lone survivor that merely contains the query', async () => {
        const m = await match('2 šaukštai bulvių krakmolo');
        expect(m.confident).toBe(false);
        // The dessert must still be VISIBLE (review can pick it), just not silent.
        expect([m.product, ...m.alternatives].filter(Boolean).length).toBeGreaterThan(0);
    });

    /**
     * Below the accept bar the matcher used to return its best guess anyway —
     * "Kakavos milteliai" was the universal answer for any "X milteliai". A
     * guess that cannot clear the bar is offered as alternatives, never
     * pre-filled into the basket.
     */
    it('returns null with alternatives instead of a below-bar best guess', async () => {
        const m = await match('1 tsp onion powder', 'en');
        expect(m.product).toBeNull();
        expect(m.confident).toBe(false);
    });

    /** "UAT pienas MŪ" opens with a process abbreviation, not a noun — the
     *  lead tie-break must still see "pienas" as its head, or lactose-free
     *  milk (which also leads with "Pienas") steals the bare-noun band. */
    it('prefers plain milk over a variant when both lead with the noun', async () => {
        const m = await match('200 mililitrų pieno');
        expect(m.product?.productId).toBe(ids.milk);
        expect(m.confident).toBe(true);
    });
});

describe('shoppingAmount', () => {
    const pick = (over: Partial<Parameters<typeof shoppingAmount>[1]> = {}) => ({
        productId: 1, name: 'X', imageUrl: null, isWeighable: false,
        packAmount: null, packUnit: null, confidence: 1, ...over,
    });

    /** Five peppercorns are not five jars of pepper. */
    it('buys exactly one of a pantry staple', () => {
        const r = shoppingAmount({ qty: 5, unit: 'pcs', approx: false }, pick(),
            { key: 'pepper', ltName: 'P', enName: 'p', lt: [], en: [], pantry: true });
        expect(r).toEqual({ quantity: 1, unit: 'vnt' });
    });

    /** 2.5 ml of ground ginger was ordering a kilo of ginger root. */
    it('keeps a weighed pantry staple to a sane weight', () => {
        const r = shoppingAmount({ qty: 3, unit: 'g', approx: true }, pick({ isWeighable: true }),
            { key: 'ginger', ltName: 'I', enName: 'i', lt: [], en: [], pantry: true });
        expect(r.unit).toBe('kg');
        expect(r.quantity).toBeLessThanOrEqual(0.5);
    });

    it('divides what the recipe needs by the package the shop sells', () => {
        const r = shoppingAmount({ qty: 1500, unit: 'ml', approx: false },
            pick({ packAmount: 1, packUnit: 'l' }), null);
        expect(r).toEqual({ quantity: 2, unit: 'vnt' });   // 1.5 l needs two cartons
    });

    /**
     * A 120 ml handful of parsley divided by a 25 g bunch is not five bunches —
     * it is a unit error, and it shipped one.
     */
    it('refuses to divide a volume by a mass', () => {
        const r = shoppingAmount({ qty: 120, unit: 'ml', approx: true },
            pick({ packAmount: 25, packUnit: 'g' }), null);
        expect(r).toEqual({ quantity: 1, unit: 'vnt' });
    });

    it('weighs a weighable product, with a floor and a ceiling', () => {
        expect(shoppingAmount({ qty: 450, unit: 'g', approx: false }, pick({ isWeighable: true }), null))
            .toEqual({ quantity: 0.45, unit: 'kg' });
        // 12 g of parsley: no counter weighs that out.
        expect(shoppingAmount({ qty: 12, unit: 'g', approx: true }, pick({ isWeighable: true }), null).quantity)
            .toBe(0.1);
        expect(shoppingAmount({ qty: 90000, unit: 'g', approx: false }, pick({ isWeighable: true }), null).quantity)
            .toBe(5);
    });

    it('counts pieces only for things sold by the piece', () => {
        const info = { key: 'onion', ltName: 'S', enName: 's', lt: [], en: [], pantry: false, gramsPerPiece: 150 };
        expect(shoppingAmount({ qty: 3, unit: 'pcs', approx: false }, pick(), info))
            .toEqual({ quantity: 3, unit: 'vnt' });
        // No piece weight known → the count is not a purchase count.
        expect(shoppingAmount({ qty: 5, unit: 'pcs', approx: false }, pick(), null))
            .toEqual({ quantity: 1, unit: 'vnt' });
    });
});

/**
 * WHAT THE SECOND HOLDOUT CAUGHT — 23 recipes nothing had been tuned on.
 *
 * Every case here was chosen SILENTLY: high confidence, no review flag, a
 * shopping list that looked finished and was wrong. They share one shape — the
 * right product and a more-elaborate one score the same, so whichever the
 * database returned first won.
 */
describe('the plainer product wins a tie', () => {
    it('does not put hot chillies in a recipe asking for bell peppers', async () => {
        for (const line of ['2 capsicum', '1 red bell pepper']) {
            const r = await match(line, 'en');
            expect(r.product?.productId).toBe(ids.sweetPepper);
        }
    });

    it('still buys chillies when the recipe asks for heat', async () => {
        const r = await match('2 aitriosios paprikos', 'lt');
        expect(r.product?.productId).toBe(ids.hotPepper);
    });

    it('does not buy cheese-stuffed peppers for a plain one', async () => {
        const r = await match('1 red bell pepper', 'en');
        expect(r.product?.productId).not.toBe(ids.stuffedPepper);
    });

    it('does not buy a layered salad for the fish it is made of', async () => {
        const r = await match('4 silkės', 'lt');
        expect(r.product?.productId).toBe(ids.herring);
    });

    it('does not buy breaded patties for a frozen vegetable mix', async () => {
        const r = await match('300 g šaldytų daržovių', 'lt');
        expect(r.product?.productId).toBe(ids.frozenVegMix);
    });

    it('does not buy living sprouts for raw seeds', async () => {
        const r = await match('50 g saulėgrąžų', 'lt');
        expect(r.product?.productId).toBe(ids.sunflowerSeeds);
    });

    it('reads a chunk of ginger as the fresh root, not the spice jar', async () => {
        expect((await match('1 large chunk of ginger', 'en')).product?.productId).toBe(ids.freshGinger);
        // ...while bare "ginger" in a teaspoon is still the jar.
        expect((await match('1 tsp ground ginger', 'en')).product?.productId).toBe(ids.groundGinger);
    });

    it('never seasons a recipe with garlic salt when it asked for salt', async () => {
        const r = await match('1 šaukštelis druskos', 'lt');
        expect(r.product?.productId).not.toBe(ids.garlicSalt);
    });
});

/**
 * FRESH VS DRIED, decided by the shelf because the names cannot decide it.
 *
 * "Bazilikai WELL DONE" (a living plant) and "Bazilikai SALDVA" (a jar) differ
 * only by brand. A salad asking for chopped fresh basil was given the jar,
 * silently, at 0.97.
 */
describe('the right shelf for the form the recipe asked for', () => {
    it('buys the living plant for fresh basil', async () => {
        expect((await match('1/3 cup fresh basil', 'en')).product?.productId).toBe(ids.freshBasil);
        expect((await match('šviežių bazilikų', 'lt')).product?.productId).toBe(ids.freshBasil);
    });

    it('buys the jar for dried basil', async () => {
        expect((await match('1 tsp dried basil', 'en')).product?.productId).toBe(ids.driedBasil);
    });
});

/**
 * HOW MUCH TO BUY. Each of these shipped a wrong number: a shortfall is the
 * worst of them, because the shopper only finds out at home.
 */
describe('the amount actually put in the basket', () => {
    it('never buys less than the recipe needs, staple or not', async () => {
        // 600 g of flour used to be capped to 0.5 kg by the pantry top-up rule.
        const r = await match('600 g kvietinių miltų', 'lt');
        expect(r.shopQuantity).toBeGreaterThanOrEqual(0.6);
    });

    it('does not answer "how much?" with a kilogram', async () => {
        // 3 tbsp of a solid has no density in the table; the fallback was 1 kg.
        const r = await match('3 tbsp fresh ginger', 'en');
        expect(r.shopQuantity).toBeLessThanOrEqual(0.3);
    });

    it('buys one bunch for a handful of sprigs', async () => {
        const r = await match('9 čiobrelių šakelių', 'lt');
        expect(r).toMatchObject({ shopQuantity: 1, shopUnit: 'vnt' });
    });

    it('still counts things that are genuinely sold one at a time', async () => {
        const r = await match('3 kiaušiniai', 'lt');
        expect(r.shopUnit).toBe('vnt');
        expect(r.shopQuantity).toBe(3);
    });
});

/**
 * THE SECOND HOLDOUT'S OWN LESSONS.
 *
 * Every one of these was silent, and three share a mechanism: a product that
 * LEADS with the right noun and then says something else entirely.
 */
describe('a product that merely starts with the ingredient', () => {
    it('does not buy a ready meal for the grain it contains', async () => {
        const r = await match('200 g grikių', 'lt');
        expect(r.product?.productId).toBe(ids.buckwheat);
    });

    it('does not buy a breaded snack with dipping sauce for raw prawns', async () => {
        const r = await match('200 g krevečių', 'lt');
        expect(r.product?.productId).toBe(ids.prawns);
    });

    /**
     * ...but "su" in the RECIPE means the shopper asked for it, so the rule
     * must stop firing. It demotes, it never promotes — what is guaranteed is
     * that the accompanied product is still ON OFFER rather than pushed out of
     * the candidate list by a rule about a word the recipe itself used.
     */
    it('stops demoting an accompaniment the recipe named', async () => {
        const r = await match('200 g grikių su mėsa', 'lt');
        const offered = [r.product, ...r.alternatives].map(p => p?.productId);
        expect(offered).toContain(ids.buckwheatMeal);
    });
});

describe('uncategorised rows the catalog cannot even size', () => {
    it('never lets a book outrank real food', async () => {
        const r = await match('400 g žuvies filė', 'lt');
        expect(r.product?.productId).toBe(ids.fishFillet);
    });

    /** When it IS all there is, it is offered — never added silently. */
    it('asks rather than committing to an unsized uncategorised row', async () => {
        const r = await match('1 knyga žuvis vandenyje', 'lt');
        if (r.product?.productId === ids.fishBook) expect(r.confident).toBe(false);
    });
});

/**
 * MEAT — where the ranking bug that hid every other rule showed up worst.
 *
 * The demotions used to sit BELOW a raw-confidence short-circuit, so they only
 * applied to candidates already scoring within a hair of each other. A tin of
 * stewed beef scores 0.97 against "Jautiena" (short name, exact word) while
 * fresh mince scores 0.75 (long descriptive name), and 0.22 > the 0.20 band —
 * so nothing ever asked whether one of them was a tin.
 */
describe('fresh meat beats the tin that scores better', () => {
    it('buys fresh beef, not stewed beef in a tin', async () => {
        const r = await match('200 g jautienos', 'lt');
        expect(r.product?.productId).toBe(ids.beefFresh);
    });

    /** ...and not a pork-and-beef blend either: "ir" joins two things. */
    it('does not buy a two-meat blend for a one-meat recipe', async () => {
        const r = await match('200 g jautienos', 'lt');
        expect(r.product?.productId).not.toBe(ids.beefBlend);
    });

    /** The tin is still the answer when the recipe asks for the tin. */
    it('buys the tin when the recipe says stewed', async () => {
        const r = await match('200 g troškintos jautienos', 'lt');
        expect(r.product?.productId).toBe(ids.beefTin);
    });
});

/**
 * THE THIRD VALIDATION ROUND — 19 silent errors over 60 recipes.
 *
 * Class 1: a GENERIC head noun. "Vaisiai pagal skonį" bought a dried herbal
 * SUPPLEMENT powder, "šiek tiek prieskoniai" dropped curry into a cheese
 * pasta, "600 g mėsos" bought French-marinated chicken kebabs, "uogos" bought
 * dried barberries, "sėklų" bought seeded bread crisps. One shape: the recipe
 * names only a CATEGORY, so every well-scoring product is a specific thing
 * nobody asked for. The candidates stay on offer; the basket stays empty.
 */
describe('a category-only ingredient is a question, never a silent match', () => {
    it('never fills the basket for a bare category word', async () => {
        for (const line of ['600 g mėsos', 'šiek tiek prieskonių', '300 g uogų']) {
            const m = await match(line);
            expect(m.confident).toBe(false);
            if (m.product) expect(m.reviewReason).toBe('generic_ingredient');
        }
    });

    it('flags the English category words the same way', async () => {
        const m = await match('a handful of berries', 'en');
        expect(m.confident).toBe(false);
        if (m.product) expect(m.reviewReason).toBe('generic_ingredient');
    });

    /**
     * The counter-case that bounds the rule: a QUALIFIED category phrase is
     * answerable — a frozen berry MIX genuinely is "šaldytų uogų" — and the
     * existing confident match for it must survive (it is also asserted in
     * 'still lets the recipe phrase find what the canonical name cannot').
     */
    it('does not flag a category word once a qualifier narrows it', async () => {
        const m = await match('200 g šaldytų uogų');
        expect(m.confident).toBe(true);
        expect(m.reviewReason).toBeNull();
    });
});

/**
 * Class 2: the fresh-vs-processed axis stopped at meat and fish, so produce
 * never benefited — fresh cherry tomatoes silently became a vinegar-marinated
 * JAR (filed in 688, so only the "Mar." name marker can catch it), cranberries
 * became NATURFOOD's sweetened dried ones, and blueberries became
 * chocolate-coated ones, all while the fresh/frozen listings sat in the
 * alternatives.
 */
describe('fresh produce beats the processed shelf that outscores it', () => {
    it('buys fresh cherry tomatoes, not the marinated jar', async () => {
        const m = await match('200 g vyšninių pomidorų');
        expect(m.product?.productId).toBe(ids.freshCherryToms);
    });

    it('buys frozen cranberries, not sweetened dried ones', async () => {
        const m = await match('100 g spanguolių');
        expect(m.product?.productId).toBe(ids.frozenCranberries);
    });

    /**
     * ...but "džiovintų" in the recipe is the shopper asking for the dried
     * shelf, and the "Dž." abbreviation must read as the SAME preparation —
     * the old slice(0,6) equality saw "dz" and "dziovi" as strangers and
     * demoted the very product the recipe wanted.
     */
    it('still buys dried cranberries when the recipe says dried', async () => {
        const m = await match('100 g džiovintų spanguolių');
        expect(m.product?.productId).toBe(ids.driedCranberries);
    });

    it('buys frozen blueberries, not chocolate-coated ones', async () => {
        const m = await match('100 g mėlynių');
        expect(m.product?.productId).toBe(ids.frozenBlueberries);
        expect(m.product?.productId).not.toBe(ids.chocBlueberries);
    });
});

/**
 * Class 3: "1 vienetas paprika" resolved through the ground-spice entry (which
 * owns the bare word for EN "1 tsp paprika") and silently bought a jar of
 * ground paprika at 0.91. Nobody buys one UNIT of a powder — a piece count on
 * an entry with no piece weight means the vegetable was meant.
 */
describe('a counted piece vetoes a ground-spice reading', () => {
    it('reads "1 vienetas paprika" as the vegetable', async () => {
        const m = await match('1 vienetas paprika');
        expect(m.product?.productId).toBe(ids.sweetPepper);
        expect(m.product?.productId).not.toBe(ids.groundPaprika);
    });

    /** The spoon still buys the jar: volume converts through density and the
     *  veto never sees it. */
    it('keeps "1 tsp paprika" on the spice jar', async () => {
        const m = await match('1 tsp paprika', 'en');
        expect(m.product?.productId).toBe(ids.groundPaprika);
    });
});
