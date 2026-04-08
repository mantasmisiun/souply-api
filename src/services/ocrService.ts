import vision from '@google-cloud/vision';
import { GoogleGenerativeAI } from '@google/generative-ai';

let visionClient: any = null;

const getVisionClient = () => {
    if (!visionClient) {
        visionClient = new vision.ImageAnnotatorClient({
            apiKey: process.env.GOOGLE_VISION_API_KEY
        });
    }
    return visionClient;
};

let geminiModel: any = null;

const getGeminiModel = () => {
    if (!geminiModel) {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
        geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    }
    return geminiModel;
};

export const extractTextFromImage = async (imageBase64: string): Promise<string> => {
    const [result] = await getVisionClient().documentTextDetection({
        image: {
            content: imageBase64
        }
    });

    const fullText = result.fullTextAnnotation?.text || result.textAnnotations?.[0]?.description;
    if (!fullText) {
        throw new Error('No text detected in image');
    }

    return fullText;
};

export const parseReceiptTextWithOllama = async (text: string): Promise<any> => {
    const prompt = `You are a receipt parser. Extract the following information from this Lithuanian grocery receipt text and return ONLY a JSON object with no markdown or extra text:
{
    "chainName": "full legal company name e.g. UAB RIMI LIETUVA",
    "storeName": "store code/branch name e.g. T703",
    "storeAddress": "full address",
    "receiptNo": "receipt number found after Kvito Nr. or Kvito numeris",
    "date": "YYYY-MM-DD HH:mm:ss",
    "items": [
        {
            "name": "full product name as shown on receipt",
            "brandName": "brand name extracted from product name, null if no brand identifiable",
            "price": 0.00,
            "quantity": 1,
            "isWeighable": false,
            "promoPrice": null
        }
    ],
    "total": 0.00
}
Rules for name:
- Always use the COMPLETE product name as shown on the receipt
- Do not shorten, summarize or truncate the product name
- Include all descriptive words, weight, and volume information

Rules for price:
- Always use unit price, never total price
- If receipt shows X vnt. X Y EUR then price is Y

Rules for isWeighable:
- Set isWeighable to true ONLY if the receipt shows a pattern like 0,862 kg X 1,19 EUR/kg
- Otherwise always set isWeighable to false

Rules for promoPrice:
- If a discount Nuol. is shown, calculate: (original total - discount) / quantity
- promoPrice must always be per unit, never a total
- If no discount exists set promoPrice to null

Rules for brandName:
- Extract the COMPLETE brand name from the product name
- Brand names are usually in ALL CAPS or are a distinct proper noun
- If no brand is identifiable set brandName to null

Rules for storeName:
- Look for a store code/branch identifier on the receipt e.g. T703, X-912 MAXIMA
- It is usually found near the top of the receipt or after the expenses section
- If no store code is identifiable, use store address as storeName

Receipt text:
${text}`;
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://192.168.1.127:11434';
    const fetchResponse = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gemma4:e4b',
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: 'You are a JSON API. You only output valid JSON objects. Never write comments, explanations, markdown, or any text outside of the JSON object.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            options: {
                num_predict: -1,
                temperature: 0
            }
        }),
        signal: AbortSignal.timeout(120000)
    });

    const rawText = await fetchResponse.text();
    console.log('Parse API raw response:', rawText.slice(0, 300));
    const data: any = JSON.parse(rawText);
    const responseText = data.message.content;

    console.log('Raw Ollama response:', responseText);

    try {
        const clean = responseText.replace(/```json|```/g, '').trim();
        return JSON.parse(clean);
    } catch (error) {
        console.error('Failed to parse, raw response was:', responseText);
        throw new Error('Failed to parse receipt data from Ollama response');
    }
};

export const assignCategoriesToProducts = async (
    products: { name: string; brandName: string | null }[],
    categories: { id: number; parentCategoryId: number | null; name: string }[]
): Promise<{ index: number; categoryId: number | null }[]> => {

    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://192.168.1.127:11434';

    const chatRequest = async (systemPrompt: string, userPrompt: string): Promise<string> => {
        const fetchResponse = await fetch(`${ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemma4:e4b',
                stream: false,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                options: { num_predict: -1, temperature: 0 }
            }),
            signal: AbortSignal.timeout(120000)
        });
        const data: any = await fetchResponse.json();
        return data.message.content;
    };

    // Get L1, L2, L3 categories
    const l1Categories = categories.filter(c => c.parentCategoryId === null);
    const l2Categories = categories.filter(c => l1Categories.some(l1 => l1.id === c.parentCategoryId));
    const l3Categories = categories.filter(c => l2Categories.some(l2 => l2.id === c.parentCategoryId));

    const results: { index: number; categoryId: number | null }[] = [];

    for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const productLabel = `${product.brandName ? product.brandName + ' ' : ''}${product.name}`;

        try {
            // Step 1 — pick L1
            const l1List = l1Categories.map(c => `${c.id}: ${c.name}`).join('\n');
            const l1Response = await chatRequest(
                'You are a JSON API. Output only a valid JSON object, no explanations.',
                `Which top-level grocery category does this product belong to?\nProduct: ${productLabel}\n\nCategories:\n${l1List}\n\nReturn ONLY this JSON with the numeric ID from the list above: {"categoryId": 123}`
            );
            const l1Clean = l1Response.replace(/```json|```/g, '').trim();
            const l1Result = JSON.parse(l1Clean);
            const l1Id = l1Result.categoryId;

            // Step 2 — pick L2 within that L1
            const l2List = l2Categories
                .filter(c => c.parentCategoryId === l1Id)
                .map(c => `${c.id}: ${c.name}`)
                .join('\n');
            const l2Response = await chatRequest(
                'You are a JSON API. Output only a valid JSON object, no explanations.',
                `Which subcategory does this product belong to?\nProduct: ${productLabel}\n\nSubcategories:\n${l2List}\n\nReturn ONLY this JSON with the numeric ID from the list above: {"categoryId": 123}`
            );
            const l2Clean = l2Response.replace(/```json|```/g, '').trim();
            const l2Result = JSON.parse(l2Clean);
            const l2Id = l2Result.categoryId;

            // Step 3 — pick L3 within that L2
            const l3List = l3Categories
                .filter(c => c.parentCategoryId === l2Id)
                .map(c => `${c.id}: ${c.name}`)
                .join('\n');
            const l3Response = await chatRequest(
                'You are a JSON API. Output only a valid JSON object, no explanations.',
                `Which specific subcategory does this product belong to?\nProduct: ${productLabel}\n\nSubcategories:\n${l3List}\n\nReturn ONLY this JSON with the numeric ID from the list above: {"categoryId": 123}`
            );
            const l3Clean = l3Response.replace(/```json|```/g, '').trim();
            const l3Result = JSON.parse(l3Clean);

            results.push({ index: i, categoryId: l3Result.categoryId });
            console.log(`Product "${productLabel}" → categoryId: ${l3Result.categoryId}`);

        } catch (error) {
            console.error(`Failed to assign category for product "${productLabel}":`, error);
            results.push({ index: i, categoryId: null });
        }
    }

    return results;
};