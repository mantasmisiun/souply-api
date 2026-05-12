import * as cheerio from 'cheerio';

const res = await fetch('https://www.norfa.lt/akciju-puslapiai/praktiski-pasiulymai/', {
    headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'lt-LT,lt;q=0.9',
    },
});
const html = await res.text();
const $ = cheerio.load(html);

const names: string[] = [];
$('div.c-product.c-product--compact').each((_, el) => {
    const card = $(el);
    const oldPrice = card.find('.c-product__old-price').first().text().trim();
    if (!oldPrice) return;
    const name = card.find('.c-product__name').first().text().trim();
    if (name) names.push(name);
});

// Find aggregated patterns
const patterns = {
    rusius: names.filter(n => /\d+\s*rūšių/i.test(n)),
    multipleWeights: names.filter(n => /\d+\s*(?:g|ml|l|kg).*,.*\d+\s*(?:g|ml|l|kg)/i.test(n)),
    arba: names.filter(n => /\barba\b/i.test(n)),
    semicolonOrCommaWithBrands: names.filter(n => n.includes(';')),
};

console.log(`Total with old price: ${names.length}`);
console.log(`\nWith "N rūšių": ${patterns.rusius.length}`);
patterns.rusius.forEach(n => console.log(' ', n));

console.log(`\nMultiple weights: ${patterns.multipleWeights.length}`);
patterns.multipleWeights.slice(0, 10).forEach(n => console.log(' ', n));

console.log(`\nWith "arba": ${patterns.arba.length}`);
patterns.arba.slice(0, 10).forEach(n => console.log(' ', n));

console.log(`\nWith semicolon: ${patterns.semicolonOrCommaWithBrands.length}`);
patterns.semicolonOrCommaWithBrands.slice(0, 10).forEach(n => console.log(' ', n));

// Show some that look "clean" (single product) vs complex
const complex = new Set([...patterns.rusius, ...patterns.multipleWeights, ...patterns.arba, ...patterns.semicolonOrCommaWithBrands]);
const clean = names.filter(n => !complex.has(n));
console.log(`\nClean (no detected aggregation): ${clean.length} / ${names.length}`);
console.log('Sample clean names:');
clean.slice(0, 10).forEach(n => console.log(' ', n));
