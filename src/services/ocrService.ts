import vision from '@google-cloud/vision';
import { GoogleGenerativeAI } from '@google/generative-ai';

const client = new vision.ImageAnnotatorClient({
    apiKey: process.env.GOOGLE_VISION_API_KEY
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

export const extractTextFromImage = async (imageBase64: string): Promise<string> => {
    const [result] = await client.textDetection({
        image: {
            content: imageBase64
        }
    });

    const detections = result.textAnnotations;
    if (!detections || detections.length === 0) {
        throw new Error('No text detected in image');
    }

    return detections[0].description || '';
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

Receipt text:
${text}`;
const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://192.168.1.127:11434';
const fetchResponse = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        model: 'gemma4:e4b',
        prompt,
        stream: false,
        options: {
            num_predict: 8000
        }
    }),
    signal: AbortSignal.timeout(120000)
});

const data: any = await fetchResponse.json();
const responseText = data.response;

    console.log('Raw Ollama response:', responseText);

    try {
        const clean = responseText.replace(/```json|```/g, '').trim();
        return JSON.parse(clean);
    } catch (error) {
        console.error('Failed to parse, raw response was:', responseText);
        throw new Error('Failed to parse receipt data from Ollama response');
    }
};