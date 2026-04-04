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

export const parseReceiptText = async (text: string): Promise<any> => {
const prompt = `
You are a receipt parser. Extract the following information from this Lithuanian grocery receipt text and return ONLY a JSON object with no markdown or extra text:
{
    "chainName": "full legal company name e.g. UAB RIMI LIETUVA",
    "storeName": "store code/branch name e.g. T703",
    "storeAddress": "full address",
    "receiptNo": "receipt number found after 'Kvito Nr.' or 'Kvito numeris'",
    "date": "YYYY-MM-DD HH:mm:ss",
    "items": [
        {
            "name": "product name",
            "price": 0.00,
            "quantity": 1,
            "isWeighable": false,
            "promoPrice": "per unit price after discount. Calculate by dividing total discounted price by quantity. null if no discount"
        }
    ],
    "total": 0.00
}

Rules for isWeighable:
- Set isWeighable to true ONLY if the receipt shows a pattern like "0,862 kg X 1,19 EUR/kg" indicating weight and price per kg
- Otherwise always set isWeighable to false

Rules for promoPrice:
- If a discount (Nuol.) is shown, calculate: (original total - discount) / quantity
- promoPrice must always be per unit, never a total
- If no discount exists set promoPrice to null

Receipt text:
${text}
`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    console.log('Raw Gemini response:', response);
    
    try {
        const clean = response.replace(/```json|```/g, '').trim();
        return JSON.parse(clean);
    } catch (error) {
        throw new Error('Failed to parse receipt data from AI response');
    }
};