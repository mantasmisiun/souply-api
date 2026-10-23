import pool from '../src/config/db.js';
import { parseIngredientLine } from '../src/services/recipes/ingredientParser.js';
import { findIngredient } from '../src/services/recipes/measure.js';
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
/** The REAL meat shelves the bacon split hangs on: 'šoninė' on 99 'Kiauliena'
 *  is the raw belly cut, on 127 'Šoninė ir lašiniai' it is bacon — the word
 *  cannot tell them apart, only the cure word and the shelf can. */
const FRESH_PORK_CAT = 99;
const CURED_BACON_CAT = 127;
/** The REAL spreadable-cheese shelf ('Tepamieji sūriai ir varškė') — where
 *  both Philadelphia and the savoury RAMBYNO spread live, so the NAME shape
 *  (sūris vs the diminutive sūrelis) is what the query has to get right. */
const SPREAD_CHEESE_CAT = 52;
/** The REAL sausage shelves of the substitute axis: 106 'Šviežios dešrelės'
 *  is the fresh meat sausage, 107 'Augaliniai mėsos pakaitalai' the
 *  plant-based imitation that silently answered "4 dešrelės" — verified. */
const FRESH_SAUSAGE_CAT = 106;
const MEAT_SUBSTITUTE_CAT = 107;
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

/** An English translation for a product's SP — what `searchProduct`'s
 *  translation arm searches and the EN-fallback arm scores against. */
const addTranslation = async (productId: number, text: string): Promise<void> => {
    await q(
        `INSERT INTO StoreProductTranslation (storeProductId, lang, text, normalized)
         SELECT id, 'en', ?, ? FROM StoreProduct WHERE productId = ?`,
        [text, text.toLowerCase(), productId],
    );
};

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
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Kiauliena')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [FRESH_PORK_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Šoninė ir lašiniai')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [CURED_BACON_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Tepamieji sūriai ir varškė')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [SPREAD_CHEESE_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Šviežios dešrelės')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [FRESH_SAUSAGE_CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'Augaliniai mėsos pakaitalai')
             ON DUPLICATE KEY UPDATE name = VALUES(name)`, [MEAT_SUBSTITUTE_CAT]);
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
    // Cherry-scented barbecue SMOKING CHIPS: they LEAD with the fruit's own
    // noun, sit in 688 where no category id can catch them, and are properly
    // listed — so they silently answered "Vyšnios" at 0.78 while the frozen
    // shelf held real cherries. Only the NOT_FOOD phrase guard ('medžio
    // drožlės') separates them from food; bare 'drožl' must not, because
    // coconut flakes and almond shavings carry the same word.
    ids.cherryWoodChips = await addProduct('Vyšnios Medžio drožlės PROFLAME EXPERT', {
        amount: 1, unit: 'kg', categoryId: 688 });
    ids.frozenCherries = await addProduct('Šaldytos vyšnios WELL DONE be kauliukų', {
        amount: 400, unit: 'g', categoryId: FROZEN_BERRY_CAT });
    // A generic category word's favourite wrong answers.
    ids.currySpice = await addProduct('Prieskoniai CURRY KOTANYI', { amount: 50, unit: 'g' });
    ids.meatSkewers = await addProduct('Mėsos iešmeliai su marinatu', { amount: 500, unit: 'g' });
    // The ground-spice jar a counted "1 vienetas paprika" must NOT buy.
    ids.groundPaprika = await addProduct('Malta saldžioji paprika ALVO', { amount: 100, unit: 'g' });

    // --- THE DROPPED-WORD OVERHAUL: the fresh-poultry shelf never says
    // "vištiena" (recipes always do), and the canned tin whose label cannot
    // vouch for the "šaldytų" a recipe asked for.
    ids.broiler = await addProduct('Viščiukas broileris RIMI', { amount: 1, unit: 'kg', weighable: true });
    ids.chickenThighs = await addProduct('Viščiukų broilerių šlaunelės RIMI', { amount: 700, unit: 'g' });
    ids.cannedPeas = await addProduct('Žirneliai KĖDAINIŲ KONSERVAI', { amount: 690, unit: 'g' });

    // --- THE SILENT GATE (the 18-recipe holdout's five silent errors).
    // An ingredient the lexicon does NOT know: dough is made, not bought, and
    // the pastry snack that carries the word cleared the accept bar at 0.75.
    ids.doughSnack = await addProduct('Sūrieji tešlos šaukšteliai LAIMA', { amount: 160, unit: 'g' });
    // A bare species word's favourite answer: whichever cut ranks first.
    ids.porkMince = await addProduct('Atšaldyta smulkinta kiauliena, 30 %',
        { amount: 500, unit: 'g', categoryId: FRESH_PORK_CAT });
    // Raw belly vs bacon: same word, different shelves, only one is cured.
    ids.rawBelly = await addProduct('Lietuviška kiaulienos šoninė be kaulo, atšaldyta',
        { amount: 500, unit: 'g', categoryId: FRESH_PORK_CAT, weighable: true });
    ids.curedBacon = await addProduct('Šaltai rūkytos šoninės kubeliai, a. r.',
        { amount: 200, unit: 'g', categoryId: CURED_BACON_CAT });
    // Philadelphia-type spreadable vs the savoury melted spread whose name is
    // the DIMINUTIVE of the same words.
    ids.philadelphia = await addProduct('Tepamasis sūris PHILADELPHIA ORIGINAL, 21 % rieb.',
        { amount: 175, unit: 'g', categoryId: SPREAD_CHEESE_CAT });
    ids.rambyno = await addProduct('RAMBYNO tepamasis sūrelis',
        { amount: 175, unit: 'g', categoryId: SPREAD_CHEESE_CAT });
    // "pasta sauce" is sauce; the noodles carry the recognised word.
    ids.tagliatelle = await addProduct('Makaronai TAGLIATELLE', { amount: 500, unit: 'g' });
    ids.tomatoSauce = await addProduct('Pomidorų padažas TRADICINIS KKF', { amount: 500, unit: 'g' });
    // A preparation nobody asked for, as the ONLY thing on offer.
    ids.driedMango = await addProduct('Džiovinti mangai SEEBERGER', { amount: 100, unit: 'g' });

    // --- THE EN NULL-QUERY GAP (measured fixes B+C): ingredients the lexicon
    // does not know, reachable only through StoreProductTranslation.
    // The catalog's only real rhubarb: uncategorised, size never recorded —
    // but its translation IS the query, word for word.
    ids.rhubarb = await addProduct('Rabarbarai', { categoryId: 688 });
    await addTranslation(ids.rhubarb, 'Rhubarb');
    // ...and the drink that merely mentions the word, properly listed.
    ids.rhubarbWine = await addProduct('Gaz. vaisių vynas WOLU RHUBARB, 6 %', { amount: 750, unit: 'ml' });
    await addTranslation(ids.rhubarbWine, 'Carbonated fruit wine WOLU RHUBARB, 6 %');
    // A product whose LT name never says the English word at all.
    ids.gnocchi = await addProduct('Bulvių virtinukai RANA', { amount: 400, unit: 'g' });
    await addTranslation(ids.gnocchi, 'Potato gnocchi RANA');
    // The measured junk: PVA glue, listed, in 'Nepriskirta' — its translation
    // stem-matches "white rum" ("centRUM"), so only the NAME can reject it.
    ids.pvaGlue = await addProduct('Balti klijai PVA CENTRUM', { amount: 250, unit: 'ml', categoryId: 688 });
    await addTranslation(ids.pvaGlue, 'White PVA glue CENTRUM');
    ids.whiteRum = await addProduct('Romas EL GALIPOTE WHITE', { amount: 700, unit: 'ml' });
    await addTranslation(ids.whiteRum, 'White rum EL GALIPOTE');

    // --- STOCK: the ready-made liquid and the cube box are named IDENTICALLY
    // on the real shelf ("Vištienos sultinys", 750 ml carton, vs "Vištienos
    // sultinys MAGGI", 160 g of cubes); only the recorded pack (ml vs g) tells
    // them apart. The bare-named liquid is the exact-name 1.00 scorer the
    // branded cube has to beat; fish stock is the species the real catalog
    // does not stock in ANY form, so its liquid stands alone and must survive.
    ids.liquidMushStock = await addProduct('Grybų sultinys', { amount: 750, unit: 'ml' });
    ids.mushStockCubes = await addProduct('Grybų sultinys GALLINA BLANCA', { amount: 80, unit: 'g' });
    ids.fishStockLiquid = await addProduct('Žuvies sultinys', { amount: 500, unit: 'ml' });

    // --- THE FALLBACK SELECTION DEFECT (2026-07 judge round): the widened
    // pool is recalled AND scored with the bare head noun, so a product that
    // IS nothing but the head wore an exact score for a question nobody asked.
    // The real shapes: fresh jalapeños bought for allspice berries while
    // "Kvapieji pipirai SAUDA" sat in the alternatives; dairy butter bought
    // for crunchy peanut butter while a dozen kremas jars sat one translation
    // away; a fresh potted IKI DERLIUS thyme bought for "dried thyme".
    ids.allspiceJar = await addProduct('Kvapieji pipirai TESTSAUDA', {
        amount: 15, unit: 'g', categoryId: DRIED_SPICE_CAT });
    ids.jalapeno = await addProduct('Pipirai TESTJALAPENO, 1 kl.', { amount: 1, unit: 'kg', weighable: true });
    ids.peanutButter = await addProduct('Žemės riešutų kremas TESTNUT', { amount: 340, unit: 'g' });
    await addTranslation(ids.peanutButter, 'Crunchy peanut butter TESTNUT');
    // NO synthetic plain "Sviestas …" here on purpose: a bare-noun-led dairy
    // butter would win the lead tie-break for every seeded "sviesto" test
    // (ROKIŠKIO is deliberately brand-led). ids.butter IS the dairy trap the
    // beheaded fallback used to buy.
    // The all-stranger counter-case: no spice jar prints "džiovinti", so the
    // whole widened pool are strangers and the best of them must still win.
    ids.oreganoJar = await addProduct('Raudonėliai TESTSPICE', {
        amount: 10, unit: 'g', categoryId: DRIED_SPICE_CAT });
    ids.thymePot = await addProduct('Čiobreliai TESTDERLIUS', { categoryId: 688 });
    ids.thymeJar = await addProduct('Čiobreliai TESTJAR', { amount: 10, unit: 'g', categoryId: DRIED_SPICE_CAT });
    // The walk-down twin of the same disease: the recipe NAMED the variant
    // qualifier, and the bare-noun lead band still handed the win to a plain
    // branded product 0.17 points below it.
    ids.plainCurd = await addProduct('Varškė TESTPLAIN, 4 % rieb.', { amount: 400, unit: 'g' });
    ids.semiFatCurd = await addProduct('Pusriebė varškė TESTFAT, 9 %', { amount: 400, unit: 'g' });

    // --- JUDGED ROUND 7 (four defect classes): the plant-based substitute
    // that silently answered "4 dešrelės" beside its honest meat rival; the
    // soft cheeses that used to collapse to cheese_hard; the 9% spirit
    // vinegar the shelf actually stocks beside the apple trap; the coconut
    // GĖRIMAS beside the condensed tin; and the salad green whose English
    // name contains a meat word. (The vegan fixture is deliberately NOT
    // named 'Žirnių …' — the real product is — so it cannot wander into the
    // seeded pea tests; the mechanism under test is the CATEGORY, not the
    // word.)
    ids.veganSausages = await addProduct('Veganiškos dešrelės TESTVEG', {
        amount: 200, unit: 'g', categoryId: MEAT_SUBSTITUTE_CAT });
    ids.meatSausages = await addProduct('Šviežios kiaulienos dešrelės TESTMEAT', {
        amount: 400, unit: 'g', categoryId: FRESH_SAUSAGE_CAT });
    ids.ricotta = await addProduct('Rikota TESTRIC, 45 % rieb. s. m.', { amount: 250, unit: 'g' });
    ids.mascarpone = await addProduct('Maskarponė TESTMASC, 80 % rieb.', { amount: 250, unit: 'g' });
    ids.spiritVinegar = await addProduct('Spirito actas TESTSPIRIT, 9 %', { amount: 500, unit: 'ml' });
    ids.appleVinegar = await addProduct('Obuolių actas TESTAPPLE, 6 %', { amount: 500, unit: 'ml' });
    ids.coconutDrink = await addProduct('Kokosų gėrimas TESTCOCO, rieb. 18 %', { amount: 400, unit: 'ml' });
    ids.condensedCoconut = await addProduct('Sutirštintas kokosų pienas TESTCOND', { amount: 320, unit: 'ml' });
    ids.macheGreens = await addProduct('Salotinės sultenės TESTGREEN', { amount: 100, unit: 'g' });

    // --- JUDGED ROUND 8 (six defect classes): the ground NUTMEG that answered
    // "maltų riešutų" beside honest nuts (the homonym rule); the jam-sugar
    // purpose variant that beat every plain brown bag four rounds running; the
    // cheddar BLOCK that answered "cheddar cheese soup"; the salad mix that
    // was lexicon-keyed to shallot; and the branded Sprite/Coca-Cola pair the
    // typographic quotes used to hide from the search.
    ids.nutmegJar = await addProduct('Malti muskato riešutai TESTSAUDA', {
        amount: 28, unit: 'g', categoryId: DRIED_SPICE_CAT });
    ids.walnuts = await addProduct('Gliaudyti graikiniai riešutai TESTLINE', { amount: 150, unit: 'g' });
    ids.jamSugar = await addProduct('Rudasis cukrus uogienėms TESTALVO', { amount: 500, unit: 'g' });
    ids.brownSugar = await addProduct('Smulkus rudasis cukrus TESTBAG', { amount: 500, unit: 'g' });
    ids.saladMix = await addProduct('Salotų mišinys TESTLEAF', { amount: 100, unit: 'g' });
    ids.cheddarBlock = await addProduct('Čederio sūris TESTBILLA', { amount: 200, unit: 'g' });
    await addTranslation(ids.cheddarBlock, 'Cheddar cheese TESTBILLA');
    ids.sprite = await addProduct('Gaivusis gėrimas SPRITE TESTDRINK', { amount: 1500, unit: 'ml' });
    ids.cola = await addProduct('Gaivusis gėrimas COCA-COLA TESTDRINK', { amount: 1500, unit: 'ml' });

    // --- JUDGED ROUND 9 (one defect class, eleven faces): a QUALIFIER dropped
    // in the lexicon hop, or a lexicon entry hit on a SUBSTRING of a token.
    // The brandy that answered a steak rub, and the mix that should have.
    ids.brandy = await addProduct('Brendis TORRES TESTSPIRIT', { amount: 700, unit: 'ml' });
    ids.steakSeasoning = await addProduct('Kepsnių prieskoniai TESTMARIA', { amount: 100, unit: 'g' });
    // The brown bag that answered "red lentils" while the red one sat beside it.
    ids.brownLentils = await addProduct('Lęšiai TESTBROWN', { amount: 500, unit: 'g' });
    ids.redLentils = await addProduct('Raudonieji lęšiai TESTRED', { amount: 500, unit: 'g' });
    // Baking soda vs the carbonated water a bar recipe means by 'sodos vanduo'.
    ids.bakingSoda = await addProduct('Maistinė soda TESTSODA', { amount: 500, unit: 'g' });
    ids.sparklingWater = await addProduct('Gazuotas šaltinio vanduo TESTRIMI', { amount: 1500, unit: 'ml' });
    // Simple syrup: the sugar-FREE flavoured impostor whose name contains both
    // query words, and the real light sugar syrup.
    ids.flavouredSyrup = await addProduct('Sirupas TESTTEISSEIRE, karamelės skonio, be cukraus', { amount: 600, unit: 'ml' });
    ids.lightSyrup = await addProduct('Šviesusis sirupas TESTSUKKER', { amount: 500, unit: 'ml' });
    // The note's exemplar: a sweet sparkling wine that outscores the dry
    // Prosecco the recipe literally named in its parenthetical.
    ids.sweetSparkling = await addProduct('Putojantis saldus vynas TESTALITA', { amount: 750, unit: 'ml' });
    ids.prosecco = await addProduct('Putojantis baltasis sausas vynas PROSECCO TESTWINE', { amount: 750, unit: 'ml' });
    // The same brand sells RUM — the short name that outscored the bitters.
    ids.angosturaRum = await addProduct('Romas ANGOSTURA 7YO TESTRUM', { amount: 700, unit: 'ml' });
    ids.angosturaBitters = await addProduct('Kartaus skonio spiritinis gėrimas Angostura Arom.Bitter TESTBIT', { amount: 200, unit: 'ml' });
}, 60_000);   // ~90 products × (Product + StoreProduct + Price) — well past Jest's 5 s default

afterAll(async () => {
    const productIds = Object.values(ids);
    if (productIds.length > 0) {
        await q(`DELETE p FROM Price p JOIN StoreProduct sp ON sp.id = p.storeProductId
                 WHERE sp.productId IN (?)`, [productIds]);
        await q(`DELETE t FROM StoreProductTranslation t JOIN StoreProduct sp ON sp.id = t.storeProductId
                 WHERE sp.productId IN (?)`, [productIds]);
        await q(`DELETE FROM StoreProduct WHERE productId IN (?)`, [productIds]);
        await q(`DELETE FROM Product WHERE id IN (?)`, [productIds]);
    }
    await q(`DELETE FROM Store WHERE id = ?`, [STORE]);
    await q(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN]);
    await q(`DELETE FROM Category WHERE id = ?`, [CAT]);
    await q(`DELETE FROM Category WHERE id = ?`, [SEED_CAT]);
    await q(`DELETE FROM Category WHERE id IN (?)`,
        [[FRESH_HERB_CAT, DRIED_SPICE_CAT, FRESH_TOMATO_CAT, FROZEN_BERRY_CAT, DRIED_BERRY_CAT,
            FRESH_PORK_CAT, CURED_BACON_CAT, SPREAD_CHEESE_CAT,
            FRESH_SAUSAGE_CAT, MEAT_SUBSTITUTE_CAT]]);
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

    /**
     * COUNT → PACK, consistently across one family. "3 kiaušiniai" cleared
     * the 100 g contents line at 165 g and bought three ten-egg cartons while
     * "2 kiaušinių trynių" (36 g) bought one — split by nothing but total
     * mass. A piece lighter than PIECE_SOLD_ALONE_G is pack CONTENT whatever
     * the count sums to; a piece heavy enough to be its own retail unit (a
     * baguette, a loaf) keeps the count as the purchase count.
     */
    it('never multiplies packages by a count of their contents', () => {
        const egg = { key: 'egg', ltName: 'K', enName: 'e', lt: [], en: [], pantry: false, gramsPerPiece: 55 };
        // Eggs come back with no packAmount at all ('vnt' sizes are never
        // normalised), so the piece weight alone must make this ONE carton.
        expect(shoppingAmount({ qty: 3, unit: 'pcs', approx: false }, pick(), egg))
            .toEqual({ quantity: 1, unit: 'vnt' });
        const yolk = { ...egg, key: 'egg_yolk', gramsPerPiece: 18 };
        expect(shoppingAmount({ qty: 2, unit: 'pcs', approx: false }, pick(), yolk))
            .toEqual({ quantity: 1, unit: 'vnt' });
    });

    it('still counts pieces that are their own retail unit', () => {
        // A 250 g baguette IS the package: three baguettes are three purchases.
        const baguette = { key: 'baguette', ltName: 'B', enName: 'b', lt: [], en: [], pantry: false, gramsPerPiece: 250 };
        expect(shoppingAmount({ qty: 3, unit: 'pcs', approx: false }, pick(), baguette))
            .toEqual({ quantity: 3, unit: 'vnt' });
    });

    /** A known package size DIVIDES the counted mass — it must not fall back
     *  to the raw count once the amount overflows a single package (twelve
     *  60 g sausages against a 400 g pack are two packs, not twelve). */
    it('divides a counted overflow by the package size', () => {
        const sausage = { key: 'sausages', ltName: 'D', enName: 'd', lt: [], en: [], pantry: false, gramsPerPiece: 60 };
        expect(shoppingAmount({ qty: 12, unit: 'pcs', approx: false },
            pick({ packAmount: 400, packUnit: 'g' }), sausage))
            .toEqual({ quantity: 2, unit: 'vnt' });
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
 * STOCK IS BOUGHT AS CUBES. "250 ml vištienos sultinio" silently bought a
 * 750 ml carton of ready-made liquid — an exact-name 1.00 that beat every cube
 * product wearing a brand — when the Lithuanian purchase is "sultinio
 * kubeliai" made up with water (the dev stock shelf runs ~20 cube products per
 * species against a handful of liquids). The names cannot separate the forms
 * (most cubes are ALSO named bare "X sultinys <BRAND>"); the recorded pack
 * dimension can, and does. The broth entries also carry no gramsPerMl any
 * more: the millilitres a recipe measures are water, and converting them to
 * purchase mass divided 250 "grams" into multiple cube packs.
 */
describe('stock is bought as cubes, not ready-made liquid', () => {
    it('buys a dry cube pack for a stock line, never the liquid carton', async () => {
        const m = await match('250 ml grybų sultinio');
        expect(m.key).toBe('broth_mushroom');
        expect(m.product?.productId).toBe(ids.mushStockCubes);
        expect(m.product?.productId).not.toBe(ids.liquidMushStock);
        // One pack, whatever volume the recipe dissolves it into — the
        // mass-vs-volume dimension check refuses to divide water by cubes.
        expect(m.shopQuantity).toBe(1);
        expect(m.shopUnit).toBe('vnt');
    });

    it('still sells the liquid when it is all the catalog stocks', async () => {
        // Fish stock: no cube on offer, so the demotion never fires and the
        // rule stays "prefer cubes", never "refuse liquid".
        const m = await match('200 ml žuvies sultinio');
        expect(m.product?.productId).toBe(ids.fishStockLiquid);
        expect(m.shopQuantity).toBe(1);
        expect(m.shopUnit).toBe('vnt');
        expect(m.confident).toBe(true);
    });

    it('keeps the liquid for a recipe that asks for it by name', async () => {
        const m = await match('250 ml skysto grybų sultinio');
        expect(m.product?.productId).toBe(ids.liquidMushStock);
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

    /**
     * A counted egg is pack CONTENT, and the count must never multiply
     * cartons: "3 kiaušiniai" used to clear the 100 g contents line at 165 g
     * and buy THREE ten-egg cartons, while "2 kiaušinių trynių" (36 g) stayed
     * under it and correctly bought one — the same lexicon family, opposite
     * answers. Egg products are sold by 'vnt', which the pipeline never
     * normalises into packAmount, so the piece weight itself has to carry the
     * pack-content signal (see PIECE_SOLD_ALONE_G).
     */
    it('buys one carton for a count of eggs, never a carton per egg', async () => {
        for (const line of ['3 kiaušiniai', '2 kiaušinių trynių']) {
            const r = await match(line, 'lt');
            expect(r.product?.productId).toBe(ids.eggs);
            expect(r).toMatchObject({ shopQuantity: 1, shopUnit: 'vnt' });
        }
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

    /**
     * NOT the produce axis but the same aisle-neighbour trap one shelf
     * further out: the chips are not food AT ALL, and they win the lead
     * tie-break because Lithuanian product naming puts the wood's flavour
     * first. Asserted by NAME because the dev catalog carries the same chip
     * and cherry listings as the fixtures — any real cherry row is a right
     * answer, any 'drožlės' row is a wrong one.
     */
    it('buys real cherries, never cherry-scented smoking chips', async () => {
        const m = await match('200 g vyšnių');
        const offered = [m.product, ...m.alternatives].filter(Boolean) as { name: string }[];
        expect(offered.some(p => /drožl/i.test(p.name))).toBe(false);
        expect(m.product?.name).toMatch(/šaldytos vyšnios/i);
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

    /**
     * The goulash regression: one recipe with BOTH lines. The window scan is
     * longest-first but leftmost at equal length, so in "saldžiosios paprikos
     * miltelių" the 2-word 'saldžiosios paprikos' (bell_pepper's own form)
     * beat 'paprikos miltelių' — and the teaspoon of spice bought 100 g of
     * the same fresh peppers as the recipe's counted line. The lexicon's
     * 3-word powder forms win the length race before position can lose it.
     */
    it('separates a recipe\'s counted pepper from its paprika powder', async () => {
        const vegetable = await match('1 vienetas paprikos');
        expect(vegetable.key).toBe('bell_pepper');
        expect(vegetable.product?.productId).toBe(ids.sweetPepper);

        const spice = await match('1 šaukštelis saldžiosios paprikos miltelių');
        expect(spice.key).toBe('paprika_ground');
        expect(spice.product?.productId).toBe(ids.groundPaprika);
        expect(spice.product?.productId).not.toBe(vegetable.product?.productId);
    });
});

/**
 * THE DROPPED-WORD OVERHAUL. Over a 180-recipe sweep the LT guard fired 249
 * times — 84% of the whole review queue — overwhelmingly on CORRECT matches:
 * Lithuanian inflection the blunt stemmer missed, words the lexicon window had
 * already accounted for, and the vištiena↔viščiukas shelf synonym. The guard
 * now consults the window (as the EN branch always did), a verified synonym
 * table and a kitchen-state list — while process words that pick a different
 * SHELF (rūkytos, šaldytų, konservuotų…) still flag, because those are the
 * substitutions the guard exists to report.
 */
describe('the dropped-word guard flags substitutions, not inflection', () => {
    /** 'maltų juodųjų pipirų' is a listed form of the pepper entry — the
     *  lexicon deliberately says ground pepper shops as "Juodieji pipirai",
     *  and that decision must not come back as a warning 27 times a sweep. */
    it('does not flag the grinding word the lexicon window accounted for', async () => {
        const m = await match('1 šaukštelis maltų juodųjų pipirų');
        expect(m.product?.productId).toBe(ids.blackPepper);
        expect(m.confident).toBe(true);
    });

    /** "Vištienos kiaušinis" is an EGG. Leftmost-wins used to stop on the
     *  1-word 'vištienos' window and buy a WHOLE BROILER — 7× in one sweep. */
    it('reads a chicken egg as eggs, not as a chicken', async () => {
        const m = await match('2 vnt. Vištienos kiaušinis');
        expect(m.product?.productId).toBe(ids.eggs);
        expect(m.product?.productId).not.toBe(ids.broiler);
    });

    /** The shelf says "viščiukų broilerių", the recipe says "vištienos" — the
     *  same bird, and 17 correct matches went to review over the word. */
    it('does not flag the vištiena↔viščiukas shelf synonym', async () => {
        const m = await match('400 g vištienos šlaunelių mėsos');
        expect(m.product?.productId).toBe(ids.chickenThighs);
        expect(m.confident).toBe(true);
    });

    /** A kitchen state is the cook's job, not a different purchase. */
    it('does not flag butter the recipe wants softened', async () => {
        const m = await match('100 g minkšto sviesto');
        expect(m.product?.productId).toBe(ids.butter);
        expect(m.confident).toBe(true);
    });

    /** The genuine flag the guard exists for: the product is NOT smoked. */
    it('still flags a preparation the product does not carry', async () => {
        const m = await match('500 g rūkytos vištienos');
        expect(m.product?.productId).toBe(ids.broiler);
        expect(m.confident).toBe(false);
        expect(m.reviewReason).toBe('dropped_word');
    });

    /** The window must NOT excuse a process word: 'šaldytų žirnelių' is a
     *  listed form of the generic peas entry, but a recipe asking for frozen
     *  peas must never receive a CAN silently. */
    it('still flags a can offered for frozen peas', async () => {
        const m = await match('400 g šaldytų žirnelių');
        expect(m.product?.productId).toBe(ids.cannedPeas);
        expect(m.confident).toBe(false);
        expect(m.reviewReason).toBe('dropped_word');
    });

    /** The product side of the same coin: "Dž." IS the "džiovintų" the recipe
     *  asked for, and the flag used to fire hardest on exactly the right
     *  product because the abbreviation stems to nothing. */
    it('reads the shelf abbreviation as the word the recipe used', async () => {
        const m = await match('100 g džiovintų spanguolių');
        expect(m.product?.productId).toBe(ids.driedCranberries);
        expect(m.confident).toBe(true);
    });
});

/**
 * THE SILENT GATE — clearing acceptance is not permission to fill the basket
 * unannounced. `confident` used to be `reason == null`, so the score played
 * no part in the silent decision, and every silent error the 18-recipe
 * holdout found sat at 0.75–0.78. Below SILENT_ACCEPT, silence now has to be
 * vouched for: a lexicon-vetted query fully present in the name, and a winner
 * carrying none of the ranking's doubt signals.
 */
describe('the silent gate: accepted is not the same as unasked', () => {
    /**
     * "1 šaukšto tešlos" — dough is MADE, not bought, so the lexicon has no
     * entry and the query is just the recipe's own genitive. The 0.75 the
     * pastry snack scored measures spelling, not dough-ness; without a vetted
     * name behind it, a soft score is a question.
     */
    it('never silently accepts a soft score for an ingredient the lexicon does not know', async () => {
        const m = await match('1 šaukšto tešlos');
        expect(m.confident).toBe(false);
        if (m.product) expect(m.reviewReason).toBe('soft_score');
    });

    /**
     * A bare SPECIES word names an aisle, not a cut: "kiauliena" silently
     * bought raw mince because mince happened to rank first. The species
     * words now behave exactly like 'mėsa' — offered, never silent — while a
     * qualified phrase ("troškintos jautienos", asserted above) still narrows
     * the aisle to a product and stays silent.
     */
    it('asks before answering a bare species word with whichever cut ranks first', async () => {
        for (const line of ['200 g kiaulienos', '200 g jautienos', '300 g vištienos']) {
            const m = await match(line);
            expect(m.confident).toBe(false);
            if (m.product) expect(m.reviewReason).toBe('generic_ingredient');
        }
    });

    /** ...and the flag does not rob the ranking: bare beef still finds the
     *  fresh mince, not the tin — it just gets offered instead of assumed. */
    it('still offers the fresh cut for a bare species word', async () => {
        const m = await match('200 g jautienos');
        expect(m.product?.productId).toBe(ids.beefFresh);
    });

    /**
     * EN "bacon" means CURED — but 'šoninė' is also the raw belly cut, and
     * the bare query ranked the raw belly first (the cured shelf lost points
     * for a preparation the query did not carry). The bacon entry now asks
     * for the cure by name, which flips both signals at once.
     */
    it('buys cured bacon for an English bacon, never the raw belly', async () => {
        for (const line of ['300 g bacon lardons', '4 rashers of smoked bacon']) {
            const m = await match(line, 'en');
            expect(m.product?.productId).toBe(ids.curedBacon);
        }
    });

    /** The Lithuanian word keeps both meanings: a recipe that says 'šoninės'
     *  may genuinely mean the fresh cut, and still gets it. */
    it('still sells the raw belly to a Lithuanian recipe that says šoninė', async () => {
        const m = await match('500 g šoninės');
        expect(m.product?.productId).toBe(ids.rawBelly);
    });

    /**
     * "cream cheese" is the Philadelphia shelf, and the shelf's own head is
     * 'Tepamasis sūris'. The old canonical name was the DIMINUTIVE — the
     * savoury melted-spread shape — and it bought RAMBYNO for a cheesecake.
     */
    it('buys spreadable cheese for cream cheese, not the savoury spread', async () => {
        const m = await match('24 oz cream cheese', 'en');
        expect(m.product?.productId).toBe(ids.philadelphia);
        expect(m.product?.productId).not.toBe(ids.rambyno);
    });

    /** "pasta sauce" is SAUCE. With only the 'pasta' window recognised, the
     *  head noun was the word that got dropped, and a jar of sauce became a
     *  bag of noodles. */
    it('buys sauce for pasta sauce, and noodles for spaghetti', async () => {
        expect((await match('26 oz pasta sauce', 'en')).product?.productId).toBe(ids.tomatoSauce);
        expect((await match('500 g spaghetti', 'en')).product?.productId).toBe(ids.tagliatelle);
    });

    /**
     * A winner that carries a preparation nobody asked for won only because
     * nothing better existed — the demotion moved every candidate together.
     * That is exactly when to ask, whatever the score says.
     */
    it('asks when the only thing on offer is a preparation nobody wanted', async () => {
        const m = await match('2 mangai');
        expect(m.product?.productId).toBe(ids.driedMango);
        expect(m.confident).toBe(false);
        expect(m.reviewReason).toBe('soft_score');
    });

    /**
     * The counter-case that bounds the gate: a lexicon-vetted staple whose
     * score is depressed only by BRANDING stays silent at 0.78 — flagging the
     * sub-0.85 band wholesale would flag 371 rows of the 180-recipe sweep,
     * almost all correct, and re-train the shopper to tap through warnings.
     */
    it('keeps a brand-depressed lexicon staple silent', async () => {
        const m = await match('100 gramų sviesto');
        expect(m.product?.productId).toBe(ids.butter);
        expect(m.confident).toBe(true);
    });
});

/**
 * THE ENGLISH NULL-QUERY GAP (measured fixes B + C). An unknown English phrase
 * used to produce `query: null` and never search at all — 43 rows of the
 * corpus got nothing while the translation table could answer them. The
 * fallback searches the recipe's own phrase, prep-stripped, ranks against the
 * translations, and is NEVER silent; the non-food guards are what keep the
 * measured junk (PVA glue for "white rum") out.
 */
describe('the English null-query fallback', () => {
    it('searches the phrase when the lexicon has no entry, and never silently', async () => {
        const m = await match('150 g gnocchi', 'en');
        expect(m.query).toBe('gnocchi');
        expect(m.product?.productId).toBe(ids.gnocchi);
        expect(m.confident).toBe(false);
        expect(m.reviewReason).toBe('soft_score');
    });

    /** One stray prep word used to zero the whole AND-composed search; form
     *  words are stripped from the QUERY only — the display name keeps them. */
    it('strips preparation words from the query', async () => {
        const m = await match('200 g finely chopped rhubarb', 'en');
        expect(m.query).toBe('rhubarb');
        expect(m.product?.productId).toBe(ids.rhubarb);
        expect(m.confident).toBe(false);
    });

    /** The unlisted demotion loses every tie — except when the catalog's own
     *  translation says the product IS the query, word for word. Without the
     *  lift, the rhubarb-flavoured WINE outranked the only real rhubarb. */
    it('lets an exact translation out-vouch a missing listing', async () => {
        const m = await match('2 rhubarb stalks, trimmed', 'en');
        expect(m.query).toBe('rhubarb');
        expect(m.product?.productId).toBe(ids.rhubarb);
    });

    /**
     * The measured trap, kept: the glue's translation stem-matches "white
     * rum" through "centRUM", and the NOT_FOOD name guard is what keeps it
     * out of the offer. The phrase itself no longer travels the EN fallback —
     * 'white rum' is a lexicon entry now (rum_white, query "Romas White"; the
     * drinks aisle was the least-covered category and every spirit produced
     * no query at all) — so the pick is asserted by NAME: the dev catalog
     * carries the same bottle under the same name, and either row is the
     * right answer.
     */
    it('never offers PVA glue for white rum', async () => {
        const m = await match('50 ml white rum', 'en');
        const offered = [m.product, ...m.alternatives].filter(Boolean) as { productId: number; name: string }[];
        expect(offered.some(p => p.productId === ids.pvaGlue)).toBe(false);
        expect(m.product?.name).toMatch(/^Romas\b/i);
        expect(m.product?.name).toMatch(/white|blanca/i);
        // A 50 ml pour buys ONE bottle, not five.
        expect(m).toMatchObject({ shopQuantity: 1, shopUnit: 'vnt' });
    });

    /** FORM words survive into the query — "ground ginger" must keep buying
     *  the spice jar, not the fresh root the bare noun would find. */
    it('keeps form words: ground ginger still buys the jar', async () => {
        const m = await match('1 tsp ground ginger', 'en');
        expect(m.product?.productId).toBe(ids.groundGinger);
    });
});

/**
 * THE FALLBACK SELECTION DEFECT: the head-noun fallback recalls AND scores
 * its pool with the bare head, so a product that IS nothing but the head
 * carries an exact-token score for a question nobody asked — 0.97 of
 * pipirai-ness bought fresh jalapeños for allspice berries while the right
 * jar sat in the alternatives at 0.78. A fallback or walk-down must never
 * replace a candidate that still carries what the recipe asked for: inside a
 * widened pool, a candidate that lost the original query's identity words is
 * a STRANGER — penalised past the dishonest score gap, tie-broken below any
 * carrier, and stamped with a demerit the review screen can explain.
 */
describe('the fallback must not outvote the identity it dropped', () => {
    /** "Kvapnieji pipirai" recalls nothing (the shelf spells it "Kvapieji"),
     *  the fallback widens to "pipirai" — and the widened pool must still
     *  put the allspice jar above the fresh chilli that merely IS pipirai. */
    it('buys the allspice jar, not jalapeños, for allspice berries', async () => {
        const m = await match('1 šaukštelis kvapniųjų pipirų žirnelių');
        expect(m.product?.name).toMatch(/kvapieji pipirai/i);
        const offered = [m.product, ...m.alternatives].filter(Boolean) as { productId: number; demerits: number }[];
        // The jalapeño may stay VISIBLE, but only wearing its stranger demerit.
        for (const p of offered) {
            if (p.productId === ids.jalapeno) expect(p.demerits).toBeGreaterThan(0);
        }
    });

    /**
     * The lexicon says "Žemės riešutų sviestas", every Lithuanian shop prints
     * "kremas / pasta" — zero recall, and the beheaded fallback query
     * "sviestas" bought DAIRY butter. An English recipe now retries its own
     * phrase through the translation arm first, and the pick is review-only
     * (machine translations vouch for it, not a vetted shopping name).
     */
    it('buys peanut butter, not dairy butter, for crunchy peanut butter', async () => {
        const m = await match('2 tbsp crunchy peanut butter', 'en');
        expect(m.product?.name).toMatch(/riešut/i);
        expect(m.product?.productId).not.toBe(ids.butter);
        expect(m.confident).toBe(false);
        expect(m.reviewReason).toBe('soft_score');
    });

    /**
     * "Dried thyme" falls back to the bare "čiobreliai", where the fresh
     * potted line (filed in 688 — no category says "potted") outscored the
     * dried-shelf jar. When the recipe asked for dried and the dried-spice
     * shelf HAS an offer, an uncategorised twin whose name does not claim
     * dried-ness itself is the doubtful one — same shape as the stock-cube
     * rule: the demotion exists only while the certain form is available.
     */
    it('buys the dried-shelf jar, not an uncategorised pot, for dried thyme', async () => {
        const m = await match('1 tsp dried thyme', 'en');
        expect(m.product?.name).toMatch(/čiobrel/i);
        expect(m.product?.categoryId).toBe(DRIED_SPICE_CAT);
        expect(m.product?.productId).not.toBe(ids.thymePot);
    });

    /**
     * The walk-down twin: the recipe NAMED the variant qualifier ("pusriebės
     * varškės"), and the bare-noun lead band still handed the win to a plain
     * branded curd 0.17 below it — the lead rule only knew the canonical
     * "Varškė". A leading qualifier the recipe itself asked for is not a
     * variant trap, so the semi-fat curd now keeps its honest 0.95.
     */
    it('lets the recipe\'s own qualifier win the bare-noun lead band', async () => {
        const m = await match('200 g pusriebės varškės');
        expect(m.product?.name).toMatch(/pusrieb/i);
        expect(m.product?.confidence ?? 0).toBeGreaterThanOrEqual(0.9);
    });

    /** The counter-case that bounds the stranger rule: when the WHOLE widened
     *  pool is strangers ("Džiovinti raudonėliai" — no spice jar prints
     *  "džiovinti"), they all move together and the best of them still wins,
     *  flagged for the qualifier the fallback dropped. */
    it('still lets an all-stranger fallback pool answer dried oregano', async () => {
        const m = await match('1 šaukštelis džiovintų raudonėlių');
        expect(m.product?.productId).toBe(ids.oreganoJar);
        expect(m.confident).toBe(false);
        expect(m.reviewReason).toBe('generic_fallback');
    });
});

/**
 * THE DRINKS AISLE, which was the least-covered category: every spirit below
 * produced NO query at all (`lexiconKey: null`) while the catalog stocked it —
 * the 'Likeris' category alone holds ~70 bottles. Coverage is asserted at the
 * lexicon layer (no DB): each phrase must resolve to its vetted entry, and
 * each entry's shopping name was verified against live listings (2026-07-27)
 * before it earned a row. No `weighable` on any of them — alcohol is bought by
 * the bottle, and the one-bottle arithmetic is pinned on the white-rum case
 * above.
 */
describe('the drinks lexicon reaches the shelf', () => {
    it('resolves every stocked spirit to its entry', () => {
        const owned: Array<[string, string]> = [
            ['triple sec', 'triple_sec'],
            ['dry vermouth', 'vermouth'],
            ['white rum', 'rum_white'],
            ['gin', 'gin'],
            ['tequila', 'tequila'],
            ['whiskey', 'whiskey'],
            ['bourbon', 'whiskey'],          // the Viskis shelf stocks bourbon
            ['prosecco', 'sparkling_wine'],
            ['aperol', 'aperol'],
            ['campari', 'campari'],
            ['amaretto', 'amaretto'],
            ['melon liqueur', 'melon_liqueur'],
            ['kahlua', 'coffee_liqueur'],
            ['coffee liqueur', 'coffee_liqueur'],
        ];
        for (const [phrase, key] of owned) {
            expect(findIngredient(phrase, 'en')?.info.key).toBe(key);
        }
    });

    /**
     * Verified ABSENT from the live catalog, so `notSold` — recognised and
     * left honestly unmatched rather than force-matched to whatever shares a
     * word: 'sour mix' names a bag of GUMMY CANDY, 'coconut' a liqueur that
     * is not a baking extract, and cassis's closest name hit is blackcurrant
     * vodka.
     */
    it('recognises the unstocked mixers and never shops for them', () => {
        for (const phrase of ['sweet-and-sour mix', 'coconut extract', 'creme de cassis', 'elderflower cordial']) {
            const hit = findIngredient(phrase, 'en');
            expect(hit?.info.notSold).toBe(true);
        }
    });
});

/**
 * JUDGED ROUND 7 — four defect classes from real recipe imports, each a
 * silent wrong purchase first:
 *   A. "lamb's lettuce" queried 'Aviena' (the 'lamb' window claimed a compound);
 *   B. baking parchment was matched and reached the basket;
 *   C. ricotta/mascarpone carried lexiconKey cheese_hard and bought Rokiškio;
 *   D. 'Žirnių dešrelės' (cat 107, plant-based) silently answered "4 dešrelės"
 *      and "breakfast sausage" at 0.97 — twice, in separate judged slices;
 *   E. 'Actas 9%' bought apple 6% instead of spirit 9%; 'coconut milk' bought
 *      the sweetened condensed tin instead of the Kokosų gėrimas shelf.
 */
describe('judged round 7: compounds, equipment, soft cheeses, substitutes, shelves', () => {
    it("buys a salad green for lamb's lettuce, never meat", async () => {
        const m = await match("100 g lamb's lettuce", 'en');
        expect(m.query).toBe('Sultenės');
        expect(m.product?.productId).toBe(ids.macheGreens);
    });

    it('never shops for baking parchment', async () => {
        const m = await match('1 lapas kepimo popieriaus');
        expect(m.ingredient.ignored).toBe(true);
        expect(m.product).toBeNull();
    });

    it('buys ricotta for ricotta cheese, not aged hard cheese', async () => {
        const m = await match('250 g ricotta cheese', 'en');
        expect(m.key).toBe('ricotta');
        expect(m.product?.productId).toBe(ids.ricotta);
    });

    it('buys mascarpone for mascarpone cheese', async () => {
        const m = await match('250 g mascarpone cheese', 'en');
        expect(m.key).toBe('mascarpone');
        expect(m.product?.productId).toBe(ids.mascarpone);
    });

    /** The substitute axis: a meat recipe with a real meat candidate on offer
     *  must not receive the imitation — demoted AND never silent. */
    it('buys a meat sausage, not the plant-based substitute, for plain dešrelės', async () => {
        const m = await match('4 dešrelės');
        expect(m.product?.productId).toBe(ids.meatSausages);
    });

    it('buys a meat sausage for breakfast sausage', async () => {
        const m = await match('1 lb breakfast sausage', 'en');
        expect(m.product?.productId).toBe(ids.meatSausages);
    });

    /** A demotion, never an exclusion: asked for by name, the substitute is
     *  still findable. */
    it('still offers the plant-based product when the recipe asks for it', async () => {
        const m = await match('200 g vegan sausages', 'en');
        const all = [m.product, ...m.alternatives].filter(Boolean).map(p => p!.productId);
        expect(all).toContain(ids.veganSausages);
    });

    it('buys 9% spirit vinegar, not apple cider, for bare acto', async () => {
        const m = await match('300 ml acto 9%');
        expect(m.query).toBe('Spirito actas');
        expect(m.product?.productId).toBe(ids.spiritVinegar);
        expect(m.product?.productId).not.toBe(ids.appleVinegar);
    });

    it('buys the kokosų gėrimas shelf product for coconut milk, never the condensed tin', async () => {
        const m = await match('400 ml coconut milk', 'en');
        expect(m.query).toBe('Kokosų gėrimas');
        expect(m.product?.productId).toBe(ids.coconutDrink);
        expect(m.product?.productId).not.toBe(ids.condensedCoconut);
    });
});

/**
 * JUDGED ROUND 8 — six defect classes from judged real imports, all silent
 * unless stated. The fixtures above are the exact real shapes: "Malti muskato
 * riešutai SAUDA" (28 g jars — "200 g maltų riešutų" bought SIX of them),
 * "Rudasis cukrus uogienėms ALVO" (preserving sugar, four rounds running),
 * "Čederio sūris BILLA" (a 200 g block bought for a SOUP), the salad mix that
 * was lexicon-keyed to shallot, and the SPRITE the „quotes“ hid from search.
 */
describe('judged round 8: dish heads, homonyms, purpose variants, named brands', () => {
    /** A. "cream of X" / "X soup" is a DISH — when no such soup is stocked,
     *  nothing is the right answer, never the modifier: cream for "cream of
     *  chicken", a cheese block for "cheddar cheese soup". */
    it('refuses to buy the modifier for a dish name', async () => {
        const cream = await match('1 can cream of chicken', 'en');
        expect(cream.key).toBeNull();
        expect(cream.product).toBeNull();
        const soup = await match('1 can cheddar cheese soup', 'en');
        expect(soup.key).toBeNull();
        expect(soup.product).toBeNull();
    });

    /** The dish guard must not eat the plain compound: cheese asked for AS
     *  cheese still buys the block. */
    it('still buys the cheddar block when the recipe asks for cheese', async () => {
        const m = await match('250 g cheddar cheese', 'en');
        expect(m.product?.productId).toBe(ids.cheddarBlock);
    });

    /** B. 'muskato riešutas' (nutmeg) literally contains 'riešutas' (nut) —
     *  the homonym rule reads the candidate through the lexicon and demotes a
     *  name whose every reading is a different ingredient. */
    it('buys nuts, not ground nutmeg, for maltų riešutų', async () => {
        const m = await match('200 g maltų riešutų');
        expect(m.product?.productId).toBe(ids.walnuts);
        expect(m.product?.productId).not.toBe(ids.nutmegJar);
    });

    it('nutmeg still wins when the recipe says muskato', async () => {
        const m = await match('1 šaukštelis maltų muskato riešutų');
        expect(m.product?.productId).toBe(ids.nutmegJar);
    });

    /** C. "uogienėms" is a purpose the recipe never asked for — the gelling
     *  jam sugar opens with the exact canonical name and outscored every
     *  branded plain bag until `purposed` started charging for it. */
    it('buys plain brown sugar, not the jam-sugar variant', async () => {
        const m = await match('200 g rudojo cukraus');
        expect(m.product?.productId).toBe(ids.brownSugar);
        expect(m.product?.productId).not.toBe(ids.jamSugar);
    });

    it('the jam sugar is still findable when the recipe asks for it', async () => {
        const m = await match('1 kg cukraus uogienėms');
        expect(m.product?.productId).toBe(ids.jamSugar);
    });

    /** D. "salotų mišinys" was lexicon-keyed to SHALLOT (folded 'šalot-' ≡
     *  'salot-') and bought Valgomieji svogūnėliai at 1.00, twice. */
    it('salotų mišinys buys a salad mix, never shallots', async () => {
        const m = await match('100 g salotų mišinio');
        expect(m.key).toBe('salad_mix');
        expect(m.product?.productId).toBe(ids.saladMix);
    });

    /** F. An explicitly named brand is never swapped for a competitor — the
     *  „quotes“ used to hide 'Sprite' from the SQL search, and the head-noun
     *  fallback then widened onto the bare form noun 'gėrimas'. */
    it('a named brand is never swapped for a competitor', async () => {
        const m = await match('„Sprite" gėrimas');
        expect(m.product?.productId).toBe(ids.sprite);
    });

    /** F. Ice is tap water in another shape — 'ledo gabaliukai' joins ledukai
     *  and ledo kubeliai in NEVER_BOUGHT instead of falling through to the
     *  'led-' stem, which means ICE CREAM. */
    it('ignores ledo gabaliukai instead of buying ice cream', async () => {
        const m = await match('Ledo gabaliukai');
        expect(m.ingredient.ignored).toBe(true);
        expect(m.product).toBeNull();
    });
});

/**
 * JUDGED ROUND 9 — over 212 decisions from 24 unseen recipes, 11 of 13 silent
 * errors shared ONE root cause: a qualifier dropped in the lexicon hop, or a
 * lexicon entry hit on a SUBSTRING of a token. All at 0.94–1.00 confidence,
 * so no threshold could catch them — the fixes are whole-token lookup
 * (measure.ts) and entries that keep the qualifier in the query.
 */
describe('judged round 9: dropped qualifiers and substring hits', () => {
    /** "McCormick's Montreal BRAND steak seasoning" bought Brendis TORRES —
     *  a SPIRIT for a spice rub — because 'Brand' matched inside 'brandy'
     *  via the stemmer ('brandy' sheds its 'y' as a Lithuanian case ending).
     *  The stemmed map is LT-only now, and the phrase has a real owner. */
    it('a steak rub is a spice mix, never brandy', async () => {
        const m = await match("1 tbsp McCormick's Montreal Brand steak seasoning", 'en');
        expect(m.key).toBe('steak_seasoning');
        expect(m.product?.productId).toBe(ids.steakSeasoning);
    });

    /** 'tamarind paste' bought Makaronai TAGLIATELLE: 'paste' and 'pasta'
     *  collide at the stem 'past'. Whole-token lookup returns the honest
     *  answer — the catalog stocks no tamarind paste, so nothing. */
    it('tamarind paste never buys pasta', async () => {
        const m = await match('2 tbsp tamarind paste', 'en');
        expect(m.key).toBeNull();
        expect(m.product).toBeNull();
    });

    /** 'red lentils' resolved to the generic entry, whose bare 'Lęšiai'
     *  query bought the BROWN bag. The red forms own an entry now. */
    it('red lentils buy the red bag, plain lentils the plain one', async () => {
        const red = await match('200 g red lentils', 'en');
        expect(red.key).toBe('lentils_red');
        expect(red.product?.productId).toBe(ids.redLentils);
        const plain = await match('200 g lentils', 'en');
        expect(plain.product?.productId).toBe(ids.brownLentils);
    });

    /** 'sodos vandens' fell through to the bare 'sodos' window and bought
     *  BAKING SODA for a highball; the two-word phrase owns an entry. */
    it('sodos vanduo is carbonated water, never baking soda', async () => {
        const m = await match('100 ml sodos vandens');
        expect(m.key).toBe('soda_water');
        expect(m.product?.productId).toBe(ids.sparklingWater);
        // The bare noun still belongs to the cupboard box.
        const soda = await match('1 a.š. kepimo sodos');
        expect(soda.key).toBe('baking_soda');
    });

    /** The bare 'Cukraus sirupas' query fully matched "Sirupas TEISSEIRE,
     *  karamelės skonio, BE CUKRAUS" — sugar-free caramel syrup carrying
     *  both query words. The shelf's own qualifier keeps the impostor out. */
    it('simple syrup buys the light sugar syrup, not a sugar-free flavour', async () => {
        const m = await match('20 ml simple syrup', 'en');
        expect(m.key).toBe('sugar_syrup');
        expect(m.product?.productId).toBe(ids.lightSyrup);
    });

    /** "Putojantis vynas (pvz. Prosecco)" — the parenthetical exemplar used
     *  to be discarded before search, and a sweet ALITA beat the dry
     *  Prosecco the recipe literally named. The hint now rides the query
     *  and is preferred at acceptance. */
    it('a parenthetical exemplar picks the bottle the recipe named', async () => {
        const m = await match('200 ml putojančio vyno (pvz. Prosecco)');
        expect(m.key).toBe('sparkling_wine');
        expect(m.product?.productId).toBe(ids.prosecco);
    });

    /** The Angostura BRAND also sells rum, whose short name outscored the
     *  bitters bottle — 'bitter' is the label's own word and the query
     *  carries it. */
    it('angostura bitters buy the bitters, not the rum', async () => {
        const m = await match('2 dashes Angostura Bitters', 'en');
        expect(m.key).toBe('bitters');
        expect(m.product?.productId).toBe(ids.angosturaBitters);
        expect(m.product?.productId).not.toBe(ids.angosturaRum);
    });

    /** Bare 'Ledas' / '200 g ledo' — the SINGULAR is ice, and ice is tap
     *  water in another shape, like the 'ledukai' this list already pins.
     *  The plural 'ledai' really is ice cream and must stay matchable. */
    it('ledas and ledo are ignored ice, not ice cream', async () => {
        for (const line of ['Ledas', '200 g ledo']) {
            const m = await match(line);
            expect(m.ingredient.ignored).toBe(true);
            expect(m.product).toBeNull();
        }
        const iceCream = await match('200 g ledų');
        expect(iceCream.ingredient.ignored).toBe(false);
        expect(iceCream.key).toBe('ice_cream');
    });
});
