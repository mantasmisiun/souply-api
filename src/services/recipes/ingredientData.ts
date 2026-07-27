/**
 * INGREDIENT KNOWLEDGE BASE — the table that makes a recipe shoppable.
 *
 * Three jobs, all driven by this data:
 *   (a) density   — "3 šaukštai karį"  → ≈21 g curry powder   (gramsPerMl)
 *   (b) piece     — "2 vidutinio dydžio svogūnų" → ≈300 g     (gramsPerPiece)
 *   (c) pantry    — strike salt/pepper/oil in one glance      (pantry)
 * Plus translation: there is no translation API in this project — `ltName`
 * IS the translator that lets an English recipe hit the Lithuanian catalog.
 *
 * SURFACE-FORM OWNERSHIP RULES (hard rules, the index throws on violation):
 *   - Every form (either language) is claimed by exactly ONE entry.
 *   - A bare generic token belongs to the entry a shopper means by default:
 *     'miltų' → wheat flour, 'pipirų' → black pepper, 'aliejaus' → cooking
 *     oil, 'cukraus' → white sugar, 'šokolado' → dark chocolate. Everything
 *     more specific must stay multi-word ('pieno šokoladas', 'žemės riešutų
 *     sviestas', 'alyvuogių aliejus') so the generic owner is never robbed
 *     and no generic form swallows a specific product.
 *   - If two entries would genuinely want the same string, the string is too
 *     vague for both and is registered for neither (e.g. bare 'kruopos').
 *
 * LT forms are LOWERCASE and diacritic-bearing, and include the GENITIVE
 * forms recipes actually print ('kvietinių miltų', 'grietinės', 'svogūnų') —
 * a nominative-only table would match almost nothing.
 *
 * Densities: when unsure, the field is OMITTED — an unconvertible amount is
 * honest; a fabricated one silently corrupts the shopping list.
 */

import type { IngredientInfo } from './types.js';

export const INGREDIENTS: readonly IngredientInfo[] = [
    // ── DAIRY & EGGS ────────────────────────────────────────────────────────
    {
        key: 'milk',
        ltName: 'Pienas',
        enName: 'milk',
        lt: ['pienas', 'pieno'],
        en: ['milk', 'whole milk', 'full-fat milk', 'full fat milk'],
        gramsPerMl: 1.03,
        pantry: false, // perishable — actually bought
    },
    {
        key: 'milk_condensed',
        ltName: 'Sutirštintas pienas',
        enName: 'condensed milk',
        lt: ['sutirštintas pienas', 'sutirštinto pieno'],
        en: ['condensed milk', 'sweetened condensed milk'],
        gramsPerMl: 1.3, // very sugar-dense — noticeably heavier than milk
        pantry: false,
    },
    {
        key: 'milk_evaporated',
        ltName: 'Garintas pienas',
        enName: 'evaporated milk',
        lt: ['garintas pienas', 'garinto pieno'],
        en: ['evaporated milk'],
        gramsPerMl: 1.07,
        pantry: false,
    },
    {
        key: 'buttermilk',
        ltName: 'Pasukos',
        enName: 'buttermilk',
        lt: ['pasukos', 'pasukų'],
        en: ['buttermilk'],
        gramsPerMl: 1.03,
        pantry: false,
    },
    {
        key: 'kefir',
        ltName: 'Kefyras',
        enName: 'kefir',
        lt: ['kefyras', 'kefyro'],
        en: ['kefir'],
        gramsPerMl: 1.03,
        pantry: false,
    },
    {
        key: 'cream_heavy',
        ltName: 'Grietinėlė',
        enName: 'heavy cream',
        // 'plakamoji' is the LT label for whipping cream — the 35 % carton IS
        // it, and without the form the word read as silently dropped and sent
        // every correct "plakamosios grietinėlės" match to review.
        lt: ['grietinėlė', 'grietinėlės', 'plakamoji grietinėlė', 'plakamosios grietinėlės'],
        en: ['cream', 'heavy cream', 'whipping cream', 'heavy whipping cream', 'thickened cream', 'double cream', 'pouring cream'],
        gramsPerMl: 0.99,
        pantry: false,
    },
    {
        key: 'sour_cream',
        // Also owns 'crème fraîche': the catalog stocks none under that name
        // (verified, 0 live products) and grietinė is the same ~30% cultured
        // cream — the honest shelf equivalent, not a guess.
        ltName: 'Grietinė',
        enName: 'sour cream',
        lt: ['grietinė', 'grietinės', 'riebi grietinė', 'riebios grietinės'],
        en: ['sour cream', 'soured cream', 'crème fraîche', 'creme fraiche'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'yogurt',
        ltName: 'Natūralus jogurtas',
        enName: 'yogurt',
        lt: ['jogurtas', 'jogurto', 'natūralus jogurtas', 'natūralaus jogurto'],
        en: ['yogurt', 'yoghurt', 'plain yogurt', 'plain yoghurt', 'natural yogurt'],
        gramsPerMl: 1.03,
        pantry: false,
    },
    {
        key: 'yogurt_greek',
        ltName: 'Graikiškas jogurtas',
        enName: 'greek yogurt',
        lt: ['graikiškas jogurtas', 'graikiško jogurto'],
        en: ['greek yogurt', 'greek yoghurt'],
        gramsPerMl: 1.05, // strained — denser than plain yogurt
        pantry: false,
    },
    {
        key: 'butter',
        ltName: 'Sviestas',
        enName: 'butter',
        lt: ['sviestas', 'sviesto', 'minkštas sviestas', 'minkšto sviesto'],
        en: ['butter', 'unsalted butter', 'salted butter'],
        gramsPerMl: 0.91,
        pantry: false, // perishable — actually bought
    },
    {
        key: 'margarine',
        ltName: 'Margarinas',
        enName: 'margarine',
        lt: ['margarinas', 'margarino'],
        en: ['margarine'],
        gramsPerMl: 0.91,
        pantry: false,
    },
    {
        key: 'curd',
        ltName: 'Varškė',
        enName: 'curd',
        lt: ['varškė', 'varškės', 'riebi varškė', 'riebios varškės', 'rupi varškė', 'rupios varškės'],
        en: ['curd', 'quark', 'cottage cheese', 'farmer cheese'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'curd_snack',
        ltName: 'Sūreliai',
        enName: 'glazed curd snack',
        lt: ['sūrelis', 'sūreliai', 'sūrelių', 'glaistytas sūrelis', 'glaistyti sūreliai'],
        en: ['glazed curd snack', 'curd snack'],
        pantry: false,
    },
    {
        key: 'cheese_curd',
        ltName: 'Varškės sūris',
        enName: 'curd cheese',
        lt: ['varškės sūris', 'varškės sūrio'],
        en: ['curd cheese', 'white cheese'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'cheese_hard',
        ltName: 'Fermentinis sūris',
        enName: 'hard cheese',
        lt: ['sūris', 'sūrio', 'fermentinis sūris', 'fermentinio sūrio', 'kietasis sūris', 'kietojo sūrio', 'tarkuotas sūris', 'tarkuoto sūrio'],
        en: ['cheese', 'hard cheese', 'grated cheese', 'shredded cheese'],
        gramsPerMl: 0.4, // GRATED — a cup of shreds is mostly air
        pantry: false,
        weighable: true,
    },
    {
        key: 'parmesan',
        // Lithuanians say "parmezanas", but no shop labels it that way — the
        // shelf says PARMIGIANO REGGIANO, so searching for "Parmezanas" found
        // nothing at all. The shopping name has to be the shop's name.
        ltName: 'Sūris Parmigiano Reggiano',
        enName: 'parmesan',
        lt: ['parmezanas', 'parmezano', 'parmigiano reggiano', 'parmigiano'],
        en: ['parmesan', 'parmesan cheese', 'grated parmesan', 'grated parmesan cheese'],
        gramsPerMl: 0.4, // grated
        pantry: false,
    },
    {
        key: 'mozzarella',
        ltName: 'Mocarela',
        enName: 'mozzarella',
        lt: ['mocarela', 'mocarelos', 'mocarelos sūris', 'mocarelos sūrio'],
        en: ['mozzarella', 'shredded mozzarella', 'mozzarella cheese'],
        gramsPerMl: 0.45, // shredded
        pantry: false,
    },
    {
        key: 'cheddar',
        ltName: 'Čederio sūris',
        enName: 'cheddar',
        lt: ['čederis', 'čederio', 'čederio sūris', 'čederio sūrio'],
        en: ['cheddar', 'cheddar cheese', 'sharp cheddar cheese', 'shredded cheddar'],
        gramsPerMl: 0.4, // shredded
        pantry: false,
    },
    {
        key: 'feta',
        ltName: 'Fetos sūris',
        enName: 'feta',
        lt: ['feta', 'fetos', 'fetos sūris', 'fetos sūrio'],
        en: ['feta', 'feta cheese', 'crumbled feta'],
        gramsPerMl: 0.6, // crumbled — chunks pack loosely
        pantry: false,
    },
    {
        key: 'halloumi',
        ltName: 'Haliumio sūris',
        enName: 'halloumi',
        lt: ['haliumis', 'haliumio', 'haliumio sūris', 'haliumio sūrio'],
        en: ['halloumi', 'halloumi cheese'],
        gramsPerMl: 0.45, // shredded (RecipeTin fritters style)
        pantry: false,
    },
    {
        key: 'cream_cheese',
        // 'Tepamasis sūris' is the Philadelphia shelf's own head ("Tepamasis
        // sūris PHILADELPHIA ORIGINAL", ids 832/837 + 10 more variants,
        // verified on cat 52). The old name 'Tepamas sūrelis' was the
        // DIMINUTIVE, which is the savoury-spread shape — it bought "RAMBYNO
        // tepamasis sūrelis" (a melted-cheese spread) at 0.89 for a
        // cheesecake's cream cheese.
        ltName: 'Tepamasis sūris',
        enName: 'cream cheese',
        // 'grietinėlės sūris' is the literal LT calque for cream cheese and
        // 'Filadelfijos sūris' is the brand used generically — without them a
        // recipe's cream cheese bought a carton of grietinėlė instead.
        lt: ['tepamas sūrelis', 'tepamo sūrelio', 'kreminis sūris', 'kreminio sūrio', 'tepamas sūris', 'tepamo sūrio',
            'tepamasis sūris', 'tepamojo sūrio',
            'grietinėlės sūris', 'grietinėlės sūrio', 'filadelfijos sūris', 'filadelfijos sūrio'],
        en: ['cream cheese'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'cheese_processed',
        // Lydytas sūris is its own shelf (cat 52, 40 live products: 'Lydytas
        // tepamasis sūris FARM MILK', 'Tepamasis lydytas sūrelis ROKIŠKIO
        // GRAND'). Without the entry 'lydyto sūrio' fell through to the bare
        // 'sūrio' form and bought fermentinis — a different product; the entry
        // is also what makes it safe to treat 'lydyt' as a cook's action
        // (melted butter/chocolate) in the dropped-word guard.
        ltName: 'Lydytas sūris',
        enName: 'processed cheese',
        lt: ['lydytas sūris', 'lydyto sūrio', 'lydytas sūrelis', 'lydyto sūrelio', 'lydyti sūreliai', 'lydytų sūrelių'],
        en: ['processed cheese'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'egg',
        ltName: 'Kiaušiniai',
        enName: 'eggs',
        // 'vištienos kiaušinis' (a chicken egg) MUST be a form: leftmost-wins
        // matching otherwise stopped on the 1-word 'vištienos' window and the
        // chicken entry bought a WHOLE BROILER for "2 vnt. Vištienos
        // kiaušinis" — 7 times in one 180-recipe sweep.
        lt: ['kiaušinis', 'kiaušiniai', 'kiaušinio', 'kiaušinių',
            'vištienos kiaušinis', 'vištienos kiaušiniai', 'vištienos kiaušinių', 'vištų kiaušiniai', 'vištų kiaušinių'],
        en: ['egg', 'eggs', 'large egg', 'large eggs', 'beaten egg'],
        gramsPerPiece: 55, // medium egg without shell ≈ edible weight of an M egg
        pantry: false, // perishable — actually bought
    },
    {
        key: 'egg_yolk',
        // Bought as whole eggs — the shopping name stays "Kiaušiniai".
        ltName: 'Kiaušiniai',
        enName: 'egg yolks',
        // The SINGULAR genitive pair is spelled out because the blunt stemmer
        // cannot collapse it into the plural forms ('kiaušinio' stems to
        // 'kiausini', 'kiaušinių' to 'kiausin') — so "kiaušinio trynio" missed
        // this entry and landed on plain eggs with a dropped-word flag.
        lt: ['trynys', 'tryniai', 'trynio', 'trynių', 'kiaušinių tryniai', 'kiaušinių trynių',
            'kiaušinio trynys', 'kiaušinio trynio'],
        en: ['egg yolk', 'egg yolks', 'yolk', 'yolks'],
        gramsPerPiece: 18, // yolk of an M/L egg
        pantry: false,
    },
    {
        key: 'egg_white',
        // Bought as whole eggs, like the yolk entry. Bare 'baltymai' is NOT
        // registered here or anywhere: LT baking says 'baltymai' for egg
        // whites while fitness recipes mean protein powder — ambiguous for
        // both, so both entries keep only their qualified forms.
        ltName: 'Kiaušiniai',
        enName: 'egg whites',
        lt: ['kiaušinių baltymai', 'kiaušinių baltymų', 'kiaušinio baltymas', 'kiaušinio baltymo'],
        en: ['egg white', 'egg whites'],
        gramsPerPiece: 33, // white of an M/L egg
        pantry: false,
    },
    {
        key: 'tofu',
        ltName: 'Tofu',
        enName: 'tofu',
        lt: ['tofu', 'tofu sūris', 'tofu sūrio'],
        en: ['tofu', 'silken tofu', 'firm tofu'],
        gramsPerMl: 1.0,
        pantry: false,
    },

    // ── MEAT, FISH & BROTH ─────────────────────────────────────────────────
    {
        key: 'chicken',
        // The fresh-chicken shelf barely uses the word a recipe uses: of the
        // ~80 products in the chicken category only 6 say 'vištien...' — the
        // shelf says 'viščiukas broileris' ('Šviežias viščiukas broileris
        // WELL DONE'; 135 'viščiuk' / 104 'broiler' live products, verified).
        // Searching 'Vištiena' finds pet food, stock cubes and vegan
        // imitations instead of the actual bird.
        ltName: 'Viščiukas broileris',
        enName: 'chicken',
        lt: ['vištiena', 'vištienos', 'viščiukas', 'viščiuko', 'viščiukai', 'viščiukų',
            'broileris', 'broilerio', 'viščiukas broileris', 'viščiukų broilerių'],
        en: ['chicken', 'whole chicken'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'chicken_breast',
        // Same shelf-lemma problem as 'chicken': the products are literally
        // 'Šviežia viščiukų broilerių filė', not 'Vištienos filė'.
        ltName: 'Viščiukų broilerių filė',
        enName: 'chicken breast',
        lt: ['vištienos filė', 'vištienos krūtinėlė', 'vištienos krūtinėlės', 'vištienos krūtinėlių',
            'viščiukų broilerių filė', 'broilerių filė'],
        en: ['chicken breast', 'chicken breasts', 'boneless skinless chicken breast', 'boneless skinless chicken breasts', 'chicken breast halves'],
        gramsPerPiece: 280, // one boneless fillet as sold in LT
        pantry: false,
        weighable: true,
    },
    {
        key: 'chicken_thigh',
        // Shelf: 'Šv. viščiukų broil. šlaunelių mėsa ... WELL DONE' (verified).
        ltName: 'Viščiukų broilerių šlaunelės',
        enName: 'chicken thighs',
        lt: ['vištienos šlaunelės', 'vištienos šlaunelių', 'vištienos šlaunelė',
            'viščiukų broilerių šlaunelės', 'viščiukų broilerių šlaunelių',
            // '…šlaunelių mėsa' is how recipes ask for the boneless meat — the
            // shelf name above even says so, and without the form the word
            // 'mėsos' read as dropped on every correct match.
            'vištienos šlaunelių mėsa', 'vištienos šlaunelių mėsos',
            'viščiukų broilerių šlaunelių mėsa', 'viščiukų broilerių šlaunelių mėsos'],
        en: ['chicken thigh', 'chicken thighs', 'boneless skinless chicken thighs'],
        gramsPerPiece: 120, // boneless, skinless
        pantry: false,
        weighable: true,
    },
    {
        key: 'chicken_drumstick',
        // Shelf: 'Šviežios viščiukų broilerių blauzdelės WELL DONE' (verified).
        ltName: 'Viščiukų broilerių blauzdelės',
        enName: 'chicken drumsticks',
        lt: ['vištienos blauzdelės', 'vištienos blauzdelių', 'vištienos blauzdelė',
            'viščiukų broilerių blauzdelės', 'viščiukų broilerių blauzdelių'],
        en: ['chicken drumstick', 'chicken drumsticks'],
        gramsPerPiece: 120, // bone-in
        pantry: false,
        weighable: true,
    },
    {
        key: 'chicken_liver',
        ltName: 'Vištienos kepenėlės',
        enName: 'chicken livers',
        lt: ['vištienos kepenėlės', 'vištienos kepenėlių', 'vištų kepenėlės'],
        en: ['chicken liver', 'chicken livers'],
        pantry: false,
    },
    {
        key: 'mince_chicken',
        ltName: 'Vištienos faršas',
        enName: 'ground chicken',
        lt: ['vištienos faršas', 'vištienos faršo', 'malta vištiena', 'maltos vištienos'],
        en: ['ground chicken', 'chicken mince', 'minced chicken'],
        gramsPerMl: 1.0,
        pantry: false,
        weighable: true,
    },
    {
        key: 'beef',
        // 312 live 'jautien' products — the stem is fine as a query. The extra
        // forms cover real beef the catalog names WITHOUT it: 'Galvijų uodega
        // KREKENAVOS', 'Jaučio žandai vakume BILLA PREMIUM' (verified).
        ltName: 'Jautiena',
        enName: 'beef',
        lt: ['jautiena', 'jautienos', 'galvijiena', 'galvijienos',
            'galvijų mėsa', 'galvijų mėsos', 'jaučio mėsa', 'jaučio mėsos'],
        en: ['beef', 'beef roast'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'braising_steak',
        // Its own entry (not plain 'beef'): a stew recipe means a slow-cook
        // cut, and the catalog names it — 'Br. jautiena troškinimui FEEL THE
        // BEEF' (verified). 'stew meat' moved here from the generic beef entry.
        ltName: 'Jautiena troškinimui',
        enName: 'braising beef',
        lt: ['jautiena troškinimui', 'jautienos troškinimui'],
        en: ['braising steak', 'braising beef', 'stewing beef', 'beef stew meat', 'stew meat',
            'chuck beef', 'beef chuck', 'chuck roast', 'gravy beef'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'mince_beef',
        // The fresh counter says 'Šviežia smulkinta jautiena' (3+ live
        // products, verified); 'Jautienos faršas' as a literal name does not
        // appear on the beef shelf.
        ltName: 'Smulkinta jautiena',
        enName: 'ground beef',
        lt: ['jautienos faršas', 'jautienos faršo', 'malta jautiena', 'maltos jautienos',
            'smulkinta jautiena', 'smulkintos jautienos'],
        en: ['ground beef', 'beef mince', 'minced beef'],
        gramsPerMl: 1.0,
        pantry: false,
        weighable: true,
    },
    {
        key: 'pork',
        ltName: 'Kiauliena',
        enName: 'pork',
        lt: ['kiauliena', 'kiaulienos', 'šviežia kiauliena', 'šviežios kiaulienos'],
        // 'pork belly' lives on the pork_belly entry — it names a cut.
        en: ['pork', 'pork shoulder'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'mince_pork',
        ltName: 'Kiaulienos faršas',
        enName: 'ground pork',
        lt: ['kiaulienos faršas', 'kiaulienos faršo', 'malta kiauliena', 'maltos kiaulienos',
            'smulkinta kiauliena', 'smulkintos kiaulienos'],
        en: ['ground pork', 'pork mince', 'minced pork', 'pork belly mince'],
        gramsPerMl: 1.0,
        pantry: false,
        weighable: true,
    },
    {
        key: 'mince',
        // A bare 'Faršas' query top-ranks SOY mince ('Sojų faršas BONA VITA');
        // the unqualified mixed mince a generic recipe means is literally
        // 'Atšaldyta smulkinta kiauliena ir jautiena, 1 kg' (verified).
        ltName: 'Smulkinta kiauliena ir jautiena',
        enName: 'ground meat',
        lt: ['faršas', 'faršo', 'malta mėsa', 'maltos mėsos', 'mėsos faršas', 'mėsos faršo',
            'smulkinta mėsa', 'smulkintos mėsos', 'smulkinta kiauliena ir jautiena'],
        en: ['ground meat', 'mince', 'minced meat'],
        gramsPerMl: 1.0,
        pantry: false,
        weighable: true,
    },
    {
        key: 'lamb',
        ltName: 'Aviena',
        enName: 'lamb',
        lt: ['aviena', 'avienos', 'ėriena', 'ėrienos'],
        en: ['lamb', 'lamb shoulder', 'boneless lamb shoulder'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'turkey',
        ltName: 'Kalakutiena',
        // The fresh shelf says "kalakutų" and "kalakutienos filė", never the
        // bare nominative — searching "Kalakutiena" returned tinned turkey,
        // pilaf and ravioli, and not one piece of fresh meat.
        aliases: ['Kalakutienos filė', 'Kalakutų krūtinėlė'],
        enName: 'turkey',
        lt: ['kalakutiena', 'kalakutienos'],
        en: ['turkey'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'turkey_ground',
        // MINCE IS ITS OWN PRODUCT and its own WORD. Searching "Kalakutiena"
        // never reaches "Kalakutienos faršas" — a different case ending — and
        // of the 50 rows that query does return, not one is mince: it is tinned
        // turkey, pilaf, ravioli and a long tail of dog food. "2 lb ground
        // turkey" duly bought frozen turkey DOG FOOD, then a tin.
        ltName: 'Kalakutienos faršas',
        enName: 'ground turkey',
        lt: ['kalakutienos faršas', 'kalakutienos faršo', 'malta kalakutiena', 'maltos kalakutienos'],
        en: ['ground turkey', 'turkey mince', 'minced turkey', 'lean ground turkey'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'sausages',
        ltName: 'Dešrelės',
        enName: 'sausages',
        lt: ['dešrelės', 'dešrelių', 'dešrelė'],
        en: ['sausage', 'sausages', 'italian sausage', 'bulk italian sausage'],
        gramsPerPiece: 60,
        pantry: false,
    },
    {
        key: 'bratwurst',
        // The grilling-sausage shelf: 'Kepamosios dešrelės BRATWURST, a. r.'
        // (verified). No piece weight — packs range widely.
        ltName: 'Kepamosios dešrelės',
        enName: 'bratwurst',
        lt: ['kepamosios dešrelės', 'kepamųjų dešrelių', 'bratvurstas', 'bratvursto', 'bratvurstai', 'bratvurstų'],
        en: ['bratwurst', 'bratwursts', 'bratwurst sausages'],
        pantry: false,
    },
    {
        key: 'sausage_cured',
        ltName: 'Dešra',
        enName: 'cured sausage',
        lt: ['dešra', 'dešros', 'rūkyta dešra', 'rūkytos dešros', 'virta dešra', 'virtos dešros'],
        en: ['cured sausage', 'smoked sausage', 'kielbasa'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'ham',
        ltName: 'Kumpis',
        enName: 'ham',
        lt: ['kumpis', 'kumpio', 'virtas kumpis', 'virto kumpio'],
        en: ['ham'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'bacon',
        // EN "bacon" means CURED, always — but the Lithuanian word 'šoninė' is
        // BOTH the raw belly cut and the word for bacon, and a bare "Šoninė"
        // query ranked "Lietuviška kiaulienos šoninė" (RAW belly, cat 99) over
        // the 30+ cured SKUs on 127 'Šoninė ir lašiniai' — so "bacon lardons"
        // silently bought raw pork belly at 0.75. Naming the preparation in
        // ltName is what fixes the ranking: 'rūkyt' makes the query PREPARED,
        // so the cured shelf stops being demoted AND the raw cut fails
        // acceptance (no 'rūkyt' in its name). The alias reaches the
        // cold-smoked spelling the shelf actually prints ("Šaltai rūkytos
        // šoninės kubeliai", PANCETTA AFFUMICATA — ids 2287/2288, verified).
        ltName: 'Rūkyta šoninė',
        aliases: ['Šaltai rūkyta šoninė'],
        enName: 'bacon',
        lt: ['rūkyta šoninė', 'rūkytos šoninės', 'karštai rūkyta šoninė', 'karštai rūkytos šoninės',
            'šaltai rūkyta šoninė', 'šaltai rūkytos šoninės'],
        en: ['bacon', 'smoked bacon', 'bacon rashers', 'lardons', 'bacon lardons', 'streaky bacon'],
        pantry: false,
    },
    {
        key: 'pork_belly',
        // The OTHER meaning of the bare word: a Lithuanian recipe saying
        // 'šoninės' may genuinely mean the fresh cut (šašlykai, oven belly),
        // so the bare forms keep the plain query rather than inheriting the
        // cured one — and the silent gate asks anyway when a species-ambiguous
        // pick wins on a soft score. 'pork belly' moved here from the generic
        // pork entry: it names this cut, not the shoulder.
        ltName: 'Šoninė',
        enName: 'pork belly',
        lt: ['šoninė', 'šoninės', 'kiaulienos šoninė', 'kiaulienos šoninės'],
        en: ['pork belly'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'fish',
        ltName: 'Žuvis',
        enName: 'fish',
        lt: ['žuvis', 'žuvies', 'žuvies filė', 'baltos žuvies'],
        en: ['fish', 'white fish', 'fish fillet', 'fish fillets'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'dorada',
        // The fresh-fish shelf sells it under the full 'auksaspalvės dorados'
        // ('Šviežios auksaspalvės dorados, skrostos', cat 109; plus five more
        // live listings — verified 2026-07-27), recipes just say 'dorada'.
        ltName: 'Dorados',
        enName: 'sea bream',
        lt: ['dorada', 'dorados', 'auksaspalvė dorada', 'auksaspalvės dorados'],
        en: ['sea bream', 'gilthead bream', 'dorada', 'dorade'],
        gramsPerPiece: 400, // one whole retail fish, gutted
        pantry: false,
        weighable: true,
    },
    {
        key: 'salmon',
        // The FRESH aisle spells it "Šviežia atlantinių lašišų filė" — plural
        // genitive, never the bare nominative — so "Lašiša" alone returned the
        // processed shelf ("Lašiša aliejuje", a tin) and the entire fresh-fish
        // counter went unvisited.
        ltName: 'Lašiša',
        aliases: ['Lašišos filė', 'Atlantinių lašišų filė'],
        enName: 'salmon',
        lt: ['lašiša', 'lašišos', 'lašišos filė'],
        en: ['salmon', 'salmon fillet', 'salmon fillets'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'herring',
        ltName: 'Silkė',
        enName: 'herring',
        lt: ['silkė', 'silkės', 'silkių', 'silkės filė'],
        en: ['herring', 'herring fillets'],
        pantry: false,
    },
    {
        key: 'anchovy',
        // Shelf: 'Ančiuvių filė SUN&SEA saulėgrąžų aliejuje' (verified).
        ltName: 'Ančiuvių filė',
        enName: 'anchovies',
        lt: ['ančiuviai', 'ančiuvių', 'ančiuvių filė'],
        en: ['anchovy', 'anchovies', 'anchovy fillets', 'anchovy fillet'],
        gramsPerPiece: 4, // one fillet
        pantry: false,
    },
    {
        key: 'tilapia',
        // Shelf: 'Nil. tilapijos filė RIMI, be od., be k.' (verified).
        ltName: 'Tilapijų filė',
        enName: 'tilapia',
        lt: ['tilapija', 'tilapijos', 'tilapijų', 'tilapijų filė', 'tilapijos filė'],
        en: ['tilapia', 'tilapia fillets', 'tilapia fillet'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'mussels',
        // Shelf: 'Šaldytos midijos WELL DONE su kiautais' (verified).
        ltName: 'Midijos',
        enName: 'mussels',
        lt: ['midijos', 'midijų', 'midijų mėsa', 'midijų mėsos'],
        en: ['mussels', 'mussel'],
        pantry: false,
    },
    {
        key: 'clams',
        // Shelf: 'Jūros moliuskai sūryme VIČI' (verified) — 'geldutės' is the
        // recipe word, 'moliuskai' the shelf word.
        ltName: 'Jūros moliuskai',
        enName: 'clams',
        lt: ['jūros moliuskai', 'jūros moliuskų', 'moliuskai', 'moliuskų', 'geldutės', 'geldučių'],
        en: ['clams', 'clam', 'vongole'],
        pantry: false,
    },
    {
        key: 'squid',
        // Shelf: 'Karštai rūkyti trumpapelekiai kalmarai' etc. (verified).
        ltName: 'Kalmarai',
        enName: 'squid',
        lt: ['kalmarai', 'kalmarų', 'kalmaras', 'kalmarų žiedai', 'kalmarų žiedų'],
        en: ['squid', 'calamari', 'squid rings'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'shrimp',
        ltName: 'Krevetės',
        enName: 'shrimp',
        lt: ['krevetės', 'krevečių', 'krevetė'],
        en: ['shrimp', 'prawns', 'shrimps'],
        pantry: false,
    },
    {
        key: 'tuna_canned',
        ltName: 'Konservuotas tunas',
        enName: 'canned tuna',
        lt: ['konservuotas tunas', 'konservuoto tuno', 'tunas', 'tuno'],
        en: ['canned tuna', 'tuna', 'tinned tuna'],
        pantry: false,
    },
    {
        key: 'broth',
        ltName: 'Sultinys',
        enName: 'broth',
        lt: ['sultinys', 'sultinio', 'naminis sultinys', 'naminio sultinio'],
        en: ['broth', 'stock'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'broth_chicken',
        ltName: 'Vištienos sultinys',
        enName: 'chicken broth',
        lt: ['vištienos sultinys', 'vištienos sultinio'],
        en: ['chicken broth', 'chicken stock'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'broth_beef',
        ltName: 'Jautienos sultinys',
        enName: 'beef broth',
        lt: ['jautienos sultinys', 'jautienos sultinio'],
        en: ['beef broth', 'beef stock'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'broth_vegetable',
        ltName: 'Daržovių sultinys',
        enName: 'vegetable broth',
        lt: ['daržovių sultinys', 'daržovių sultinio'],
        en: ['vegetable broth', 'vegetable stock'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'cranberry_sauce',
        // The head noun is SAUCE. Without this the lexicon kept only the fruit
        // and 100 g of cranberry sauce became a bag of DRIED cranberries,
        // silently, at 0.97.
        ltName: 'Spanguolių uogienė',
        enName: 'cranberry sauce',
        lt: ['spanguolių uogienė', 'spanguolių uogienės', 'spanguolių padažas', 'spanguolių padažo'],
        en: ['cranberry sauce', 'cranberry jelly'],
        gramsPerMl: 1.3,
        pantry: false,
    },
    {
        key: 'broth_fish',
        // Without this the head noun was lost and only "fish" survived, so
        // "500 ml fish stock" searched for FISH — and bought a book called
        // "Žuvis vandenyje", then a tin of Italian fish in tomato sauce. The
        // catalog stocks no fish stock at all, and searching for the right
        // thing and finding nothing is the correct outcome: the shopper is
        // asked instead of being handed something that is not stock.
        ltName: 'Žuvies sultinys',
        enName: 'fish stock',
        lt: ['žuvies sultinys', 'žuvies sultinio'],
        en: ['fish broth', 'fish stock', 'fish stock cube', 'fish stock cubes'],
        gramsPerMl: 1.0,
        pantry: false,
    },

    // ── FLOUR, GRAINS & BAKING ─────────────────────────────────────────────
    {
        key: 'flour_wheat',
        ltName: 'Kvietiniai miltai',
        enName: 'wheat flour',
        // 'kepimo miltai' (baking flour) is a recipe phrase for plain wheat
        // flour — distinct from 'kepimo milteliai' (baking powder) even after
        // stemming, so registering it cannot rob that entry.
        lt: ['miltai', 'miltų', 'kvietiniai miltai', 'kvietinių miltų',
            'kepimo miltai', 'kepimo miltų', 'kvietiniai kepimo miltai', 'kvietinių kepimo miltų'],
        en: ['flour', 'wheat flour', 'all-purpose flour', 'all purpose flour', 'plain flour', 'ap flour', 'white flour'],
        gramsPerMl: 0.53, // spooned into the cup, NOT packed — packed flour reaches 0.65+
        pantry: true,
    },
    {
        key: 'flour_bread',
        ltName: 'Duoniniai miltai',
        enName: 'bread flour',
        lt: ['duoniniai miltai', 'duoninių miltų'],
        en: ['bread flour', 'strong flour', 'strong bread flour', 'strong white bread flour'],
        gramsPerMl: 0.55,
        pantry: false,
    },
    {
        key: 'flour_self_raising',
        // Not plain flour — it carries raising agents, and UK bakes fail
        // without them. No self-raising flour exists in the catalog (verified),
        // so the shopping name is the nearest real purchase: plain wheat flour
        // (the shopper adds baking powder).
        ltName: 'Kvietiniai miltai',
        enName: 'self-raising flour',
        lt: ['miltai su kepimo milteliais', 'miltų su kepimo milteliais'],
        en: ['self-raising flour', 'self raising flour', 'self-rising flour', 'self rising flour'],
        gramsPerMl: 0.53,
        pantry: false,
    },
    {
        key: 'flour_rye',
        ltName: 'Ruginiai miltai',
        enName: 'rye flour',
        lt: ['ruginiai miltai', 'ruginių miltų'],
        en: ['rye flour'],
        gramsPerMl: 0.5,
        pantry: false,
    },
    {
        key: 'malt_rye',
        // The bread-and-kvass staple. One live product carries the noun as
        // food: 'Sausas salyklas ALVO' (cat 212, verified 2026-07-27) — dry
        // fermented rye malt, which is exactly what 'ruginio salyklo' recipes
        // mean. Density omitted: malt is measured in grams by every recipe
        // that uses it.
        ltName: 'Salyklas',
        enName: 'rye malt',
        lt: ['salyklas', 'salyklo', 'ruginis salyklas', 'ruginio salyklo', 'sausas salyklas', 'sauso salyklo'],
        // NOT bare 'malt': leftmost-wins would then read "malt vinegar" as
        // this entry and buy bread malt for vinegar.
        en: ['rye malt'],
        pantry: false,
    },
    {
        key: 'flour_almond',
        ltName: 'Migdolų miltai',
        enName: 'almond flour',
        lt: ['migdolų miltai', 'migdolų miltų'],
        en: ['almond flour', 'almond meal', 'ground almonds'],
        gramsPerMl: 0.4, // fatty and fluffy — far lighter than wheat flour
        pantry: false,
    },
    {
        key: 'kama',
        ltName: 'Kama miltai',
        enName: 'kama flour',
        lt: ['kama', 'kama miltai', 'kama miltų'],
        en: ['kama flour', 'kama'],
        gramsPerMl: 0.5, // roasted mixed-grain flour (Estonian kama)
        pantry: false,
    },
    {
        key: 'starch_potato',
        // Bare 'krakmolas' belongs here: in Lithuania the default kitchen
        // starch (cepelinai!) is potato starch, not corn.
        ltName: 'Bulvių krakmolas',
        enName: 'potato starch',
        lt: ['krakmolas', 'krakmolo', 'bulvių krakmolas', 'bulvių krakmolo'],
        en: ['potato starch'],
        gramsPerMl: 0.65,
        pantry: true,
    },
    {
        key: 'starch_corn',
        ltName: 'Kukurūzų krakmolas',
        enName: 'cornstarch',
        lt: ['kukurūzų krakmolas', 'kukurūzų krakmolo'],
        en: ['cornstarch', 'cornflour', 'corn starch', 'corn flour'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'cornmeal',
        // Coarse maize meal / polenta — NOT cornstarch ('kukurūzų krakmolas')
        // and not wheat flour. Shelf: 'Kukurūzų miltai MALSENA', 'Kukurūzų
        // kruopos polenta NATURALISIMO' (verified).
        ltName: 'Kukurūzų miltai',
        enName: 'cornmeal',
        lt: ['kukurūzų miltai', 'kukurūzų miltų', 'polenta', 'polentos'],
        en: ['cornmeal', 'corn meal', 'polenta', 'coarse cornmeal'],
        gramsPerMl: 0.6,
        pantry: false,
    },
    {
        key: 'semolina',
        ltName: 'Manų kruopos',
        enName: 'semolina',
        lt: ['manų kruopos', 'manų kruopų', 'manai'],
        en: ['semolina'],
        gramsPerMl: 0.7,
        pantry: false,
    },
    {
        key: 'oats',
        ltName: 'Avižiniai dribsniai',
        enName: 'rolled oats',
        lt: ['avižiniai dribsniai', 'avižinių dribsnių', 'avižos', 'avižų'],
        en: ['oats', 'rolled oats', 'oatmeal', 'porridge oats'],
        gramsPerMl: 0.4, // flakes trap a lot of air
        pantry: false,
    },
    {
        key: 'buckwheat',
        ltName: 'Grikiai',
        enName: 'buckwheat',
        lt: ['grikiai', 'grikių', 'grikių kruopos', 'grikių kruopų'],
        en: ['buckwheat', 'buckwheat groats'],
        gramsPerMl: 0.7,
        pantry: false,
    },
    {
        key: 'rice',
        ltName: 'Ryžiai',
        enName: 'rice',
        lt: ['ryžiai', 'ryžių', 'birūs ryžiai', 'birių ryžių'],
        en: ['rice', 'white rice', 'brown rice', 'long grain rice', 'basmati rice', 'jasmine rice'],
        gramsPerMl: 0.85, // raw grains
        pantry: false, // bought per recipe, per project rule
    },
    {
        key: 'rice_risotto',
        // Risotto needs a starchy short grain — the catalog stocks it as
        // 'Itališki ilgagrūdžiai ryžiai ARBORIO' and 'Ryžiai RISO SCOTTI
        // RISOTTO' (verified); plain rice will not make risotto.
        ltName: 'Arborio ryžiai',
        enName: 'risotto rice',
        lt: ['arborio ryžiai', 'arborio ryžių', 'rizoto ryžiai', 'rizoto ryžių', 'ryžiai rizotui'],
        en: ['risotto rice', 'arborio rice', 'carnaroli rice', 'arborio'],
        gramsPerMl: 0.85,
        pantry: false,
    },
    {
        key: 'quinoa',
        ltName: 'Bolivinė balanda',
        enName: 'quinoa',
        lt: ['bolivinė balanda', 'bolivinės balandos', 'kinva', 'kinvos'],
        en: ['quinoa'],
        gramsPerMl: 0.7,
        pantry: false,
    },
    {
        key: 'pearl_barley',
        ltName: 'Perlinės kruopos',
        enName: 'pearl barley',
        lt: ['perlinės kruopos', 'perlinių kruopų', 'miežinės kruopos', 'miežinių kruopų'],
        en: ['pearl barley', 'barley'],
        gramsPerMl: 0.8,
        pantry: false,
    },
    {
        key: 'couscous',
        ltName: 'Kuskusas',
        enName: 'couscous',
        lt: ['kuskusas', 'kuskuso'],
        en: ['couscous'],
        gramsPerMl: 0.65,
        pantry: false,
    },
    {
        key: 'pasta',
        ltName: 'Makaronai',
        enName: 'pasta',
        lt: ['makaronai', 'makaronų', 'spagečiai', 'spagečių'],
        en: ['pasta', 'spaghetti', 'penne', 'penne pasta', 'macaroni', 'linguine', 'noodles', 'egg noodles'],
        pantry: false, // bought per recipe, per project rule
    },
    {
        key: 'pasta_water',
        // Reserved cooking liquid — comes out of the pot, not off a shelf.
        // Without this entry 'pasta water' bought a bag of noodles.
        ltName: 'Makaronų virimo vanduo',
        enName: 'pasta water',
        lt: ['makaronų virimo vanduo', 'makaronų virimo vandens', 'makaronų vanduo', 'makaronų vandens'],
        en: ['pasta water', 'pasta cooking water', 'reserved pasta water', 'starchy pasta water'],
        gramsPerMl: 1.0,
        pantry: true,
        notSold: true, // same treatment as tap water
    },
    {
        key: 'bread',
        ltName: 'Duona',
        enName: 'bread',
        lt: ['duona', 'duonos', 'balta duona', 'baltos duonos'],
        en: ['bread', 'white bread', 'crusty bread', 'bread slices', 'sourdough bread', 'cob loaf'],
        pantry: false,
    },
    {
        key: 'bread_rye',
        ltName: 'Ruginė duona',
        enName: 'rye bread',
        lt: ['ruginė duona', 'ruginės duonos', 'juoda duona', 'juodos duonos'],
        en: ['rye bread', 'dark rye bread'],
        pantry: false,
    },
    {
        key: 'bread_white_loaf',
        ltName: 'Batonas',
        enName: 'white loaf',
        lt: ['batonas', 'batono'],
        en: ['white loaf', 'baton loaf'],
        gramsPerPiece: 400, // a standard LT batonas
        pantry: false,
    },
    {
        key: 'tortilla',
        // Its own entry so 'flour tortillas' stops resolving to FLOUR and
        // 'corn tortilla wraps' to canned corn. Shelf: 'Tortilijos WELL DONE',
        // 'Tortilijos WRAP ORIGINAL SANTA MARIA' (verified).
        ltName: 'Tortilijos',
        enName: 'tortillas',
        lt: ['tortilija', 'tortilijos', 'tortilijų'],
        en: ['tortilla', 'tortillas', 'flour tortilla', 'flour tortillas',
            'corn tortilla', 'corn tortillas', 'white corn tortillas',
            'tortilla wrap', 'tortilla wraps', 'corn tortilla wraps'],
        gramsPerPiece: 40, // one wrap
        pantry: false,
    },
    {
        key: 'baguette',
        // 'batonas' is taken by bread_white_loaf; the shelf calls this
        // 'Kaimiška bagetė PROCELI' (verified).
        ltName: 'Bagetė',
        enName: 'baguette',
        lt: ['bagetė', 'bagetės', 'prancūziškas batonas', 'prancūziško batono'],
        en: ['baguette', 'french baguette', 'french stick'],
        gramsPerPiece: 250,
        pantry: false,
    },
    {
        key: 'burger_buns',
        // 'KLAIPĖDOS mėsainių bandelės su sezamų sėklomis', 'Mėsainių bandelės
        // BRIOCHE' (verified).
        ltName: 'Mėsainių bandelės',
        enName: 'burger buns',
        lt: ['mėsainių bandelės', 'mėsainių bandelių', 'mėsainių bandelė'],
        en: ['burger bun', 'burger buns', 'hamburger buns', 'brioche buns'],
        gramsPerPiece: 60,
        pantry: false,
    },
    {
        key: 'wafer_sheets',
        // 'Vaflių lakštai KLAIPĖDOS DUONA' / 'Apvalūs vaflių lakštai' — 8 live
        // products (verified 2026-07-27). 'Tortų karalienė' is the brand LT
        // bakers use as the generic name for the same sheets, so the branded
        // phrase resolves here rather than going unmatched.
        ltName: 'Vaflių lakštai',
        enName: 'wafer sheets',
        lt: ['vaflių lakštai', 'vaflių lakštų', 'tortų karalienės lakštai', 'tortų karalienės lakštų'],
        en: ['wafer sheets', 'cake wafer sheets'],
        pantry: false,
    },
    {
        key: 'puff_pastry',
        // 'Šaldyta sluoksniuota tešla WELL DONE' (verified). No sheet weight:
        // packs range 275–500 g, a guess would corrupt the list.
        ltName: 'Sluoksniuota tešla',
        enName: 'puff pastry',
        lt: ['sluoksniuota tešla', 'sluoksniuotos tešlos', 'šaldyta sluoksniuota tešla', 'šaldytos sluoksniuotos tešlos'],
        en: ['puff pastry', 'puff pastry sheet', 'puff pastry sheets', 'ready rolled puff pastry'],
        pantry: false,
    },
    {
        key: 'breadcrumbs',
        ltName: 'Džiūvėsėliai',
        enName: 'breadcrumbs',
        lt: ['džiūvėsėliai', 'džiūvėsėlių', 'malti džiūvėsėliai', 'maltų džiūvėsėlių'],
        // "bread crumbs" as TWO words is the US spelling, and without it only
        // "bread" survived — 3/4 cup of dry bread crumbs bought a seeded LOAF.
        en: ['breadcrumbs', 'plain breadcrumbs', 'dried breadcrumbs', 'regular breadcrumbs',
            'bread crumbs', 'dry bread crumbs', 'dried bread crumbs', 'fresh bread crumbs',
            'plain bread crumbs', 'italian bread crumbs', 'seasoned bread crumbs'],
        gramsPerMl: 0.35,
        pantry: true,
    },
    {
        key: 'panko',
        ltName: 'Panko džiūvėsėliai',
        enName: 'panko breadcrumbs',
        lt: ['panko', 'panko džiūvėsėliai', 'panko džiūvėsėlių'],
        en: ['panko breadcrumbs', 'panko crumbs'],
        gramsPerMl: 0.2, // giant airy flakes — half the weight of regular crumbs
        pantry: false,
    },
    {
        key: 'yeast',
        ltName: 'Mielės',
        enName: 'yeast',
        lt: ['mielės', 'mielių', 'sausos mielės', 'sausų mielių', 'šviežios mielės', 'šviežių mielių'],
        en: ['yeast', 'dried yeast', 'dry yeast', 'instant yeast', 'fast action yeast', 'dried fast action yeast'],
        gramsPerMl: 0.6, // dry granules; a 7 g sachet ≈ 2¼ tsp
        pantry: true,
    },
    {
        key: 'nutritional_yeast',
        // A deactivated seasoning, NOT baker's yeast — swapping them ruins
        // both the dish and the bread. Shelf: 'Maistinių mielių dribsniai
        // ENGEVITA' (verified).
        ltName: 'Maistinių mielių dribsniai',
        enName: 'nutritional yeast',
        lt: ['maistinės mielės', 'maistinių mielių', 'maistinių mielių dribsniai'],
        en: ['nutritional yeast', 'nutritional yeast flakes'],
        gramsPerMl: 0.25, // large dry flakes — very light
        pantry: false,
    },
    {
        key: 'baking_powder',
        ltName: 'Kepimo milteliai',
        enName: 'baking powder',
        lt: ['kepimo milteliai', 'kepimo miltelių'],
        en: ['baking powder'],
        gramsPerMl: 0.9,
        pantry: true,
    },
    {
        key: 'baking_soda',
        ltName: 'Maistinė soda',   // what the shelf label actually says in Lithuania
        enName: 'baking soda',
        lt: ['kepimo soda', 'kepimo sodos', 'soda', 'sodos', 'valgomoji soda', 'valgomosios sodos'],
        en: ['baking soda', 'bicarbonate of soda', 'bicarb', 'bicarb soda'],
        gramsPerMl: 0.95,
        pantry: true,
    },
    {
        key: 'gelatin',
        ltName: 'Želatina',
        enName: 'gelatin',
        lt: ['želatina', 'želatinos'],
        en: ['gelatin', 'gelatine', 'powdered gelatin'],
        gramsPerMl: 0.6, // powdered
        pantry: false,
    },
    {
        key: 'pectin',
        ltName: 'Pektinas',
        enName: 'pectin',
        lt: ['pektinas', 'pektino'],
        en: ['pectin'],
        pantry: false,
    },
    {
        key: 'vanilla_extract',
        ltName: 'Vanilės ekstraktas',
        enName: 'vanilla extract',
        lt: ['vanilė', 'vanilės', 'vanilės ekstraktas', 'vanilės ekstrakto', 'vanilės esencija', 'vanilės esencijos'],
        en: ['vanilla', 'vanilla extract', 'vanilla essence'],
        gramsPerMl: 0.88, // alcohol-based — lighter than water
        pantry: true,
    },
    {
        key: 'vanilla_sugar',
        ltName: 'Vanilinis cukrus',
        enName: 'vanilla sugar',
        lt: ['vanilinis cukrus', 'vanilinio cukraus'],
        en: ['vanilla sugar'],
        gramsPerMl: 0.85,
        pantry: true,
    },
    {
        key: 'cookies',
        ltName: 'Sausainiai',
        enName: 'cookies',
        lt: ['sausainiai', 'sausainių', 'šokoladiniai sausainiai', 'šokoladinių sausainių'],
        en: ['cookies', 'biscuits', 'chocolate cookies'],
        pantry: false,
    },
    {
        key: 'ice_cream',
        // 'vanilla ice cream' used to resolve to vanilla EXTRACT. The shelf
        // phrase is 'Valgomieji ledai' (136 live products, verified).
        ltName: 'Valgomieji ledai',
        enName: 'ice cream',
        lt: ['ledai', 'ledų', 'valgomieji ledai', 'valgomųjų ledų', 'vaniliniai ledai', 'vanilinių ledų'],
        en: ['ice cream', 'vanilla ice cream', 'vanilla bean ice cream'],
        pantry: false,
    },
    {
        key: 'tortilla_chips',
        // Shelf: 'Kukurūzų traškučiai SANTA MARIA' (verified).
        ltName: 'Kukurūzų traškučiai',
        enName: 'tortilla chips',
        lt: ['kukurūzų traškučiai', 'kukurūzų traškučių'],
        en: ['tortilla chips', 'corn chips', 'corn tortilla chips'],
        pantry: false,
    },

    // ── SUGAR, SWEETENERS & CHOCOLATE ──────────────────────────────────────
    {
        key: 'sugar_white',
        ltName: 'Cukrus',
        enName: 'white sugar',
        lt: ['cukrus', 'cukraus', 'baltas cukrus', 'balto cukraus'],
        en: ['sugar', 'white sugar', 'granulated sugar', 'caster sugar', 'superfine sugar', 'regular sugar'],
        gramsPerMl: 0.85,
        pantry: true,
    },
    {
        key: 'sugar_brown',
        ltName: 'Rudasis cukrus',
        enName: 'brown sugar',
        lt: ['rudasis cukrus', 'rudojo cukraus', 'rudas cukrus', 'rudo cukraus'],
        en: ['brown sugar', 'light brown sugar', 'dark brown sugar'],
        gramsPerMl: 0.9, // packed, as brown sugar is measured
        pantry: true,
    },
    {
        key: 'sugar_powdered',
        // The shop uses BOTH names for the same product: 'Cukraus pudra RIMI' /
        // 'Biri cukraus pudra SAUDA' and 'Cukraus milteliai DANSUKKER'
        // (verified). Both spellings must resolve here or half the shelf is
        // invisible.
        ltName: 'Cukraus pudra',
        enName: 'powdered sugar',
        lt: ['cukraus pudra', 'cukraus pudros', 'cukraus milteliai', 'cukraus miltelių'],
        en: ['powdered sugar', 'icing sugar', 'confectioners sugar'],
        gramsPerMl: 0.5, // milled to powder — much fluffier than granulated
        pantry: true,
    },
    {
        key: 'sugar_cane',
        ltName: 'Cukranendrių cukrus',
        enName: 'cane sugar',
        lt: ['cukranendrių cukrus', 'cukranendrių cukraus'],
        en: ['cane sugar', 'raw cane sugar', 'demerara sugar'],
        gramsPerMl: 0.85,
        pantry: false,
    },
    {
        key: 'sugar_jam',
        ltName: 'Uogienių cukrus',
        enName: 'jam sugar',
        lt: ['cukrus uogienėms', 'cukraus uogienėms', 'želiruojantis cukrus', 'želiruojančio cukraus'],
        en: ['jam sugar', 'jam setting sugar'],
        gramsPerMl: 0.85,
        pantry: false,
    },
    {
        key: 'sweetener',
        ltName: 'Saldiklis',
        enName: 'sweetener',
        lt: ['saldiklis', 'saldiklio'],
        en: ['sweetener', 'stevia', 'erythritol'],
        // no density: sweeteners span ~0.1 (pure stevia) to ~0.9 (erythritol)
        pantry: false,
    },
    {
        key: 'honey',
        ltName: 'Medus',
        enName: 'honey',
        lt: ['medus', 'medaus', 'skystas medus', 'skysto medaus'],
        en: ['honey', 'runny honey', 'liquid honey'],
        gramsPerMl: 1.42, // supersaturated sugar solution — heaviest common liquid
        pantry: true,
    },
    {
        key: 'molasses',
        // No molasses in the catalog today (verified — every 'melas' hit is a
        // book titled "MELAS", i.e. "The Lie"). The entry still earns its keep:
        // it stops 'black treacle' going unmatched-and-guessed, and an honest
        // no-match beats a fabricated substitute.
        ltName: 'Melasa',
        enName: 'molasses',
        lt: ['melasa', 'melasos', 'juodoji melasa', 'juodosios melasos'],
        en: ['molasses', 'blackstrap molasses', 'black treacle', 'treacle'],
        gramsPerMl: 1.4,
        pantry: false,
    },
    {
        key: 'maple_syrup',
        ltName: 'Klevų sirupas',
        enName: 'maple syrup',
        lt: ['klevų sirupas', 'klevų sirupo'],
        en: ['maple syrup', 'pure maple syrup'],
        gramsPerMl: 1.32,
        pantry: false,
    },
    {
        key: 'agave_syrup',
        ltName: 'Agavų sirupas',
        enName: 'agave syrup',
        lt: ['agavų sirupas', 'agavų sirupo'],
        en: ['agave syrup', 'agave nectar'],
        gramsPerMl: 1.32,
        pantry: false,
    },
    {
        key: 'pomegranate_syrup',
        ltName: 'Granatų sirupas',
        enName: 'pomegranate syrup',
        lt: ['granatų sirupas', 'granatų sirupo'],
        en: ['pomegranate syrup', 'pomegranate molasses'],
        gramsPerMl: 1.35,
        pantry: false,
    },
    {
        key: 'chocolate_syrup',
        // 'chocolate syrup' used to resolve to a BAR of dark chocolate.
        // Shelf: 'Juodojo šokolado sirupas' (verified).
        ltName: 'Šokolado sirupas',
        enName: 'chocolate syrup',
        lt: ['šokolado sirupas', 'šokolado sirupo', 'šokoladinis sirupas', 'šokoladinio sirupo'],
        en: ['chocolate syrup', 'chocolate sauce'],
        gramsPerMl: 1.3,
        pantry: false,
    },
    {
        key: 'jam',
        // 'uogienė' ≡ 'džemas' on the shelf, and džemas wins 72 : 30 live
        // products (verified) — so the SHOPPING name is Džemas while both
        // words stay recognised.
        ltName: 'Džemas',
        enName: 'jam',
        lt: ['uogienė', 'uogienės', 'džemas', 'džemo'],
        en: ['jam', 'preserves', 'marmalade'],
        gramsPerMl: 1.3,
        pantry: false,
    },
    {
        key: 'jelly_dessert',
        ltName: 'Želė',
        enName: 'jelly dessert',
        // Unflavoured only. The FLAVOURS are separate entries below, because
        // they are separate products on the shelf and one generic "Želė" query
        // cannot tell them apart — it bought ORANGE jelly for a cherry recipe.
        lt: ['želė', 'želės'],
        en: ['jelly', 'jelly powder', 'jello'],
        pantry: false,
    },
    {
        // JELLY, BY FLAVOUR. The lookup takes the longest matching window and,
        // failing that, the FIRST one — so bare "vyšnių želė" resolved to
        // CHERRIES and a packet of jelly became 77 g of frozen fruit. Spelling
        // the flavours out fixes the head noun; giving each its own `ltName`
        // fixes the flavour, which a shared "Želė" query threw away. The shelf
        // spells them "Želė DR. OETKER, vyšnių skonio" (5001-5007, verified).
        //
        // Preferring the last word in general would be wrong far more often:
        // "imbiero šaknies" is ginger, not root, and "juodųjų pipirų žirneliai"
        // is pepper, not peas. The head only wins where the data says it does.
        key: 'jelly_cherry',
        ltName: 'Želė vyšnių skonio',
        enName: 'cherry jelly',
        lt: ['vyšnių želė', 'vyšnių želės'],
        en: ['cherry jelly', 'cherry jello'],
        pantry: false,
    },
    {
        key: 'jelly_strawberry',
        ltName: 'Želė braškių skonio',
        enName: 'strawberry jelly',
        lt: ['braškių želė', 'braškių želės'],
        en: ['strawberry jelly', 'strawberry jello'],
        pantry: false,
    },
    {
        key: 'jelly_raspberry',
        ltName: 'Želė aviečių skonio',
        enName: 'raspberry jelly',
        lt: ['aviečių želė', 'aviečių želės'],
        en: ['raspberry jelly', 'raspberry jello'],
        pantry: false,
    },
    {
        key: 'jelly_orange',
        ltName: 'Želė apelsinų skonio',
        enName: 'orange jelly',
        lt: ['apelsinų želė', 'apelsinų želės'],
        en: ['orange jelly', 'orange jello'],
        pantry: false,
    },
    {
        key: 'jelly_kiwi',
        ltName: 'Želė kivių skonio',
        enName: 'kiwi jelly',
        lt: ['kivių želė', 'kivių želės'],
        en: ['kiwi jelly', 'kiwi jello'],
        pantry: false,
    },
    {
        key: 'cocoa',
        ltName: 'Kakava',
        enName: 'cocoa powder',
        lt: ['kakava', 'kakavos', 'kakavos milteliai', 'kakavos miltelių'],
        en: ['cocoa', 'cocoa powder', 'unsweetened cocoa powder'],
        gramsPerMl: 0.42, // fine fluffy powder — half the density of sugar
        pantry: true,
    },
    {
        key: 'chocolate_dark',
        // Bare 'šokoladas'/'chocolate' means dark in a recipe; milk and white
        // must stay multi-word so 'pieno' is never robbed from milk.
        ltName: 'Juodasis šokoladas',
        enName: 'dark chocolate',
        lt: ['šokoladas', 'šokolado', 'juodasis šokoladas', 'juodojo šokolado', 'juodas šokoladas', 'juodo šokolado'],
        en: ['chocolate', 'dark chocolate', 'bittersweet chocolate', 'chocolate chips'],
        pantry: false,
    },
    {
        key: 'chocolate_milk',
        ltName: 'Pieno šokoladas',
        enName: 'milk chocolate',
        lt: ['pieno šokoladas', 'pieno šokolado'],
        en: ['milk chocolate'],
        pantry: false,
    },
    {
        key: 'chocolate_white',
        ltName: 'Baltas šokoladas',
        enName: 'white chocolate',
        lt: ['baltas šokoladas', 'balto šokolado', 'baltasis šokoladas', 'baltojo šokolado'],
        en: ['white chocolate'],
        pantry: false,
    },

    // ── FATS & OILS ────────────────────────────────────────────────────────
    {
        key: 'oil_cooking',
        ltName: 'Aliejus',
        enName: 'cooking oil',
        // 'augalinis aliejus' (vegetable oil) IS the generic cooking oil —
        // recipes print it constantly, and without the form the qualifier read
        // as a dropped word on every correct sunflower-oil match.
        lt: ['aliejus', 'aliejaus', 'augalinis aliejus', 'augalinio aliejaus'],
        // 'oil spray' moved to cooking_spray below: a spray can is a different
        // purchase from a bottle, and the catalog stocks the cans.
        en: ['oil', 'cooking oil', 'vegetable oil', 'canola oil', 'neutral oil', 'plain oil'],
        gramsPerMl: 0.92,
        pantry: true,
    },
    {
        key: 'cooking_spray',
        // Verified 2026-07-27: a real shelf, not a US-only import — cats
        // 186-189 hold 11 live spray oils ('Purškiamasis ypač tyras alyvuogių
        // aliejus LA ESPANOLA', 'Ekologiškas purškiamasis rapsų aliejus
        // BIONATURALIS'). Was the single most common unmatched EN ingredient
        // (4×) in the 180-recipe baseline.
        // 'Purškiamasis', the definite form, because it is what the PLAIN cans
        // print — the indefinite 'Purškiamas' surface-matched the one
        // truffle-flavoured can best and ranked it first.
        ltName: 'Purškiamasis aliejus',
        enName: 'cooking spray',
        lt: ['purškiamas aliejus', 'purškiamo aliejaus', 'purškiamasis aliejus', 'purškiamojo aliejaus'],
        en: ['cooking spray', 'nonstick cooking spray', 'non-stick cooking spray', 'baking spray', 'oil spray'],
        gramsPerMl: 0.92,
        pantry: true,
    },
    {
        key: 'oil_olive',
        ltName: 'Alyvuogių aliejus',
        enName: 'olive oil',
        lt: ['alyvuogių aliejus', 'alyvuogių aliejaus'],
        en: ['olive oil', 'extra virgin olive oil', 'virgin olive oil'],
        gramsPerMl: 0.92,
        pantry: true,
    },
    {
        key: 'oil_sunflower',
        ltName: 'Saulėgrąžų aliejus',
        enName: 'sunflower oil',
        lt: ['saulėgrąžų aliejus', 'saulėgrąžų aliejaus'],
        en: ['sunflower oil'],
        gramsPerMl: 0.92,
        pantry: true,
    },
    {
        key: 'oil_sesame',
        ltName: 'Sezamų aliejus',
        enName: 'sesame oil',
        lt: ['sezamų aliejus', 'sezamų aliejaus', 'skrudintų sezamų aliejus', 'skrudintų sezamų aliejaus'],
        en: ['sesame oil', 'toasted sesame oil'],
        gramsPerMl: 0.92,
        pantry: false,
    },
    {
        key: 'oil_coconut',
        ltName: 'Kokosų aliejus',
        enName: 'coconut oil',
        lt: ['kokosų aliejus', 'kokosų aliejaus'],
        en: ['coconut oil'],
        gramsPerMl: 0.92,
        pantry: false,
    },
    {
        key: 'oil_avocado',
        // Without this entry 'avocado oil' bought a fresh avocado. Shelf:
        // 'Avokadų aliejus BILLA PREMIUM' (verified, 5 live products).
        ltName: 'Avokadų aliejus',
        enName: 'avocado oil',
        lt: ['avokadų aliejus', 'avokadų aliejaus'],
        en: ['avocado oil'],
        gramsPerMl: 0.92,
        pantry: false,
    },

    // ── SALT, PEPPER & SPICES ──────────────────────────────────────────────
    {
        key: 'salt_fine',
        ltName: 'Druska',
        enName: 'salt',
        lt: ['druska', 'druskos', 'smulki druska', 'smulkios druskos'],
        en: ['salt', 'fine salt', 'table salt', 'cooking salt'],
        gramsPerMl: 1.2, // fine crystals pack tight — 2.4× the density of dried oregano flakes
        pantry: true,
    },
    {
        key: 'salt_sea',
        ltName: 'Jūros druska',
        enName: 'sea salt',
        lt: ['jūros druska', 'jūros druskos'],
        en: ['sea salt', 'fine sea salt', 'flaky sea salt', 'sea salt flakes'],
        gramsPerMl: 1.1,
        pantry: true,
    },
    {
        key: 'salt_coarse',
        // Coarse/kosher crystals stack with air gaps — a spoon holds ~25% less
        // salt than the same spoon of fine salt. Using 1.2 here oversalts.
        ltName: 'Rupi druska',
        enName: 'coarse salt',
        lt: ['rupi druska', 'rupios druskos', 'stambi druska', 'stambios druskos', 'akmens druska', 'akmens druskos'],
        en: ['coarse salt', 'kosher salt', 'rock salt', 'salt flakes'],
        gramsPerMl: 0.9,
        pantry: true,
    },
    {
        key: 'garlic_salt',
        ltName: 'Česnakinė druska',
        enName: 'garlic salt',
        lt: ['česnakinė druska', 'česnakinės druskos'],
        en: ['garlic salt'],
        gramsPerMl: 1.1,
        pantry: true,
    },
    {
        key: 'pepper_black',
        ltName: 'Juodieji pipirai',
        enName: 'black pepper',
        // 'pipirų žirneliai' = whole peppercorns ('Juodieji pipirai žirneliais
        // SAUDA', verified). Bare 'žirneliai' stays with green peas — the
        // default sense — so peppercorns must always arrive with 'pipirų'.
        lt: ['pipirai', 'pipirų', 'juodieji pipirai', 'juodųjų pipirų', 'malti juodieji pipirai', 'maltų juodųjų pipirų', 'maltais juodaisiais pipirais',
            'pipirų žirneliai', 'pipirų žirnelių', 'pipirai žirneliais', 'juodųjų pipirų žirneliai', 'juodųjų pipirų žirnelių'],
        en: ['pepper', 'black pepper', 'ground black pepper', 'cracked black pepper', 'freshly cracked black pepper', 'black peppercorns', 'peppercorns'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'pepper_white',
        ltName: 'Baltieji pipirai',
        enName: 'white pepper',
        lt: ['baltieji pipirai', 'baltųjų pipirų'],
        en: ['white pepper', 'ground white pepper'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'allspice',
        ltName: 'Kvapnieji pipirai',
        enName: 'allspice',
        lt: ['kvapnieji pipirai', 'kvapniųjų pipirų', 'kvapniųjų pipirų žirneliai'],
        en: ['allspice', 'allspice berries'],
        gramsPerMl: 0.45, // whole berries — hollow-ish, lighter than ground pepper
        pantry: true,
    },
    {
        key: 'cayenne',
        ltName: 'Kajeno pipirai',
        enName: 'cayenne pepper',
        lt: ['kajeno pipirai', 'kajeno pipirų', 'raudonieji pipirai', 'raudonųjų pipirų'],
        en: ['cayenne', 'cayenne pepper', 'cayenne powder'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'chili_flakes',
        ltName: 'Aitriųjų paprikų dribsniai',
        enName: 'chilli flakes',
        lt: ['aitriųjų paprikų dribsniai', 'aitriųjų paprikų dribsnių', 'čili dribsniai', 'čili dribsnių', 'raudonųjų paprikų skiedrelės', 'raudonųjų paprikų skiedrelių'],
        en: ['chilli flakes', 'chili flakes', 'red pepper flakes', 'crushed red pepper', 'crushed red pepper flakes', 'dried chilli flakes', 'red chilli flakes'],
        gramsPerMl: 0.3, // coarse dried flakes with seeds — airier than a ground spice
        pantry: true,
    },
    {
        key: 'chili_powder',
        // HOT paprika lives here (vs the sweet 'paprika_ground' entry): the
        // shelf item is 'Malta aitriosioji paprika SALDVA' (verified) — that is
        // literally what LT shops call hot chilli powder.
        ltName: 'Malta aitrioji paprika',
        enName: 'chilli powder',
        lt: ['aitriosios paprikos milteliai', 'aitriosios paprikos miltelių', 'čili milteliai', 'čili miltelių',
            'malta aitrioji paprika', 'maltos aitriosios paprikos'],
        en: ['chilli powder', 'chili powder', 'chili powder blend', 'hot paprika'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'chili_dried',
        ltName: 'Džiovintos aitriosios paprikos',
        enName: 'dried chillies',
        lt: ['džiovintos aitriosios paprikos', 'džiovintų aitriųjų paprikų'],
        en: ['dried chillies', 'dried red chillies', 'dried chiles', 'dried chilies'],
        gramsPerPiece: 2,
        pantry: false,
    },
    {
        key: 'chili_fresh',
        ltName: 'Aitriosios paprikos',
        enName: 'fresh chilli',
        lt: ['aitrioji paprika', 'aitriosios paprikos', 'aitriųjų paprikų', 'čili pipirai', 'čili pipirų'],
        en: ['chilli', 'chili', 'chillies', 'chilies', 'fresh chilli', 'red chilli', 'birds eye chilli'],
        gramsPerPiece: 25,
        pantry: false,
        weighable: true,
    },
    {
        key: 'watermelon',
        ltName: 'Arbūzai',
        enName: 'watermelon',
        lt: ['arbūzas', 'arbūzo', 'arbūzai', 'arbūzų'],
        en: ['watermelon', 'seedless watermelon', 'watermelon flesh', 'cubed watermelon'],
        gramsPerPiece: 4000,
        pantry: false,
        weighable: true,
    },
    {
        key: 'pak_choi',
        ltName: 'Salotos PAK CHOI',
        enName: 'pak choi',
        lt: ['pak choi', 'pak choi salotos'],
        en: ['pak choi', 'bok choy', 'pak choy', 'baby pak choi', 'baby bok choy'],
        gramsPerPiece: 150,
        pantry: false,
        weighable: true,
    },
    {
        key: 'tomato_plum',
        // ...and "plum TOMATOES" are tomatoes, not prunes.
        ltName: 'Slyviniai pomidorai',
        enName: 'plum tomatoes',
        lt: ['slyviniai pomidorai', 'slyvinių pomidorų'],
        en: ['plum tomatoes', 'plum tomato', 'roma tomatoes', 'san marzano tomatoes'],
        gramsPerPiece: 70,
        pantry: false,
        weighable: true,
    },
    {
        key: 'tomato_sauce',
        // "tomato SAUCE" is sauce. Dropping the head bought fresh vine tomatoes
        // — and 0.12 kg of them, less than the recipe asked for.
        ltName: 'Pomidorų padažas',
        enName: 'tomato sauce',
        lt: ['pomidorų padažas', 'pomidorų padažo'],
        // 'pasta sauce' names THIS, not pasta: with only the 'pasta' window
        // recognised, the head noun (sauce) was the word that got dropped and
        // "26 oz pasta sauce" silently bought "Makaronai TAGLIATELLE" —
        // NOODLES for a jar of sauce.
        en: ['tomato sauce', 'passata', 'tomato passata', 'pasta sauce', 'marinara sauce'],
        gramsPerMl: 1.05,
        pantry: false,
    },
    {
        key: 'pikeperch',
        // Without its own entry the species word was dropped to the generic
        // "fish" key and 400 g of pike-perch fillet became CHICKEN fillet.
        ltName: 'Sterkų filė',
        enName: 'pike-perch',
        lt: ['starkis', 'starkio', 'sterkas', 'sterko', 'sterkų filė', 'starkio filė'],
        en: ['pike-perch', 'pikeperch', 'zander', 'walleye'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'cod',
        ltName: 'Menkės filė',
        aliases: ['Menkių filė'],
        enName: 'cod',
        lt: ['menkė', 'menkės', 'menkių', 'menkės filė', 'menkės filė'],
        // 'fish pie mix' is a UK pack of mixed raw white fish and salmon; with
        // only "fish" surviving, it bought a tin of Italian fish in tomato
        // sauce. White fish fillet is the honest nearest thing on this shelf.
        en: ['cod', 'cod fillet', 'cod fillets', 'cod loin', 'skinless cod fillets',
            'fish pie mix', 'white fish fillet', 'white fish fillets'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'lemongrass',
        ltName: 'Citrinžolės',
        enName: 'lemongrass',
        lt: ['citrinžolė', 'citrinžolės', 'citrinžolių'],
        en: ['lemongrass', 'lemon grass', 'lemongrass stalk', 'lemongrass stalks',
            'stalk of lemongrass'],
        gramsPerPiece: 20,
        pantry: false,
        weighable: true,
    },
    {
        key: 'jalapeno',
        // The shelf item is 'Pipirai JALAPENO' (21254, verified) — a bare
        // "Jalapenai" query never reached it, so the ingredient went unmatched.
        ltName: 'Pipirai JALAPENO',
        enName: 'jalapeño',
        lt: ['jalapenai', 'jalapenų', 'jelapeno pipirai', 'jelapeno pipirų', 'konservuoti jalapenai', 'konservuotų jalapenų'],
        en: ['jalapeño', 'jalapeno', 'jalapenos', 'pickled jalapenos'],
        gramsPerPiece: 15,
        pantry: false,
    },
    {
        key: 'paprika_ground',
        // EN 'paprika' is the spice; the LT vegetable never appears as bare
        // nominative 'paprika' in recipes (it prints 'paprikos'/'paprikų'),
        // so the bare token safely belongs to the spice.
        // Shelf: 'Malta saldžioji paprika ALVO', 'Malta raudonoji saldžioji
        // paprika SALDVA' (verified). Smoked and hot paprika are DIFFERENT
        // shelf products with their own entries below — swapping them changes
        // the dish.
        ltName: 'Malta saldžioji paprika',
        enName: 'paprika',
        lt: ['malta paprika', 'maltos paprikos', 'paprikos milteliai', 'paprikos miltelių',
            'malta saldžioji paprika', 'maltos saldžiosios paprikos'],
        en: ['paprika', 'sweet paprika', 'ground paprika'],
        gramsPerMl: 0.45,
        pantry: true,
    },
    {
        key: 'paprika_smoked',
        // 'Saldžioji rūkyta malta paprika SALDVA', 'Saldžios rūkytos
        // raudonosios paprikos SAUDA' (verified) — the smoky note is the whole
        // point of the recipes that ask for it.
        ltName: 'Saldžioji rūkyta paprika',
        enName: 'smoked paprika',
        lt: ['rūkyta paprika', 'rūkytos paprikos', 'saldžioji rūkyta paprika', 'saldžiosios rūkytos paprikos'],
        en: ['smoked paprika', 'sweet smoked paprika', 'smoked sweet paprika', 'hot smoked paprika'],
        gramsPerMl: 0.45,
        pantry: true,
    },
    {
        key: 'curry_powder',
        ltName: 'Kario prieskoniai',
        enName: 'curry powder',
        lt: ['karis', 'kario', 'karį', 'kario prieskoniai', 'kario prieskonių', 'kario milteliai', 'kario miltelių'],
        en: ['curry', 'curry powder'],
        gramsPerMl: 0.47, // the headline conversion: 3 tbsp = 45 ml ≈ 21 g
        pantry: true,
    },
    {
        key: 'turmeric',
        // Shelf spelling is the plural, 'Ciberžolės SAUDA' / 'Ciberžolės SALDVA'
        // (5074, 5082 verified); the singular query scored too low to be kept.
        ltName: 'Ciberžolės',
        enName: 'turmeric',
        lt: ['ciberžolė', 'ciberžolės', 'malta ciberžolė', 'maltos ciberžolės'],
        en: ['turmeric', 'ground turmeric'],
        gramsPerMl: 0.55, // one of the densest ground spices
        pantry: true,
    },
    {
        key: 'cinnamon',
        ltName: 'Cinamonas',
        enName: 'cinnamon',
        lt: ['cinamonas', 'cinamono', 'maltas cinamonas', 'malto cinamono'],
        en: ['cinnamon', 'ground cinnamon', 'cinnamon powder'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'cinnamon_stick',
        // Counted by the piece in mulled/curry recipes; the ground jar cannot
        // substitute 1:1. Shelf: 'Cinamono lazdelės KOTANYI' (verified).
        ltName: 'Cinamono lazdelės',
        enName: 'cinnamon sticks',
        lt: ['cinamono lazdelės', 'cinamono lazdelių', 'cinamono lazdelė'],
        en: ['cinnamon stick', 'cinnamon sticks'],
        gramsPerPiece: 2, // one quill
        pantry: true,
    },
    {
        key: 'cardamom',
        // Shelf spelling is plural: 'Malti kardamonai SANTA MARIA / SAUDA'
        // (verified).
        ltName: 'Malti kardamonai',
        enName: 'cardamom',
        lt: ['kardamonas', 'kardamono', 'maltas kardamonas', 'malto kardamono',
            'kardamonai', 'kardamonų', 'malti kardamonai', 'maltų kardamonų'],
        en: ['cardamom', 'ground cardamom'],
        gramsPerMl: 0.45,
        pantry: true,
    },
    {
        key: 'cardamom_pods',
        // Whole pods, not the ground jar — a recipe counts them by the piece.
        // The catalog has only ground cardamom today ('Malti kardamonai',
        // verified), so the query is the plain plural and the closest real
        // product is still cardamom, never a random spice.
        ltName: 'Kardamonai',
        enName: 'cardamom pods',
        lt: ['kardamono ankštys', 'kardamono ankščių'],
        en: ['cardamom pods', 'cardamom pod', 'green cardamom pods'],
        gramsPerPiece: 0.2, // one pod
        pantry: true,
    },
    {
        key: 'cumin',
        // LT 'kmynai' is CARAWAY, not cumin — a classic translation trap.
        // Cumin is 'kuminas' / 'romėniški kmynai' on LT shelves.
        ltName: 'Kuminas',
        enName: 'cumin',
        lt: ['kuminas', 'kumino', 'romėniški kmynai', 'romėniškų kmynų'],
        en: ['cumin', 'ground cumin', 'cumin seeds'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'caraway',
        ltName: 'Kmynai',
        enName: 'caraway',
        lt: ['kmynai', 'kmynų'],
        en: ['caraway', 'caraway seeds'],
        gramsPerMl: 0.45, // whole seeds
        pantry: true,
    },
    {
        key: 'nutmeg',
        // The shelf says plural: 'Malti muskatai SALDVA', 'Muskatai SANTA
        // MARIA' (verified) — no product is named 'Muskato riešutas'.
        ltName: 'Malti muskatai',
        enName: 'nutmeg',
        lt: ['muskatas', 'muskato', 'muskato riešutas', 'muskato riešuto',
            'muskatai', 'muskatų', 'malti muskatai', 'maltų muskatų'],
        en: ['nutmeg', 'ground nutmeg'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'clove_spice',
        ltName: 'Gvazdikėliai',
        enName: 'cloves (spice)',
        lt: ['gvazdikėliai', 'gvazdikėlių'],
        // 'cloves' alone is the garlic UNIT in EN recipes — spice must stay qualified.
        en: ['whole cloves', 'ground cloves'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        // Fresh root, sold by weight at the produce counter — a different
        // purchase from the ground spice, which is why "ginger" alone belongs to
        // the spice and only the explicit forms land here.
        key: 'ginger_fresh',
        ltName: 'Šviežias imbieras',
        enName: 'fresh ginger',
        lt: ['imbieras', 'imbiero', 'imbierą', 'imbiero šaknis', 'imbiero šaknies',
            'šviežias imbieras', 'šviežio imbiero', 'tarkuoto imbiero'],
        // Bare "ginger" belongs to the GROUND entry below (in baking, "1 tsp
        // ginger" is the jar). But a physical form — a chunk, a piece, a thumb —
        // can only be the fresh root, and without these a broth asking for "1
        // large chunk of ginger" silently bought ground ginger powder.
        en: ['fresh ginger', 'ginger root', 'root ginger', 'knob of ginger', 'grated ginger',
            'chunk of ginger', 'piece of ginger', 'thumb of ginger', 'ginger, peeled',
            'peeled ginger', 'sliced ginger', 'minced ginger', 'fresh ginger root'],
        gramsPerPiece: 30,   // the thumb-sized piece a recipe means by "a knob"
        pantry: false,
        weighable: true,
    },
    {
        // The generic "mixed herbs" jar. Kept separate from the single-herb rows
        // so a recipe asking for it does not resolve to whichever herb happens to
        // sort first.
        key: 'herbs_mixed',
        ltName: 'Prieskoninių žolelių mišinys',
        enName: 'mixed dried herbs',
        lt: ['prieskoninės žolelės', 'prieskoninių žolelių', 'žolelių mišinys',
            'žolelių mišinio', 'prieskoninių žolelių mišinys'],
        en: ['mixed herbs', 'dried mixed herbs', 'herb blend'],   // 'italian seasoning' belongs to italian_herbs
        gramsPerMl: 0.2,     // dried leaf, as fluffy as oregano
        pantry: true,
    },
    {
        key: 'artichoke',
        ltName: 'Artišokai',
        enName: 'artichokes',
        lt: ['artišokai', 'artišokų', 'artišokas'],
        en: ['artichoke', 'artichokes', 'artichoke hearts'],
        gramsPerPiece: 120,
        pantry: false,
    },
    {
        key: 'almond_extract',
        ltName: 'Migdolų ekstraktas',
        enName: 'almond extract',
        lt: ['migdolų ekstraktas', 'migdolų ekstrakto', 'migdolų esencija', 'migdolų esencijos'],
        en: ['almond extract', 'almond essence'],
        gramsPerMl: 0.87,    // alcohol-based, lighter than water
        pantry: true,
    },
    {
        // Not something a shop sells at all — a baker keeps it alive at home. It
        // is in the table precisely so it can be recognised and then classified
        // as pantry, instead of being hunted for in the catalog.
        key: 'sourdough_starter',
        ltName: 'Raugas',
        enName: 'sourdough starter',
        lt: ['raugas', 'raugo', 'rauginis raugas', 'ruginis raugas'],
        en: ['sourdough starter', 'starter', 'levain', 'active starter'],
        gramsPerMl: 1.0,
        pantry: true,
    },
    {
        key: 'ginger_ground',
        ltName: 'Maltas imbieras',
        enName: 'ground ginger',
        lt: ['maltas imbieras', 'malto imbiero', 'imbiero milteliai', 'imbiero miltelių'],
        en: ['ground ginger', 'ginger powder', 'ginger'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'garlic_powder',
        // Genitive plural again: the shelf has 'česnakų milteliai' (1 live) and
        // 'Granuliuoti česnakai KOTANYI'; 'česnako milteliai' has 0 (verified).
        ltName: 'Česnakų milteliai',
        enName: 'garlic powder',
        lt: ['česnako milteliai', 'česnako miltelių', 'granuliuotas česnakas', 'granuliuoto česnako',
            'česnakų milteliai', 'česnakų miltelių', 'granuliuoti česnakai', 'granuliuotų česnakų'],
        en: ['garlic powder', 'granulated garlic'],
        gramsPerMl: 0.55,
        pantry: true,
    },
    {
        key: 'onion_powder',
        ltName: 'Svogūnų milteliai',
        enName: 'onion powder',
        lt: ['svogūnų milteliai', 'svogūnų miltelių'],
        en: ['onion powder'],
        gramsPerMl: 0.5,
        pantry: true,
    },
    {
        key: 'sumac',
        ltName: 'Sumako prieskoniai',
        enName: 'sumac',
        lt: ['sumakas', 'sumako', 'sumac prieskoniai', 'sumac prieskonių'],
        en: ['sumac', 'ground sumac'],
        gramsPerMl: 0.5,
        pantry: false,
    },
    {
        key: 'sichuan_pepper',
        ltName: 'Sičuano pipirai',
        enName: 'sichuan peppercorns',
        lt: ['sičuano pipirai', 'sičuano pipirų'],
        en: ['sichuan peppercorns', 'sichuan pepper', 'pink sichuan peppercorns'],
        gramsPerMl: 0.4, // hollow husks, not solid corns
        pantry: false,
    },

    // ── HERBS (dried are pantry; fresh are produce) ────────────────────────
    {
        key: 'oregano_dried',
        ltName: 'Džiovinti raudonėliai',
        enName: 'dried oregano',
        lt: ['raudonėliai', 'raudonėlių', 'džiovinti raudonėliai', 'džiovintų raudonėlių', 'švieži raudonėliai', 'šviežių raudonėlių'],
        en: ['oregano', 'dried oregano'],
        // 0.2, NOT ~0.5: dried leaf flakes are mostly air. Giving oregano the
        // density of salt would 2.5× every spoonful.
        gramsPerMl: 0.2,
        pantry: true,
    },
    {
        key: 'basil',
        ltName: 'Bazilikai',
        enName: 'basil',
        lt: ['bazilikas', 'baziliko', 'bazilikai', 'bazilikų', 'bazilikų lapeliai', 'bazilikų lapelių', 'anyžinis bazilikas', 'anyžinio baziliko'],
        en: ['basil', 'fresh basil', 'basil leaves', 'thai basil', 'thai basil leaves'],
        gramsPerPiece: 30, // a shop bunch/pot's worth of leaves
        pantry: false,
    },
    {
        key: 'basil_dried',
        ltName: 'Džiovinti bazilikai',
        enName: 'dried basil',
        lt: ['džiovinti bazilikai', 'džiovintų bazilikų'],
        en: ['dried basil'],
        gramsPerMl: 0.2,
        pantry: true,
    },
    {
        key: 'thyme_dried',
        // Bare 'thyme' measured by the teaspoon is dried; fresh prints
        // 'sprigs'/'fresh' — those forms live on the fresh entry.
        ltName: 'Džiovinti čiobreliai',
        enName: 'dried thyme',
        lt: ['džiovinti čiobreliai', 'džiovintų čiobrelių'],
        en: ['thyme', 'dried thyme'],
        gramsPerMl: 0.25,
        pantry: true,
    },
    {
        key: 'thyme',
        ltName: 'Čiobreliai',
        enName: 'fresh thyme',
        // Leaf forms: the leaves ARE the herb (unlike currant leaves vs the
        // berries), so 'čiobrelių lapelių' must not read as a dropped word.
        lt: ['čiobreliai', 'čiobrelių', 'čiobrelių lapeliai', 'čiobrelių lapelių'],
        en: ['fresh thyme', 'thyme sprigs', 'sprigs thyme'],
        // ONE SPRIG, like rosemary below — this field converts the RECIPE's
        // count into a weight, and a recipe counts sprigs, never bunches. Set to
        // a bunch it made "9 čiobrelių šakelių" ask for nine bunches of thyme.
        gramsPerPiece: 2,
        pantry: false,
    },
    {
        key: 'rosemary',
        ltName: 'Rozmarinai',
        enName: 'rosemary',
        lt: ['rozmarinas', 'rozmarinai', 'rozmarinų', 'rozmarino'],
        en: ['rosemary', 'fresh rosemary', 'rosemary sprigs'],
        gramsPerPiece: 2, // one sprig
        pantry: false,
    },
    {
        key: 'rosemary_dried',
        ltName: 'Džiovinti rozmarinai',
        enName: 'dried rosemary',
        lt: ['džiovinti rozmarinai', 'džiovintų rozmarinų'],
        en: ['dried rosemary'],
        gramsPerMl: 0.3, // dried needles pack tighter than leaf herbs
        pantry: true,
    },
    {
        key: 'dill',
        ltName: 'Krapai',
        enName: 'dill',
        lt: ['krapai', 'krapų', 'krapų žiedynai', 'krapų žiedynų'],
        en: ['dill', 'fresh dill'],
        gramsPerPiece: 30, // one bunch
        pantry: false,
    },
    {
        key: 'dill_dried',
        ltName: 'Džiovinti krapai',
        enName: 'dried dill',
        lt: ['džiovinti krapai', 'džiovintų krapų'],
        en: ['dried dill'],
        gramsPerMl: 0.25,
        pantry: true,
    },
    {
        key: 'parsley',
        ltName: 'Petražolės',
        enName: 'parsley',
        lt: ['petražolės', 'petražolių'],
        en: ['parsley', 'fresh parsley', 'flat leaf parsley', 'chopped parsley'],
        gramsPerPiece: 30, // one bunch
        pantry: false,
    },
    {
        key: 'parsley_dried',
        ltName: 'Džiovintos petražolės',
        enName: 'dried parsley',
        lt: ['džiovintos petražolės', 'džiovintų petražolių'],
        en: ['dried parsley'],
        gramsPerMl: 0.25,
        pantry: true,
    },
    {
        key: 'cilantro',
        ltName: 'Kalendros',
        enName: 'cilantro',
        lt: ['kalendra', 'kalendros', 'kalendrų'],
        en: ['cilantro', 'coriander', 'fresh coriander', 'coriander leaves'],
        gramsPerPiece: 30, // one bunch
        pantry: false,
    },
    {
        key: 'coriander_seed',
        // The SPICE, distinct from the fresh herb above — 'ground coriander'
        // used to resolve to a bunch of cilantro. Shelf: 'Smulkintos kalendros
        // SANTA MARIA' (verified); bare 'coriander'/'kalendros' stays with the
        // herb, so these forms are all qualified.
        ltName: 'Smulkintos kalendros',
        enName: 'coriander seeds',
        lt: ['kalendrų sėklos', 'kalendrų sėklų', 'maltos kalendros', 'maltų kalendrų', 'smulkintos kalendros'],
        en: ['coriander seeds', 'coriander seed', 'ground coriander'],
        gramsPerMl: 0.45,
        pantry: true,
    },
    {
        key: 'chives',
        ltName: 'Laiškiniai česnakai',
        enName: 'chives',
        lt: ['laiškinis česnakas', 'laiškinio česnako', 'laiškiniai česnakai', 'laiškinių česnakų'],
        en: ['chives'],
        gramsPerPiece: 25, // one bunch
        pantry: false,
    },
    {
        key: 'mint',
        ltName: 'Mėtos',
        enName: 'mint',
        // Leaf forms for the same reason as thyme: mint leaves are mint.
        lt: ['mėtos', 'mėtų', 'šviežios mėtos', 'šviežių mėtų', 'mėtų lapeliai', 'mėtų lapelių'],
        en: ['mint', 'fresh mint', 'mint leaves'],
        gramsPerPiece: 25, // one bunch
        pantry: false,
    },
    {
        key: 'sage',
        ltName: 'Šalavijai',
        enName: 'sage',
        lt: ['šalavijas', 'šalavijo', 'šalavijai', 'šalavijų'],
        en: ['sage', 'ground sage', 'dried sage', 'rubbed sage'],
        gramsPerMl: 0.2, // rubbed/ground sage is astonishingly fluffy — lighter than flour
        pantry: true,
    },
    {
        key: 'marjoram',
        ltName: 'Mairūnai',
        enName: 'marjoram',
        lt: ['mairūnas', 'mairūno', 'mairūnai', 'mairūnų'],
        en: ['marjoram', 'dried marjoram'],
        gramsPerMl: 0.2,
        pantry: true,
    },
    {
        key: 'bay_leaf',
        // Recipes print 'lauro lapai' but the shelf mostly says 'Laurų lapai'
        // (SAUDA, KOTANYI, SANTA MARIA, RIMI — 5 of 7 live products, verified).
        ltName: 'Laurų lapai',
        enName: 'bay leaves',
        lt: ['lauro lapai', 'lauro lapų', 'lauro lapas', 'lauro lapo',
            'laurų lapai', 'laurų lapų', 'laurų lapeliai', 'laurų lapelių'],
        en: ['bay leaf', 'bay leaves'],
        gramsPerPiece: 0.2, // a single dried leaf weighs almost nothing
        pantry: true,
    },
    {
        key: 'italian_herbs',
        ltName: 'Itališkų prieskonių mišinys',
        enName: 'italian seasoning',
        lt: ['itališki prieskoniai', 'itališkų prieskonių', 'itališkų prieskonių mišinys'],
        en: ['italian seasoning', 'italian herb mix', 'italian herbs', 'dried italian herbs'],
        gramsPerMl: 0.25, // it is a dried-herb blend, not a ground spice
        pantry: true,
    },
    {
        key: 'cajun_seasoning',
        ltName: 'Kadžunų prieskoniai',
        enName: 'cajun seasoning',
        lt: ['kadžunų prieskoniai', 'kadžunų prieskonių'],
        en: ['cajun seasoning', 'cajun seasoning mix', 'cajun spice'],
        gramsPerMl: 0.5, // mostly ground spices and salt, unlike leafy blends
        pantry: true,
    },
    {
        key: 'taco_seasoning',
        ltName: 'Meksikietiški prieskoniai',
        enName: 'taco seasoning',
        lt: ['meksikietiški prieskoniai', 'meksikietiškų prieskonių'],
        en: ['taco seasoning', 'taco seasoning mix'],
        gramsPerMl: 0.5,
        pantry: false,
    },
    {
        key: 'garam_masala',
        // Shelf: 'Prieskonių mišinys GARAM MASALA SANTA MARIA ASIA' (verified).
        ltName: 'Garam masala',
        enName: 'garam masala',
        lt: ['garam masala', 'garam masalos', 'garam masala prieskoniai', 'garam masala prieskonių'],
        en: ['garam masala'],
        gramsPerMl: 0.45,
        pantry: true,
    },
    {
        key: 'mixed_spice',
        // Generic ground-spice blend ('Prieskonių mišinys ...', 99 live
        // products, verified). Distinct from herbs_mixed, which is leafy.
        ltName: 'Prieskonių mišinys',
        enName: 'mixed spice',
        lt: ['prieskonių mišinys', 'prieskonių mišinio'],
        en: ['mixed spice'],
        gramsPerMl: 0.45,
        pantry: true,
    },
    {
        key: 'tajin',
        // Actually sold here: 'Prieskonių mišinys čili, citrina ir druska
        // TAJIN' (verified) — so a real entry, not a notSold stub.
        ltName: 'Prieskonių mišinys Tajin',
        enName: 'tajín seasoning',
        lt: ['tajin', 'tajin prieskoniai', 'tajin prieskonių'],
        en: ['tajín', 'tajin seasoning', 'tajín seasoning'],
        pantry: true,
    },
    {
        key: 'ranch_seasoning',
        ltName: 'Ranch prieskonių mišinys',
        enName: 'ranch seasoning',
        lt: ['ranch prieskoniai', 'ranch prieskonių'],
        en: ['ranch seasoning', 'ranch seasoning mix', 'ranch dressing mix', 'italian salad dressing mix'],
        gramsPerMl: 0.5,
        pantry: false,
    },
    {
        key: 'gravy_mix',
        ltName: 'Padažo mišinys',
        enName: 'gravy mix',
        lt: ['padažo mišinys', 'padažo mišinio'],
        en: ['gravy mix', 'brown gravy mix', 'french onion soup mix'],
        pantry: false,
    },

    // ── SAUCES & CONDIMENTS ────────────────────────────────────────────────
    {
        key: 'mayonnaise',
        ltName: 'Majonezas',
        enName: 'mayonnaise',
        lt: ['majonezas', 'majonezo'],
        en: ['mayonnaise', 'mayo', 'whole-egg mayonnaise', 'kewpie mayonnaise'],
        gramsPerMl: 0.91, // an emulsion full of oil — lighter than water
        pantry: true,
    },
    {
        key: 'ketchup',
        ltName: 'Kečupas',
        enName: 'ketchup',
        lt: ['kečupas', 'kečupo', 'pomidorų kečupas', 'pomidorų kečupo'],
        en: ['ketchup', 'tomato ketchup'],
        gramsPerMl: 1.1,
        pantry: true,
    },
    {
        key: 'mustard',
        ltName: 'Garstyčios',
        enName: 'mustard',
        lt: ['garstyčios', 'garstyčių'],
        en: ['mustard', 'yellow mustard'],
        gramsPerMl: 1.05,
        pantry: true,
    },
    {
        key: 'mustard_dijon',
        ltName: 'Dižono garstyčios',
        enName: 'dijon mustard',
        lt: ['dižono garstyčios', 'dižono garstyčių'],
        en: ['dijon mustard', 'dijon'],
        gramsPerMl: 1.05,
        pantry: true,
    },
    {
        key: 'mustard_wholegrain',
        ltName: 'Grūdėtosios garstyčios',
        enName: 'wholegrain mustard',
        lt: ['grūdėtosios garstyčios', 'grūdėtųjų garstyčių'],
        en: ['wholegrain mustard', 'whole grain mustard', 'grainy mustard'],
        gramsPerMl: 1.05,
        pantry: true,
    },
    {
        key: 'soy_sauce',
        // Genitive PLURAL, not singular: the shelf says 'Sojų padažas'
        // (23 live products incl. Kikkoman) vs only 4 for 'sojos padažas'
        // (verified) — the singular query landed on a soy MAYONNAISE.
        ltName: 'Sojų padažas',
        enName: 'soy sauce',
        lt: ['sojos padažas', 'sojos padažo', 'sojų padažas', 'sojų padažo'],
        en: ['soy sauce', 'soy', 'light soy sauce', 'light soy', 'all-purpose soy sauce', 'all-purpose soy'],
        gramsPerMl: 1.15, // heavy brine — noticeably denser than water
        pantry: true,
    },
    {
        key: 'soy_sauce_dark',
        // Same sojų-not-sojos fix: 'Tamsusis sojų padažas YAMASA' (verified).
        ltName: 'Tamsusis sojų padažas',
        enName: 'dark soy sauce',
        lt: ['tamsusis sojos padažas', 'tamsiojo sojos padažo',
            'tamsusis sojų padažas', 'tamsiojo sojų padažo', 'tamsus sojų padažas', 'tamsaus sojų padažo'],
        en: ['dark soy sauce', 'dark soy'],
        gramsPerMl: 1.2,
        pantry: false,
    },
    {
        key: 'worcestershire',
        // The shelf spells it 'Vorčesterio' (3762, 24871 verified). Querying the
        // other transliteration found neither of the two stocked bottles.
        ltName: 'Vorčesterio padažas',
        enName: 'worcestershire sauce',
        lt: ['vusterio padažas', 'vusterio padažo', 'vorčesterio padažas', 'vorčesterio padažo'],
        en: ['worcestershire sauce', 'worcestershire'],
        gramsPerMl: 1.07,
        pantry: false,
    },
    {
        key: 'fish_sauce',
        ltName: 'Žuvies padažas',
        enName: 'fish sauce',
        lt: ['žuvies padažas', 'žuvies padažo'],
        en: ['fish sauce'],
        gramsPerMl: 1.2,
        pantry: false,
    },
    {
        key: 'oyster_sauce',
        // Shelf: 'Austrių padažas SANTA MARIA' (verified).
        ltName: 'Austrių padažas',
        enName: 'oyster sauce',
        lt: ['austrių padažas', 'austrių padažo'],
        en: ['oyster sauce'],
        gramsPerMl: 1.2,
        pantry: false,
    },
    {
        key: 'bbq_sauce',
        // Shelf: 'KĖDAINIŲ KONSERVŲ FABRIKO barbekiu padažas CHIPOTLE' (verified).
        ltName: 'Barbekiu padažas',
        enName: 'bbq sauce',
        lt: ['barbekiu padažas', 'barbekiu padažo'],
        en: ['bbq sauce', 'barbecue sauce', 'barbeque sauce'],
        gramsPerMl: 1.1,
        pantry: false,
    },
    {
        key: 'harissa',
        // Chilli paste, nothing to do with pasta-the-noodles ('harissa paste'
        // used to buy spaghetti). No live product yet (verified 0 hits) — the
        // query will honestly no-match rather than silently buy noodles.
        ltName: 'Harisa pasta',
        enName: 'harissa',
        lt: ['harisa', 'harisos', 'harisa pasta', 'harisos pastos'],
        en: ['harissa', 'harissa paste'],
        pantry: false,
    },
    {
        key: 'hot_sauce',
        ltName: 'Aštrusis padažas',
        enName: 'hot sauce',
        lt: ['aštrusis padažas', 'aštriojo padažo', 'aštrus padažas', 'aštraus padažo'],
        // 'hot pepper sauce' must land here, not on black pepper.
        en: ['hot sauce', 'sriracha', 'tabasco', 'hot pepper sauce'],
        gramsPerMl: 1.05,
        pantry: false,
    },
    {
        key: 'salsa',
        ltName: 'Salsa padažas',
        enName: 'salsa',
        lt: ['salsa', 'salsos', 'salsa padažas', 'salsa padažo'],
        en: ['salsa', 'jar salsa'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'guacamole',
        // Shelf: 'Avokadų padažas OLD EL PASO GUACAMOLE' (verified).
        ltName: 'Avokadų padažas guacamole',
        enName: 'guacamole',
        lt: ['guakamolė', 'guakamolės', 'avokadų padažas'],
        en: ['guacamole'],
        pantry: false,
    },
    {
        key: 'tomato_paste',
        ltName: 'Pomidorų pasta',
        enName: 'tomato paste',
        lt: ['pomidorų pasta', 'pomidorų pastos'],
        en: ['tomato paste', 'tomato puree', 'tomato purée'],
        gramsPerMl: 1.1,
        pantry: false,
    },
    {
        key: 'tomatoes_canned',
        ltName: 'Konservuoti pomidorai',
        enName: 'canned tomatoes',
        lt: ['konservuoti pomidorai', 'konservuotų pomidorų', 'pomidorai savo sultyse', 'smulkinti pomidorai', 'smulkintų pomidorų'],
        en: ['canned tomatoes', 'crushed tomatoes', 'diced tomatoes', 'chopped tomatoes', 'fire roasted diced tomatoes', 'canned diced tomatoes'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'tomatoes_sundried',
        ltName: 'Džiovinti pomidorai',
        enName: 'sun-dried tomatoes',
        lt: ['džiovinti pomidorai', 'džiovintų pomidorų', 'saulėje džiovinti pomidorai'],
        en: ['sun-dried tomatoes', 'sun dried tomatoes', 'sundried tomatoes'],
        pantry: false,
    },
    {
        key: 'tahini',
        ltName: 'Tahini pasta',
        enName: 'tahini',
        // The declined 'tahinio' has to be spelled out — it stems to 'tahini'
        // while the listed 'tahini' stems to 'tahin', so the stemmed index
        // never collapses the pair and the LT genitive went unmatched.
        // 'Sezamų pasta SUNTAT' / 'Sezamų sėklų pasta tahini DOYAL' are the
        // shelf names (6 live products, verified 2026-07-27).
        lt: ['tahini', 'tahinis', 'tahinio', 'tahini pasta', 'tahini pastos', 'sezamų pasta', 'sezamų pastos'],
        en: ['tahini', 'tahini paste', 'sesame paste'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'peanut_butter',
        ltName: 'Žemės riešutų sviestas',
        enName: 'peanut butter',
        lt: ['žemės riešutų sviestas', 'žemės riešutų sviesto', 'riešutų sviestas', 'riešutų sviesto'],
        en: ['peanut butter', 'smooth peanut butter', 'crunchy peanut butter'],
        gramsPerMl: 1.05,
        pantry: false,
    },
    {
        key: 'vinegar_table',
        ltName: 'Actas',
        enName: 'vinegar',
        lt: ['actas', 'acto', 'stalo actas', 'stalo acto'],
        en: ['vinegar', 'white vinegar', 'distilled vinegar', 'spirit vinegar'],
        gramsPerMl: 1.01,
        pantry: true,
    },
    {
        key: 'vinegar_wine',
        ltName: 'Vyno actas',
        enName: 'wine vinegar',
        lt: ['vyno actas', 'vyno acto', 'raudonojo vyno actas', 'raudonojo vyno acto', 'baltojo vyno actas', 'baltojo vyno acto'],
        en: ['wine vinegar', 'red wine vinegar', 'white wine vinegar'],
        gramsPerMl: 1.01,
        pantry: true,
    },
    {
        key: 'vinegar_balsamic',
        ltName: 'Balzaminis actas',
        enName: 'balsamic vinegar',
        lt: ['balzaminis actas', 'balzaminio acto', 'balzamiko actas', 'balzamiko acto'],
        en: ['balsamic vinegar', 'balsamic'],
        gramsPerMl: 1.05, // grape-must sugars make it heavier than plain vinegar
        pantry: true,
    },
    {
        key: 'vinegar_apple',
        // 'Obuolių actas' outsells 'obuolių sidro actas' 9 : 3 live products
        // (verified) and the broader phrase still only matches cider vinegar.
        ltName: 'Obuolių actas',
        enName: 'apple cider vinegar',
        lt: ['obuolių actas', 'obuolių acto', 'obuolių sidro actas', 'obuolių sidro acto'],
        en: ['apple cider vinegar', 'cider vinegar'],
        gramsPerMl: 1.01,
        pantry: true,
    },
    {
        key: 'vinegar_rice',
        ltName: 'Ryžių actas',
        enName: 'rice vinegar',
        lt: ['ryžių actas', 'ryžių acto'],
        en: ['rice vinegar', 'rice wine vinegar'],
        gramsPerMl: 1.01,
        pantry: false,
    },
    {
        key: 'capers',
        ltName: 'Kaparėliai',
        enName: 'capers',
        lt: ['kaparėliai', 'kaparėlių', 'kapariai', 'kaparių', 'kaparių uogos', 'kaparių uogų'],
        en: ['capers', 'caper berries'],
        gramsPerMl: 0.6, // drained buds in a spoon
        pantry: false,
    },
    {
        key: 'pickles',
        ltName: 'Marinuoti agurkai',
        enName: 'pickled cucumbers',
        lt: ['marinuoti agurkai', 'marinuotų agurkų', 'rauginti agurkai', 'raugintų agurkų', 'marinuoti agurkėliai', 'marinuotų agurkėlių', 'agurkėliai', 'agurkėlių'],
        en: ['pickles', 'pickled cucumbers', 'gherkins', 'cornichons', 'dill pickles'],
        gramsPerPiece: 40,
        pantry: false,
    },
    {
        key: 'olives',
        ltName: 'Alyvuogės',
        enName: 'olives',
        lt: ['alyvuogės', 'alyvuogių', 'juodosios alyvuogės', 'juodųjų alyvuogių', 'žaliosios alyvuogės', 'žaliųjų alyvuogių'],
        en: ['olives', 'black olives', 'green olives'],
        pantry: false,
    },
    {
        key: 'sauerkraut',
        ltName: 'Rauginti kopūstai',
        enName: 'sauerkraut',
        lt: ['rauginti kopūstai', 'raugintų kopūstų'],
        en: ['sauerkraut'],
        pantry: false,
    },
    {
        key: 'horseradish',
        ltName: 'Krienai',
        enName: 'horseradish',
        lt: ['krienai', 'krienų', 'krienų lapai', 'krienų lapų'],
        en: ['horseradish', 'horseradish leaves'],
        pantry: false,
    },

    // ── VEGETABLES ─────────────────────────────────────────────────────────
    {
        key: 'onion_yellow',
        ltName: 'Svogūnai',
        enName: 'onions',
        lt: ['svogūnas', 'svogūno', 'svogūnai', 'svogūnų'],
        en: ['onion', 'onions', 'yellow onion', 'yellow onions', 'brown onion', 'sweet onion', 'vidalia onions'],
        gramsPerPiece: 150, // medium onion
        pantry: false,
        weighable: true,
    },
    {
        key: 'onion_red',
        ltName: 'Raudonieji svogūnai',
        enName: 'red onion',
        lt: ['raudonasis svogūnas', 'raudonojo svogūno', 'raudonieji svogūnai', 'raudonųjų svogūnų'],
        en: ['red onion', 'red onions'],
        gramsPerPiece: 130,
        pantry: false,
        weighable: true,
    },
    {
        key: 'onion_green',
        ltName: 'Svogūnų laiškai',
        enName: 'green onions',
        lt: ['svogūnų laiškai', 'svogūnų laiškų', 'svogūno laiškai', 'svogūnų laiškas'],
        en: ['green onion', 'green onions', 'spring onion', 'spring onions', 'scallions', 'green onion stem', 'green onion stems'],
        gramsPerPiece: 15, // one stem
        pantry: false,
    },
    {
        key: 'onion_pearl',
        ltName: 'Smulkieji svogūnėliai',
        enName: 'pearl onions',
        lt: ['svogūnėliai', 'svogūnėlių'],
        en: ['pearl onions', 'pickling onions', 'small round pickling onions'],
        gramsPerPiece: 15,
        pantry: false,
    },
    {
        key: 'shallot',
        // 'Askaloniniai česnakai' is a real Lithuanian name for shallots, but it
        // literally reads "Ascalonian GARLIC" — so the query went looking for
        // garlic and duly found "Česnakai", a different plant. The shelf calls
        // them "Valgomieji svogūnėliai" (71, verified); the old spelling stays
        // as a recognised INPUT form, it just stops being what we search for.
        ltName: 'Valgomieji svogūnėliai',
        enName: 'shallots',
        lt: ['askaloniniai česnakai', 'askaloninių česnakų', 'šalotai', 'šalotų', 'šalotas'],
        en: ['shallot', 'shallots', 'eschalot'],
        gramsPerPiece: 30,
        pantry: false,
    },
    {
        key: 'leek',
        ltName: 'Porai',
        enName: 'leek',
        lt: ['poras', 'poro', 'porai', 'porų'],
        en: ['leek', 'leeks'],
        gramsPerPiece: 200,
        pantry: false,
        weighable: true,
    },
    {
        key: 'garlic',
        ltName: 'Česnakai',
        enName: 'garlic',
        lt: ['česnakas', 'česnako', 'česnakai', 'česnakų', 'česnako skiltelė', 'česnako skiltelės', 'česnako skiltelių', 'česnako galvutė', 'česnako galvutės', 'česnako galvučių'],
        en: ['garlic', 'garlic clove', 'garlic cloves', 'cloves garlic', 'clove garlic'],
        gramsPerPiece: 4, // ONE CLOVE — recipes count cloves; a whole head is ~40 g
        pantry: false,
        weighable: true,
    },
    {
        key: 'potato',
        ltName: 'Bulvės',
        enName: 'potatoes',
        lt: ['bulvė', 'bulvės', 'bulvių', 'virtos bulvės', 'virtų bulvių', 'žalios bulvės', 'žalių bulvių'],
        en: ['potato', 'potatoes', 'red potatoes', 'baby potatoes', 'mashed potato'],
        gramsPerPiece: 150, // medium potato
        pantry: false,
        weighable: true,
    },
    {
        key: 'potato_sweet',
        // NOT a potato variety in LT — the shelf item is 'Valgomieji batatai'
        // (verified). Substituting bulvės changes the dish.
        ltName: 'Batatai',
        enName: 'sweet potato',
        lt: ['batatas', 'batatai', 'batatų', 'saldžiosios bulvės', 'saldžiųjų bulvių'],
        en: ['sweet potato', 'sweet potatoes'],
        gramsPerPiece: 200,
        pantry: false,
        weighable: true,
    },
    {
        key: 'carrot',
        ltName: 'Morkos',
        enName: 'carrots',
        lt: ['morka', 'morkos', 'morkų'],
        en: ['carrot', 'carrots', 'large carrots'],
        gramsPerPiece: 80, // medium carrot
        pantry: false,
        weighable: true,
    },
    {
        key: 'beetroot',
        ltName: 'Burokėliai',
        enName: 'beetroot',
        lt: ['burokėlis', 'burokėlio', 'burokėliai', 'burokėlių', 'burokėlių lapai', 'burokėlių lapų'],
        en: ['beetroot', 'beets', 'beetroots', 'beet'],
        gramsPerPiece: 130, // medium beet
        pantry: false,
        weighable: true,
    },
    {
        key: 'beetroot_juice',
        ltName: 'Burokėlių sultys',
        enName: 'beetroot juice',
        lt: ['burokėlių sultys', 'burokėlių sulčių'],
        en: ['beetroot juice', 'beet juice'],
        gramsPerMl: 1.05,
        pantry: false,
    },
    {
        key: 'tomato',
        ltName: 'Pomidorai',
        enName: 'tomatoes',
        lt: ['pomidoras', 'pomidoro', 'pomidorai', 'pomidorų'],
        en: ['tomato', 'tomatoes'],
        gramsPerPiece: 120, // medium tomato
        pantry: false,
        weighable: true,
    },
    {
        key: 'tomato_cherry',
        ltName: 'Vyšniniai pomidorai',
        enName: 'cherry tomatoes',
        lt: ['vyšniniai pomidorai', 'vyšninių pomidorų'],
        en: ['cherry tomatoes', 'grape tomatoes', 'cherry or grape tomatoes'],
        gramsPerPiece: 15,
        pantry: false,
    },
    {
        key: 'cucumber',
        ltName: 'Agurkai',
        enName: 'cucumber',
        lt: ['agurkas', 'agurko', 'agurkai', 'agurkų', 'švieži agurkai', 'šviežių agurkų'],
        en: ['cucumber', 'cucumbers'],
        gramsPerPiece: 300, // one long cucumber
        pantry: false,
        weighable: true,
    },
    {
        key: 'bell_pepper',
        // 'Paprikos' alone is AMBIGUOUS on the shelf — the catalog carries
        // "Raudonos saldžiosios paprikos" and "Aitriosios paprikos PADRON" under
        // the same word, and the bare query silently bought 300 g of hot Padron
        // chillies for a goulash and again for a borscht. Name the sweet one.
        ltName: 'Saldžiosios paprikos',
        enName: 'bell pepper',
        lt: ['paprikos', 'paprikų', 'saldžioji paprika', 'saldžiosios paprikos', 'raudonoji paprika', 'raudonosios paprikos', 'saldi raudonoji paprika'],
        // 'red pepper' is this VEGETABLE, not black pepper — without these
        // forms the lookup matched the 'pepper' window and bought a spice jar.
        en: ['bell pepper', 'bell peppers', 'red bell pepper', 'sweet pepper', 'capsicum',
            'red pepper', 'red peppers', 'roasted red pepper', 'roasted red peppers',
            'jarred roasted red pepper', 'jarred roasted red peppers'],
        gramsPerPiece: 150,
        pantry: false,
        weighable: true,
    },
    {
        key: 'cabbage',
        ltName: 'Kopūstai',
        enName: 'cabbage',
        lt: ['kopūstas', 'kopūsto', 'kopūstai', 'kopūstų', 'baltagūžis kopūstas', 'baltagūžio kopūsto'],
        en: ['cabbage', 'white cabbage', 'green cabbage'],
        gramsPerPiece: 1500, // a whole head
        pantry: false,
        weighable: true,
    },
    {
        key: 'cabbage_red',
        // Fresh shelf item: 'Lietuviški raudongūžiai kopūstai' /
        // 'Raudonieji kopūstai CLEVER' (verified). A slaw asking for red
        // cabbage must not buy a white head.
        ltName: 'Raudongūžiai kopūstai',
        enName: 'red cabbage',
        lt: ['raudongūžiai kopūstai', 'raudongūžių kopūstų', 'raudonieji kopūstai', 'raudonųjų kopūstų',
            'raudonas kopūstas', 'raudono kopūsto', 'raudonasis kopūstas', 'raudonojo kopūsto'],
        en: ['red cabbage', 'purple cabbage'],
        gramsPerPiece: 900, // heads run smaller than white cabbage
        pantry: false,
        weighable: true,
    },
    {
        key: 'cauliflower',
        ltName: 'Žiediniai kopūstai',
        enName: 'cauliflower',
        lt: ['žiedinis kopūstas', 'žiedinio kopūsto', 'žiediniai kopūstai', 'žiedinių kopūstų', 'kalafioras', 'kalafioro'],
        en: ['cauliflower'],
        gramsPerPiece: 800, // one head
        pantry: false,
        weighable: true,
    },
    {
        key: 'broccoli',
        ltName: 'Brokoliai',
        enName: 'broccoli',
        lt: ['brokolis', 'brokolio', 'brokoliai', 'brokolių'],
        en: ['broccoli'],
        gramsPerPiece: 350, // one head
        pantry: false,
        weighable: true,
    },
    {
        key: 'brussels_sprouts',
        // NOTE: today every live 'Briuselio kopūstai' row is a GARDEN SEED
        // packet (verified) — the fresh vegetable is a known catalog gap. The
        // name is still what the shop will call it, and the matcher's
        // seed-packet rejection must do the filtering.
        ltName: 'Briuselio kopūstai',
        enName: 'brussels sprouts',
        lt: ['briuselio kopūstai', 'briuselio kopūstų', 'briuseliniai kopūstai', 'briuselinių kopūstų'],
        en: ['brussels sprouts', 'brussel sprouts', 'brussels sprout'],
        gramsPerPiece: 15, // one sprout
        pantry: false,
        weighable: true,
    },
    {
        key: 'fennel',
        // Fresh bulb: 'Pankoliai', 'Pankoliai fasuoti' (verified).
        ltName: 'Pankoliai',
        enName: 'fennel',
        lt: ['pankolis', 'pankolio', 'pankoliai', 'pankolių'],
        en: ['fennel', 'fennel bulb', 'fennel bulbs'],
        gramsPerPiece: 300, // one bulb
        pantry: false,
        weighable: true,
    },
    {
        key: 'zucchini',
        ltName: 'Cukinijos',
        enName: 'courgette',
        lt: ['cukinija', 'cukinijos', 'cukinijų'],
        en: ['zucchini', 'courgette', 'courgettes'],
        gramsPerPiece: 300, // medium courgette
        pantry: false,
        weighable: true,
    },
    {
        key: 'eggplant',
        ltName: 'Baklažanai',
        enName: 'aubergine',
        lt: ['baklažanas', 'baklažano', 'baklažanai', 'baklažanų'],
        en: ['eggplant', 'eggplants', 'aubergine', 'aubergines'],
        gramsPerPiece: 300,
        pantry: false,
        weighable: true,
    },
    {
        key: 'pumpkin',
        ltName: 'Moliūgai',
        enName: 'pumpkin',
        lt: ['moliūgas', 'moliūgo', 'moliūgai', 'moliūgų'],
        en: ['pumpkin', 'butternut squash', 'squash'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'celery',
        ltName: 'Salierai',
        enName: 'celery',
        lt: ['salierai', 'salierų', 'salierų stiebai', 'salierų stiebų', 'saliero stiebas'],
        en: ['celery', 'celery ribs', 'celery stalks', 'ribs celery', 'stalks celery'],
        gramsPerPiece: 40, // one stalk (rib)
        pantry: false,
    },
    {
        key: 'turnip',
        ltName: 'Ropės',
        enName: 'turnip',
        lt: ['ropė', 'ropės', 'ropių'],
        en: ['turnip', 'turnips'],
        gramsPerPiece: 250,
        pantry: false,
        weighable: true,
    },
    {
        key: 'radish',
        ltName: 'Ridikėliai',
        enName: 'radishes',
        lt: ['ridikėlis', 'ridikėliai', 'ridikėlių'],
        en: ['radish', 'radishes'],
        gramsPerPiece: 15,
        pantry: false,
    },
    {
        key: 'spinach',
        ltName: 'Špinatai',
        enName: 'spinach',
        lt: ['špinatai', 'špinatų', 'šaldyti špinatai', 'šaldytų špinatų'],
        en: ['spinach', 'baby spinach', 'fresh spinach', 'frozen spinach', 'frozen chopped spinach'],
        pantry: false,
    },
    {
        key: 'kale',
        ltName: 'Lapiniai kopūstai',
        enName: 'kale',
        lt: ['lapinis kopūstas', 'lapinio kopūsto', 'lapiniai kopūstai', 'lapinių kopūstų'],
        en: ['kale', 'kale leaves', 'torn kale'],
        pantry: false,
    },
    {
        key: 'lettuce',
        ltName: 'Salotos',
        enName: 'lettuce',
        lt: ['salotos', 'salotų', 'salotų lapai', 'salotų lapų'],
        en: ['lettuce', 'salad leaves', 'iceberg lettuce'],
        gramsPerPiece: 300, // one head
        pantry: false,
    },
    {
        key: 'arugula',
        ltName: 'Rukola',
        enName: 'rocket',
        lt: ['rukola', 'rukolos', 'gražgarstės', 'gražgarsčių'],
        en: ['arugula', 'rocket', 'rocket leaves'],
        pantry: false,
    },
    {
        key: 'greens',
        ltName: 'Žalumynai',
        enName: 'leafy greens',
        lt: ['žalumynai', 'žalumynų'],
        en: ['greens', 'leafy greens', 'salad greens', 'mixed greens'],
        pantry: false,
    },
    {
        key: 'mushrooms',
        ltName: 'Pievagrybiai',
        enName: 'mushrooms',
        lt: ['grybai', 'grybų', 'pievagrybiai', 'pievagrybių'],
        en: ['mushrooms', 'mushroom', 'button mushrooms'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'chanterelles',
        ltName: 'Voveraitės',
        enName: 'chanterelles',
        lt: ['voveraitės', 'voveraičių'],
        en: ['chanterelles', 'chanterelle mushrooms'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'oyster_mushrooms',
        // 'Kreivabūdės' (cat 14, live, verified 2026-07-27) — the catalog
        // spells the mushroom with ū, recipes write 'kreivabudžių'; both
        // spellings are listed so neither misses.
        ltName: 'Kreivabūdės',
        enName: 'oyster mushrooms',
        lt: ['kreivabūdės', 'kreivabūdžių', 'kreivabudės', 'kreivabudžių'],
        en: ['oyster mushroom', 'oyster mushrooms'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'corn_canned',
        ltName: 'Konservuoti kukurūzai',
        enName: 'canned corn',
        lt: ['kukurūzai', 'kukurūzų', 'konservuoti kukurūzai', 'konservuotų kukurūzų'],
        en: ['corn', 'canned corn', 'sweetcorn', 'frozen corn', 'corn kernels'],
        gramsPerMl: 0.7, // drained kernels poured into a cup
        pantry: false,
    },
    {
        key: 'peas',
        ltName: 'Žirneliai',
        enName: 'green peas',
        lt: ['žirneliai', 'žirnelių', 'žali žirneliai', 'žalių žirnelių', 'konservuoti žirneliai', 'konservuotų žirnelių', 'šaldyti žirneliai', 'šaldytų žirnelių'],
        en: ['peas', 'green peas', 'frozen peas'],
        gramsPerMl: 0.6,
        pantry: false,
    },
    {
        key: 'peas_dried',
        ltName: 'Žirniai',
        enName: 'dried peas',
        lt: ['žirniai', 'žirnių'],
        en: ['dried peas', 'split peas', 'yellow peas'],
        gramsPerMl: 0.75,
        pantry: false,
    },
    {
        key: 'beans_canned',
        ltName: 'Konservuotos pupelės',
        enName: 'canned beans',
        lt: ['pupelės', 'pupelių', 'konservuotos pupelės', 'konservuotų pupelių', 'raudonosios pupelės', 'raudonųjų pupelių', 'baltosios pupelės', 'baltųjų pupelių'],
        // "cranberry/borlotti beans" are BEANS. Without the compound spelled
        // out, the lookup kept the modifier and bought dried CRANBERRIES.
        en: ['beans', 'canned beans', 'black beans', 'kidney beans', 'pinto beans', 'cannellini beans',
            'butter beans', 'white beans', 'lima beans', 'great northern beans',
            'cranberry beans', 'shelled cranberry beans', 'borlotti beans'],
        pantry: false,
    },
    {
        key: 'chickpeas',
        // 53 live 'avinžirn' products (verified) — a common recipe staple the
        // table simply lacked. No density: canned-drained vs dry differ 2×.
        ltName: 'Avinžirniai',
        enName: 'chickpeas',
        lt: ['avinžirniai', 'avinžirnių', 'konservuoti avinžirniai', 'konservuotų avinžirnių'],
        en: ['chickpeas', 'chickpea', 'garbanzo beans', 'canned chickpeas'],
        pantry: false,
    },
    {
        key: 'dried_lentils',
        // Only 'Daiginti lęšiai' (sprouted) is live today (verified) — dry
        // lentils are a catalog gap, but the query is still the right word and
        // the nearest hit is at least a lentil.
        ltName: 'Lęšiai',
        enName: 'lentils',
        lt: ['lęšiai', 'lęšių', 'raudonieji lęšiai', 'raudonųjų lęšių', 'žalieji lęšiai', 'žaliųjų lęšių'],
        en: ['lentils', 'dried lentils', 'red lentils', 'green lentils', 'brown lentils', 'cooked lentils'],
        gramsPerMl: 0.8, // dry
        pantry: false,
    },
    {
        key: 'edamame',
        // Shelf: 'Sojų pupelės RIMI PLANET EDAMAME' (verified).
        ltName: 'Sojų pupelės edamame',
        enName: 'edamame',
        lt: ['edamame pupelės', 'edamame pupelių', 'sojų pupelės edamame'],
        en: ['edamame', 'edamame beans', 'frozen edamame'],
        pantry: false,
    },
    {
        key: 'green_beans',
        ltName: 'Šparaginės pupelės',
        enName: 'green beans',
        lt: ['šparaginės pupelės', 'šparaginių pupelių'],
        en: ['green beans', 'string beans'],
        pantry: false,
    },
    {
        key: 'avocado',
        ltName: 'Avokadai',
        enName: 'avocado',
        lt: ['avokadas', 'avokado', 'avokadai', 'avokadų'],
        en: ['avocado', 'avocados'],
        gramsPerPiece: 200,
        pantry: false,
        weighable: true,
    },

    // ── FRUIT & BERRIES ────────────────────────────────────────────────────
    {
        key: 'apple',
        ltName: 'Obuoliai',
        enName: 'apples',
        lt: ['obuolys', 'obuolio', 'obuoliai', 'obuolių'],
        en: ['apple', 'apples'],
        gramsPerPiece: 180, // medium apple
        pantry: false,
        weighable: true,
    },
    {
        key: 'pear',
        ltName: 'Kriaušės',
        enName: 'pears',
        lt: ['kriaušė', 'kriaušės', 'kriaušių'],
        en: ['pear', 'pears'],
        gramsPerPiece: 180,
        pantry: false,
        weighable: true,
    },
    {
        key: 'banana',
        ltName: 'Bananai',
        enName: 'bananas',
        // 'bananu' — the corpus prints the instrumental ("keiskite mažu bananu").
        lt: ['bananas', 'banano', 'bananai', 'bananų', 'bananu'],
        en: ['banana', 'bananas', 'ripe bananas', 'mashed bananas'],
        gramsPerPiece: 120, // peeled, edible weight
        pantry: false,
        weighable: true,
    },
    {
        key: 'lemon',
        ltName: 'Citrinos',
        enName: 'lemon',
        // Zest forms: you buy the lemon to zest it — the EN side already owns
        // 'lemon zest', and without the LT pair 'žievelės' read as dropped.
        lt: ['citrina', 'citrinos', 'citrinų', 'citrinos žievelė', 'citrinos žievelės', 'citrinų žievelės', 'citrinų žievelių'],
        en: ['lemon', 'lemons', 'lemon zest', 'lemon wedges'],
        gramsPerPiece: 90,
        pantry: false,
        weighable: true,
    },
    {
        key: 'lemon_juice',
        // Its own entry so a spoonful converts; the shopper still buys lemons
        // or a bottle — 'Citrinų sultys' is a real LT shelf product.
        ltName: 'Citrinų sultys',
        enName: 'lemon juice',
        lt: ['citrinų sultys', 'citrinų sulčių', 'citrinos sultys', 'citrinos sulčių'],
        en: ['lemon juice', 'juice of lemon', 'squeeze of lemon juice'],
        gramsPerMl: 1.03,
        pantry: false,
    },
    {
        key: 'lime',
        ltName: 'Žaliosios citrinos',
        enName: 'lime',
        lt: ['žalioji citrina', 'žaliosios citrinos', 'žaliųjų citrinų', 'laimas', 'laimo', 'laimai'],
        en: ['lime', 'limes', 'lime zest'],
        gramsPerPiece: 70,
        pantry: false,
        weighable: true,
    },
    {
        key: 'lime_juice',
        ltName: 'Žaliųjų citrinų sultys',
        enName: 'lime juice',
        lt: ['laimo sultys', 'laimo sulčių', 'žaliosios citrinos sultys', 'žaliosios citrinos sulčių'],
        en: ['lime juice', 'juice of lime'],
        gramsPerMl: 1.03,
        pantry: false,
    },
    {
        key: 'orange',
        ltName: 'Apelsinai',
        enName: 'oranges',
        // Zest forms, mirroring lemon.
        lt: ['apelsinas', 'apelsino', 'apelsinai', 'apelsinų',
            'apelsino žievelė', 'apelsino žievelės', 'apelsinų žievelės', 'apelsinų žievelių'],
        en: ['orange', 'oranges', 'orange zest'],
        gramsPerPiece: 200,
        pantry: false,
        weighable: true,
    },
    {
        key: 'orange_juice',
        ltName: 'Apelsinų sultys',
        enName: 'orange juice',
        lt: ['apelsinų sultys', 'apelsinų sulčių', 'apelsino sultys', 'apelsino sulčių'],
        en: ['orange juice', 'oj', 'fresh orange juice'],
        gramsPerMl: 1.04,
        pantry: false,
    },
    {
        key: 'apple_juice',
        ltName: 'Obuolių sultys',
        enName: 'apple juice',
        lt: ['obuolių sultys', 'obuolių sulčių'],
        en: ['apple juice'],
        gramsPerMl: 1.04,
        pantry: false,
    },
    {
        key: 'applesauce',
        // The shelf uses the diminutive: 'Ekologiška obuolių tyrelė MAMUKO'
        // (verified) — 'obuolių tyrė' alone finds nothing.
        ltName: 'Obuolių tyrelė',
        enName: 'applesauce',
        lt: ['obuolių tyrė', 'obuolių tyrės', 'obuolių tyrelė', 'obuolių tyrelės'],
        en: ['applesauce', 'apple sauce', 'unsweetened applesauce'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'kiwi',
        ltName: 'Kiviai',
        enName: 'kiwi',
        lt: ['kivis', 'kivio', 'kiviai', 'kivių'],
        en: ['kiwi', 'kiwis', 'kiwi fruit'],
        gramsPerPiece: 80,
        pantry: false,
    },
    {
        key: 'strawberry',
        ltName: 'Braškės',
        enName: 'strawberries',
        lt: ['braškės', 'braškių', 'šviežios braškės', 'šviežių braškių'],
        en: ['strawberry', 'strawberries'],
        gramsPerPiece: 15,
        pantry: false,
    },
    {
        key: 'blueberry',
        // 'Šilauogės' are the cultivated blueberries LT shops actually sell;
        // 'mėlynės' (wild bilberries) get their own entry below.
        ltName: 'Šilauogės',
        enName: 'blueberries',
        lt: ['šilauogės', 'šilauogių'],
        en: ['blueberry', 'blueberries'],
        pantry: false,
    },
    {
        key: 'bilberry',
        ltName: 'Mėlynės',
        enName: 'wild blueberries',
        lt: ['mėlynės', 'mėlynių', 'šviežios mėlynės', 'šviežių mėlynių'],
        en: ['wild blueberries', 'bilberries'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'cranberries',
        // Fresh 'Spanguolės kibirėlyje su vandeniu' is live (verified). No
        // density: fresh vs dried differ hugely.
        ltName: 'Spanguolės',
        enName: 'cranberries',
        lt: ['spanguolės', 'spanguolių', 'džiovintos spanguolės', 'džiovintų spanguolių'],
        en: ['cranberries', 'cranberry', 'dried cranberries', 'fresh cranberries'],
        pantry: false,
    },
    {
        key: 'blackberries',
        // Fresh 'Gervuogės RIMI' is live (verified).
        ltName: 'Gervuogės',
        enName: 'blackberries',
        lt: ['gervuogės', 'gervuogių'],
        en: ['blackberry', 'blackberries'],
        pantry: false,
    },
    {
        key: 'raspberry',
        ltName: 'Avietės',
        enName: 'raspberries',
        lt: ['avietės', 'aviečių'],
        en: ['raspberry', 'raspberries'],
        pantry: false,
    },
    {
        key: 'cherry',
        ltName: 'Vyšnios',
        enName: 'cherries',
        lt: ['vyšnia', 'vyšnios', 'vyšnių', 'vyšnių lapai', 'vyšnių lapų'],
        en: ['cherry', 'cherries', 'sour cherries'],
        gramsPerPiece: 8,
        pantry: false,
        weighable: true,
    },
    {
        key: 'currant_black',
        ltName: 'Juodieji serbentai',
        enName: 'blackcurrants',
        lt: ['serbentai', 'serbentų', 'juodieji serbentai', 'juodųjų serbentų', 'juodi serbentai', 'juodus serbentus', 'juodųjų serbentų lapai', 'juodųjų serbentų lapų'],
        en: ['blackcurrants', 'black currants', 'currants'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'currant_white',
        ltName: 'Baltieji serbentai',
        enName: 'white currants',
        lt: ['baltieji serbentai', 'baltųjų serbentų'],
        en: ['white currants'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'berries',
        ltName: 'Uogos',
        enName: 'berries',
        lt: ['uogos', 'uogų', 'šaldytos uogos', 'šaldytų uogų', 'miško uogos', 'miško uogų'],
        en: ['berries', 'mixed berries', 'frozen berries'],
        gramsPerMl: 0.6, // whole berries poured into a cup, gaps included
        pantry: false,
    },
    {
        key: 'grapes',
        ltName: 'Vynuogės',
        enName: 'grapes',
        lt: ['vynuogės', 'vynuogių'],
        en: ['grapes', 'seedless grapes'],
        pantry: false,
        weighable: true,
    },
    {
        key: 'plum',
        ltName: 'Slyvos',
        enName: 'plums',
        lt: ['slyva', 'slyvos', 'slyvų'],
        en: ['plum', 'plums'],
        gramsPerPiece: 60,
        pantry: false,
        weighable: true,
    },
    {
        key: 'prunes',
        ltName: 'Džiovintos slyvos',
        enName: 'prunes',
        lt: ['džiovintos slyvos', 'džiovintų slyvų'],
        en: ['prunes', 'dried plums'],
        pantry: false,
    },
    {
        key: 'peach',
        ltName: 'Persikai',
        enName: 'peaches',
        lt: ['persikas', 'persiko', 'persikai', 'persikų'],
        en: ['peach', 'peaches', 'nectarines'],
        gramsPerPiece: 150,
        pantry: false,
        weighable: true,
    },
    {
        key: 'mango',
        ltName: 'Mangai',
        enName: 'mango',
        lt: ['mangas', 'mango', 'mangai', 'mangų'],
        en: ['mangoes', 'ripe mango'],
        gramsPerPiece: 300,
        pantry: false,
        weighable: true,
    },
    {
        key: 'pomegranate',
        ltName: 'Granatai',
        enName: 'pomegranate',
        lt: ['granatas', 'granato', 'granatai', 'granatų'],
        en: ['pomegranate', 'pomegranate seeds'],
        gramsPerPiece: 300,
        pantry: false,
        weighable: true,
    },
    {
        key: 'clementine',
        // Clementines/tangerines are all sold as 'Mandarinai' here (verified:
        // 'Mandarinai dėžutėje', 'Mandarinai su lapais').
        ltName: 'Mandarinai',
        enName: 'clementines',
        lt: ['mandarinas', 'mandarinai', 'mandarinų', 'klementinai', 'klementinų'],
        en: ['clementine', 'clementines', 'mandarin', 'mandarins', 'tangerine', 'tangerines', 'satsuma', 'satsumas'],
        gramsPerPiece: 75,
        pantry: false,
        weighable: true,
    },
    {
        key: 'apricot',
        ltName: 'Abrikosai',
        enName: 'apricots',
        lt: ['abrikosas', 'abrikoso', 'abrikosai', 'abrikosų'],
        en: ['apricot', 'apricots'],
        gramsPerPiece: 45,
        pantry: false,
        weighable: true,
    },
    {
        key: 'apricots_dried',
        ltName: 'Džiovinti abrikosai',
        enName: 'dried apricots',
        lt: ['džiovinti abrikosai', 'džiovintų abrikosų'],
        en: ['dried apricots'],
        gramsPerMl: 0.65, // whole dried fruit packed in a cup
        pantry: false,
    },
    {
        key: 'dates',
        ltName: 'Datulės',
        enName: 'dates',
        lt: ['datulė', 'datulės', 'datulių'],
        en: ['dates', 'medjool dates', 'pitted dates'],
        gramsPerPiece: 8, // one pitted date
        pantry: false,
    },
    {
        key: 'raisins',
        ltName: 'Razinos',
        enName: 'raisins',
        lt: ['razinos', 'razinų'],
        en: ['raisins', 'sultanas'],
        gramsPerMl: 0.8,
        pantry: false,
    },

    // ── NUTS & SEEDS ───────────────────────────────────────────────────────
    {
        key: 'nuts',
        ltName: 'Riešutai',
        enName: 'nuts',
        lt: ['riešutai', 'riešutų'],
        en: ['nuts', 'mixed nuts', 'chopped nuts'],
        gramsPerMl: 0.5, // chopped
        pantry: false,
    },
    {
        key: 'walnuts',
        ltName: 'Graikiniai riešutai',
        enName: 'walnuts',
        lt: ['graikiniai riešutai', 'graikinių riešutų'],
        en: ['walnuts', 'chopped walnuts', 'walnut halves'],
        gramsPerMl: 0.5, // chopped
        pantry: false,
    },
    {
        key: 'pecans',
        // The shelf word is the botanical 'karijos', not 'pekano riešutai':
        // 'Pekaninės karijos ARIMEX' (verified).
        ltName: 'Pekaninės karijos',
        enName: 'pecans',
        lt: ['pekaninės karijos', 'pekaninių karijų', 'pekano riešutai', 'pekano riešutų'],
        en: ['pecans', 'pecan', 'pecan nuts', 'chopped pecans', 'pecan halves'],
        gramsPerMl: 0.5, // halves/chopped, like walnuts
        pantry: false,
    },
    {
        key: 'almonds',
        ltName: 'Migdolai',
        enName: 'almonds',
        lt: ['migdolai', 'migdolų', 'migdolų drožlės', 'migdolų drožlių'],
        en: ['almonds', 'slivered almonds', 'almond flakes', 'flaked almonds'],
        gramsPerMl: 0.55, // whole; flakes/slivers run lighter (~0.35–0.45)
        pantry: false,
    },
    {
        key: 'peanuts',
        ltName: 'Žemės riešutai',
        enName: 'peanuts',
        lt: ['žemės riešutai', 'žemės riešutų', 'sūdyti žemės riešutai', 'sūdytų žemės riešutų'],
        en: ['peanuts', 'salted peanuts', 'roasted peanuts'],
        gramsPerMl: 0.6,
        pantry: false,
    },
    {
        key: 'pine_nuts',
        ltName: 'Kedrinės pinijos',
        enName: 'pine nuts',
        lt: ['kedrinės pinijos', 'kedrinių pinijų', 'pinijos', 'pinijų', 'kedro riešutai', 'kedro riešutų'],
        en: ['pine nuts', 'pinenuts'],
        gramsPerMl: 0.55,
        pantry: false,
    },
    {
        key: 'pistachios',
        ltName: 'Pistacijos',
        enName: 'pistachios',
        lt: ['pistacijos', 'pistacijų'],
        en: ['pistachios', 'unsalted pistachios', 'shelled pistachios'],
        gramsPerMl: 0.5, // shelled kernels
        pantry: false,
    },
    {
        key: 'cashews',
        ltName: 'Anakardžiai',
        enName: 'cashews',
        lt: ['anakardžiai', 'anakardžių', 'anakardžio riešutai', 'anakardžio riešutų'],
        en: ['cashews', 'cashew nuts'],
        gramsPerMl: 0.55,
        pantry: false,
    },
    {
        key: 'hazelnuts',
        ltName: 'Lazdyno riešutai',
        enName: 'hazelnuts',
        lt: ['lazdyno riešutai', 'lazdyno riešutų', 'lazdynų riešutai', 'lazdynų riešutų'],
        en: ['hazelnuts'],
        gramsPerMl: 0.6, // dense round kernels pack well
        pantry: false,
    },
    {
        key: 'seeds_flax',
        ltName: 'Linų sėmenys',
        enName: 'flax seeds',
        lt: ['linų sėmenys', 'linų sėmenų', 'sėmenys', 'sėmenų'],
        en: ['flax seeds', 'flaxseed', 'linseed', 'ground flaxseed'],
        gramsPerMl: 0.7, // tiny slippery seeds pour surprisingly dense
        pantry: false,
    },
    {
        key: 'seeds_chia',
        ltName: 'Čija sėklos',
        enName: 'chia seeds',
        lt: ['čija sėklos', 'čija sėklų', 'chia sėklos', 'chia sėklų', 'chia', 'ispaninio šalavijo sėklos', 'ispaninio šalavijo sėklų'],
        en: ['chia seeds', 'chia'],
        gramsPerMl: 0.65,
        pantry: false,
    },
    {
        key: 'seeds_sunflower',
        ltName: 'Saulėgrąžos',
        enName: 'sunflower seeds',
        lt: ['saulėgrąžos', 'saulėgrąžų', 'saulėgrąžų sėklos', 'saulėgrąžų sėklų'],
        en: ['sunflower seeds', 'sunflower kernels'],
        gramsPerMl: 0.55, // hulled kernels
        pantry: false,
    },
    {
        key: 'seeds_pumpkin',
        ltName: 'Moliūgų sėklos',
        enName: 'pumpkin seeds',
        lt: ['moliūgų sėklos', 'moliūgų sėklų'],
        en: ['pumpkin seeds', 'pepitas'],
        gramsPerMl: 0.55,
        pantry: false,
    },
    {
        key: 'seeds_sesame',
        ltName: 'Sezamų sėklos',
        enName: 'sesame seeds',
        lt: ['sezamai', 'sezamų', 'sezamų sėklos', 'sezamų sėklų', 'skrudinti sezamai', 'skrudintų sezamų'],
        en: ['sesame seeds', 'white sesame seeds', 'toasted sesame seeds'],
        gramsPerMl: 0.6,
        pantry: false,
    },
    {
        key: 'fennel_seeds',
        // The SPICE, distinct from the fresh bulb: 'Pankolio sėklos SAUDA'
        // (verified). Beware the garden-seed packets ('ASEJA FINO') — the
        // matcher's seed-packet rejection handles those.
        ltName: 'Pankolio sėklos',
        enName: 'fennel seeds',
        lt: ['pankolio sėklos', 'pankolio sėklų', 'pankolių sėklos', 'pankolių sėklų'],
        en: ['fennel seeds', 'fennel seed', 'ground fennel'],
        gramsPerMl: 0.45, // whole seeds, like caraway
        pantry: true,
    },
    {
        key: 'seeds_poppy',
        ltName: 'Aguonos',
        enName: 'poppy seeds',
        lt: ['aguonos', 'aguonų'],
        en: ['poppy seeds'],
        gramsPerMl: 0.6,
        pantry: false,
    },
    {
        key: 'seeds_hemp',
        ltName: 'Kanapių sėklos',
        enName: 'hemp seeds',
        lt: ['kanapių sėklos', 'kanapių sėklų', 'kanapės', 'kanapių'],
        en: ['hemp seeds', 'hemp hearts', 'hemp protein'],
        gramsPerMl: 0.55,
        pantry: false,
    },
    {
        key: 'coconut_flakes',
        ltName: 'Kokosų drožlės',
        enName: 'desiccated coconut',
        lt: ['kokosų drožlės', 'kokosų drožlių', 'kokoso drožlės', 'kokoso drožlių'],
        en: ['desiccated coconut', 'coconut flakes', 'shredded coconut'],
        gramsPerMl: 0.35, // dried shavings — very airy
        pantry: false,
    },
    {
        key: 'coconut_milk',
        ltName: 'Kokosų pienas',
        enName: 'coconut milk',
        lt: ['kokosų pienas', 'kokosų pieno', 'kokoso pienas', 'kokoso pieno'],
        en: ['coconut milk', 'coconut cream'],
        gramsPerMl: 0.97,
        pantry: false,
    },
    {
        key: 'protein_powder',
        ltName: 'Baltymų milteliai',
        enName: 'protein powder',
        // Bare 'baltymai'/'baltymų' dropped: in a baking recipe those words
        // mean EGG WHITES. Too vague for either entry — see egg_white.
        lt: ['baltymų milteliai', 'baltymų miltelių'],
        en: ['protein powder', 'whey protein', 'pea protein'],
        gramsPerMl: 0.4, // fluffy spray-dried powder — a 30 g scoop is ~70 ml
        pantry: false,
    },

    // ── DRINKS & ALCOHOL ───────────────────────────────────────────────────
    {
        key: 'water',
        ltName: 'Vanduo',
        enName: 'water',
        lt: ['vanduo', 'vandens', 'karštas vanduo', 'karšto vandens', 'šaltas vanduo', 'šalto vandens'],
        en: ['water', 'cold water', 'hot water', 'warm water', 'boiling water'],
        gramsPerMl: 1.0,
        pantry: true,   // it comes out of the tap
        notSold: true,  // …which is why searching the catalog for it found a water BOWL
    },
    {
        key: 'water_mineral',
        ltName: 'Mineralinis vanduo',
        enName: 'mineral water',
        lt: ['mineralinis vanduo', 'mineralinio vandens'],
        en: ['mineral water', 'sparkling water'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'tea',
        ltName: 'Arbata',
        enName: 'tea',
        lt: ['arbata', 'arbatos', 'žalioji arbata', 'žaliosios arbatos', 'juodoji arbata', 'juodosios arbatos'],
        en: ['tea', 'black tea', 'green tea', 'brewed tea'],
        gramsPerMl: 1.0, // brewed
        pantry: true,
    },
    {
        key: 'coffee',
        ltName: 'Kava',
        enName: 'coffee',
        lt: ['kava', 'kavos', 'malta kava', 'maltos kavos'],
        en: ['coffee', 'strong coffee', 'espresso', 'brewed coffee'],
        // no density on purpose: 'kavos' can mean brewed (1.0) or grounds (~0.4)
        pantry: true,
    },
    {
        key: 'wine_white',
        ltName: 'Baltasis vynas',
        enName: 'white wine',
        lt: ['baltasis vynas', 'baltojo vyno', 'baltas vynas', 'balto vyno', 'sausas baltas vynas', 'sauso balto vyno'],
        en: ['white wine', 'dry white wine', 'chardonnay'],
        gramsPerMl: 0.99,
        pantry: false,
    },
    {
        key: 'wine_red',
        ltName: 'Raudonasis vynas',
        enName: 'red wine',
        lt: ['raudonasis vynas', 'raudonojo vyno', 'raudonas vynas', 'raudono vyno'],
        en: ['red wine', 'dry red wine'],
        gramsPerMl: 0.99,
        pantry: false,
    },
    {
        key: 'wine_cooking_chinese',
        ltName: 'Ryžių vynas',
        enName: 'chinese cooking wine',
        lt: ['ryžių vynas', 'ryžių vyno', 'kinų virimo vynas', 'kinų virimo vyno'],
        en: ['chinese cooking wine', 'shaoxing wine', 'rice wine', 'mijiu', 'taiwanese rice wine'],
        gramsPerMl: 0.99,
        pantry: false,
    },
    {
        key: 'vodka',
        ltName: 'Degtinė',
        enName: 'vodka',
        lt: ['degtinė', 'degtinės'],
        en: ['vodka'],
        gramsPerMl: 0.94, // 40% ABV — ethanol makes it lighter than water
        pantry: false,
    },
    {
        key: 'whiskey',
        ltName: 'Viskis',
        enName: 'whiskey',
        lt: ['viskis', 'viskio'],
        en: ['whiskey', 'whisky', 'bourbon'],
        gramsPerMl: 0.95,
        pantry: false,
    },
    {
        key: 'brandy',
        ltName: 'Brendis',
        enName: 'brandy',
        lt: ['brendis', 'brendžio', 'konjakas', 'konjako'],
        en: ['brandy', 'cognac'],
        gramsPerMl: 0.95,
        pantry: false,
    },
    {
        key: 'vermouth',
        // Cat 344 holds 16 live 'Vermutas …' listings including the dry ones a
        // cocktail recipe means ('Vermutas MARTINI DRY, 1 l', 'Vermutas
        // MARTINI EXTRA DRY, 15 %') — verified 2026-07-27.
        ltName: 'Vermutas',
        enName: 'vermouth',
        lt: ['vermutas', 'vermuto'],
        en: ['vermouth', 'dry vermouth', 'sweet vermouth', 'white vermouth'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'triple_sec',
        // 'Likeris DE KUYPER TRIPLE SEC', 'Apelsinų skonio likeris TRIPLE SEC
        // LE FAVORI' plus two COINTREAU listings (verified 2026-07-27). The
        // brand-bearing canonical name is deliberate, same as Likeris Kahlua
        // below: no product says 'apelsinų likeris'.
        ltName: 'Likeris Triple Sec',
        enName: 'triple sec',
        lt: ['triple sec', 'triple sec likeris', 'triple sec likerio'],
        en: ['triple sec', 'cointreau', 'orange liqueur'],
        gramsPerMl: 1.05, // sugar-heavy liqueur
        pantry: false,
    },
    {
        key: 'beer',
        // 975 live 'alus' products (verified).
        ltName: 'Alus',
        enName: 'beer',
        lt: ['alus', 'alaus', 'šviesus alus', 'šviesaus alaus', 'tamsus alus', 'tamsaus alaus'],
        en: ['beer', 'lager', 'ale', 'stout', 'dark beer'],
        gramsPerMl: 1.0,
        pantry: false,
    },
    {
        key: 'sparkling_wine',
        // 348 live 'putojantis vynas' products (verified); prosecco and
        // champagne recipes all shop this shelf.
        ltName: 'Putojantis vynas',
        enName: 'sparkling wine',
        lt: ['putojantis vynas', 'putojančio vyno', 'šampanas', 'šampano'],
        en: ['prosecco', 'sparkling wine', 'cava', 'champagne'],
        gramsPerMl: 0.99,
        pantry: false,
    },
    {
        key: 'coffee_liqueur',
        // Sold: 'Likeris KAHLUA, 16 %' (verified) — the query needs the brand
        // token because no product says 'kavos likeris'.
        ltName: 'Likeris Kahlua',
        enName: 'coffee liqueur',
        lt: ['kavos likeris', 'kavos likerio'],
        en: ['kahlua', 'kahlúa', 'coffee liqueur'],
        pantry: false,
    },
    {
        key: 'rum_white',
        // The shelf spells "white" in the brand tail, never in Lithuanian:
        // 'Romas CAPTAIN MORGAN WHITE', 'Romas EL GALIPOTE WHITE', 'Romas
        // SHIPMASTER SILVER WHITE' (cat 356 'Romas', 86 live bottles,
        // verified 2026-07-27) — no live product says 'baltasis romas', so
        // the canonical name keeps the English token the same way 'Likeris
        // Triple Sec' does. No `weighable`: a bottle, so the pack arithmetic
        // in shoppingAmount lands on one bottle whatever the pour.
        ltName: 'Romas White',
        enName: 'white rum',
        lt: ['baltasis romas', 'baltojo romo', 'baltas romas', 'balto romo'],
        en: ['white rum', 'light rum'],
        gramsPerMl: 0.94, // 37.5–40 % ABV, like vodka
        pantry: false,
    },
    {
        key: 'gin',
        // Cat 357 'Džinas': 67 live bottles ('Džinas BEEFEATER', 'Džinas
        // BOMBAY SAPPHIRE'…), verified 2026-07-27.
        ltName: 'Džinas',
        enName: 'gin',
        lt: ['džinas', 'džino'],
        en: ['gin', 'dry gin', 'london dry gin'],
        gramsPerMl: 0.94, // ~40 % ABV
        pantry: false,
    },
    {
        key: 'tequila',
        // Cat 360 'Tekila': 31 live bottles ('Tekila OLMECA BLANCO', 'Tekila
        // JOSE CUERVO SILVER'…), verified 2026-07-27.
        ltName: 'Tekila',
        enName: 'tequila',
        lt: ['tekila', 'tekilos'],
        en: ['tequila', 'silver tequila', 'blanco tequila', 'gold tequila'],
        gramsPerMl: 0.95,
        pantry: false,
    },
    {
        key: 'aperol',
        // 'Kartaus skonio spiritinis gėrimas APEROL, 0,7 l' / '1 l' (cat 355
        // 'Likeris', verified 2026-07-27). The label never says 'aperolis',
        // so the query carries the product's own words.
        ltName: 'Spiritinis gėrimas Aperol',
        enName: 'aperol',
        lt: ['aperolis', 'aperolio', 'aperol'],
        en: ['aperol'],
        gramsPerMl: 1.04, // sugar-heavy aperitif
        pantry: false,
    },
    {
        key: 'campari',
        // 'Spiritinis gėrimas CAMPARI, kartaus skonio' (cat 355, verified
        // 2026-07-27).
        ltName: 'Spiritinis gėrimas Campari',
        enName: 'campari',
        lt: ['campari', 'kampari'],
        en: ['campari'],
        gramsPerMl: 1.05, // sugar-heavy bitter
        pantry: false,
    },
    {
        key: 'amaretto',
        // BOTH shelf spellings are live — 'Likeris AMARETO RETRO' (cat 355)
        // and 'Likeris AMARETTO RETRO, 21 %' (688) — verified 2026-07-27; the
        // matcher's fuzzy pass bridges the one-letter gap either way.
        ltName: 'Likeris Amaretto',
        enName: 'amaretto',
        lt: ['amaretto', 'amareto', 'amaretto likeris', 'amaretto likerio'],
        en: ['amaretto', 'amaretto liqueur', 'almond liqueur'],
        gramsPerMl: 1.05,
        pantry: false,
    },
    {
        key: 'melon_liqueur',
        // The only melon liqueur on any shelf is 'Likeris KEGLEVICH
        // DELICIOUS VODKA & MELONE' (cat 355, verified 2026-07-27) — a
        // vodka-based sweet melon liqueur, the same role Midori plays in a
        // cocktail. Judgement call, documented: one honest product, and the
        // brand-pinned query names exactly that bottle (same device as
        // 'Likeris Kahlua').
        ltName: 'Likeris Keglevich Melone',
        enName: 'melon liqueur',
        lt: ['meliono likeris', 'meliono likerio', 'melionų likeris', 'melionų likerio'],
        en: ['melon liqueur', 'midori'],
        gramsPerMl: 1.02,
        pantry: false,
    },

    // ── RECOGNISED BUT NOT SOLD HERE ───────────────────────────────────────
    // Named honestly in `skipped` instead of being force-matched to whatever
    // shares a word. All verified absent from the live catalog. Serving-side
    // items (naan) and US-import specialties belong here until a shelf
    // actually stocks them.
    {
        key: 'naan',
        ltName: 'Naan duona',
        enName: 'naan',
        lt: ['naan duona', 'naan duonos'],
        en: ['naan', 'naan bread'],
        gramsPerPiece: 90, // one flatbread
        pantry: false,
        notSold: true,
    },
    {
        key: 'chamoy',
        ltName: 'Chamoy padažas',
        enName: 'chamoy',
        lt: ['chamoy'],
        en: ['chamoy sauce', 'chamoy'],
        pantry: false,
        notSold: true,
    },
    {
        key: 'mezcal',
        ltName: 'Mezcal',
        enName: 'mezcal',
        lt: ['mezcal', 'meskalis'],
        en: ['mezcal', 'mescal'],
        gramsPerMl: 0.94, // ~40% ABV, like vodka
        pantry: false,
        notSold: true,
    },
    {
        key: 'frangelico',
        ltName: 'Frangelico likeris',
        enName: 'frangelico',
        lt: ['frangelico'],
        en: ['frangelico', 'hazelnut liqueur'],
        pantry: false,
        notSold: true,
    },
    {
        key: 'creme_de_cassis',
        // No cassis liqueur on any live shelf (searched 'cassis' and the
        // blackcurrant-liqueur name shapes, 2026-07-27). The closest name hit
        // is blackcurrant VODKA — the very product the dropped-word guard was
        // built around — and it is not the syrupy liqueur a kir means.
        ltName: 'Juodųjų serbentų likeris',
        enName: 'creme de cassis',
        lt: ['juodųjų serbentų likeris', 'juodųjų serbentų likerio'],
        en: ['creme de cassis', 'crème de cassis', 'cassis', 'blackcurrant liqueur'],
        gramsPerMl: 1.06, // sugar-heavy liqueur
        pantry: false,
        notSold: true,
    },
    {
        key: 'sweet_sour_mix',
        // A cocktail-bar mixer no LT shop stocks (verified 2026-07-27 — the
        // only 'sour mix' name hit is VIDAL SOUR MIX, a bag of gummy candy).
        // Recognised so the candy can never answer a margarita.
        ltName: 'Kokteilių rūgštusis mišinys',
        enName: 'sweet and sour mix',
        lt: ['saldžiarūgštis kokteilių mišinys', 'saldžiarūgščio kokteilių mišinio'],
        en: ['sweet and sour mix', 'sweet-and-sour mix', 'sour mix', 'sweet and sour cocktail mix'],
        gramsPerMl: 1.05, // sugar syrup base
        pantry: false,
        notSold: true,
    },
    {
        key: 'coconut_extract',
        // Only VANILLA extract exists on the baking shelf (searched
        // 'ekstrakt', 2026-07-27); MALIBU and EL GALIPOTE COCONUT are
        // liqueurs, not a baking extract, and must not answer for one.
        ltName: 'Kokosų ekstraktas',
        enName: 'coconut extract',
        lt: ['kokosų ekstraktas', 'kokosų ekstrakto'],
        en: ['coconut extract', 'coconut essence'],
        gramsPerMl: 0.88, // alcohol-based, like vanilla extract
        pantry: true,
        notSold: true,
    },
    {
        key: 'elderflower_cordial',
        // No šeivamedžių sirupas anywhere (searched 'šeivamedž', 2026-07-27 —
        // only teas and a FANTA flavour carry the word). 'Likeris ST.GERMAIN'
        // IS elderflower, but a 20 % liqueur silently standing in for a
        // soft-drink syrup is a substitution a human should make.
        ltName: 'Šeivamedžių žiedų sirupas',
        enName: 'elderflower cordial',
        lt: ['šeivamedžių sirupas', 'šeivamedžių sirupo', 'šeivamedžių žiedų sirupas', 'šeivamedžių žiedų sirupo'],
        en: ['elderflower cordial', 'elderflower syrup'],
        gramsPerMl: 1.33, // sugar syrup
        pantry: false,
        notSold: true,
    },
    {
        key: 'marshmallow_fluff',
        // Spreadable fluff ≠ zefyrai (which ARE sold) — a jar of fluff is not
        // on any LT shelf (verified).
        ltName: 'Zefyrų kremas',
        enName: 'marshmallow fluff',
        lt: ['zefyrų kremas', 'zefyrų kremo'],
        en: ['marshmallow fluff', 'marshmallow creme', 'marshmallow cream'],
        pantry: false,
        notSold: true,
    },
    {
        key: 'liquid_smoke',
        ltName: 'Skystas dūmas',
        enName: 'liquid smoke',
        lt: ['skystas dūmas', 'skysto dūmo', 'skysti dūmai', 'skystų dūmų'],
        en: ['liquid smoke'],
        gramsPerMl: 1.0,
        pantry: false,
        notSold: true,
    },
    {
        key: 'graham_crackers',
        // Only Graham FLOUR bread exists here (verified); the cracker itself
        // is a US import. Digestives are the usual substitute — a human call,
        // not one this table should make silently.
        ltName: 'Graham krekeriai',
        enName: 'graham crackers',
        lt: ['graham krekeriai', 'graham krekerių', 'graham sausainiai', 'graham sausainių'],
        en: ['graham crackers', 'graham cracker', 'graham cracker crumbs'],
        pantry: false,
        notSold: true,
    },
    {
        key: 'coconut_aminos',
        ltName: 'Kokosų aminos padažas',
        enName: 'coconut aminos',
        lt: ['kokosų aminos'],
        en: ['coconut aminos'],
        gramsPerMl: 1.1, // soy-sauce-like
        pantry: false,
        notSold: true,
    },
];

/** key → entry. Populated by the same load-time pass that builds the index. */
const BY_KEY = new Map<string, IngredientInfo>();

/**
 * Every surface form (both languages, diacritics intact, lowercase) → entry.
 * Built once at module load. Ownership is exclusive: a form claimed by two
 * entries is a data bug, and the throw below turns it into a loud one the
 * moment the module is imported (the test suite asserts the same invariant).
 */
export const INGREDIENT_INDEX: ReadonlyMap<string, IngredientInfo> = (() => {
    const index = new Map<string, IngredientInfo>();
    for (const ing of INGREDIENTS) {
        if (BY_KEY.has(ing.key)) {
            throw new Error(`[ingredientData] duplicate key '${ing.key}'`);
        }
        BY_KEY.set(ing.key, ing);
        for (const form of [...ing.lt, ...ing.en]) {
            const prev = index.get(form);
            if (prev && prev !== ing) {
                throw new Error(
                    `[ingredientData] surface form '${form}' claimed by both '${prev.key}' and '${ing.key}'`,
                );
            }
            index.set(form, ing);
        }
    }
    return index;
})();

export function ingredientByKey(key: string): IngredientInfo | undefined {
    return BY_KEY.get(key);
}
