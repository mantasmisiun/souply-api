import * as fs from 'fs';
import * as path from 'path';
import { receiptQueue } from '../services/queueService';
import { extractTextFromImage } from '../services/ocrService';
import { parseReceiptTextWithOllama } from '../services/ocrService';
import { convertPdfToImageBuffer } from '../services/pdfService';
import { uploadReceiptImage } from '../services/storageService';
import pool from '../config/db';

const RECEIPTS_DIR = path.join(__dirname, '../../receipts/receipt pdf');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

const processAllReceipts = async () => {
    const files = fs.readdirSync(RECEIPTS_DIR).filter(f => f.endsWith('.pdf'));
    console.log(`Found ${files.length} PDF receipts`);

    for (const file of files) {
        try {
            console.log(`Processing: ${file}`);
            const pdfBuffer = fs.readFileSync(path.join(RECEIPTS_DIR, file));

            // Convert PDF to image
            const imageBuffer = await convertPdfToImageBuffer(pdfBuffer);
            const finalImageBase64 = imageBuffer.toString('base64');

            // Upload to MinIO
            const imageUrl = await uploadReceiptImage(imageBuffer, file.replace('.pdf', '.jpg'), 'image/jpeg');

            // OCR and parse
            const text = await extractTextFromImage(finalImageBase64);
            const parsed = await parseReceiptTextWithOllama(text);

            // Create receipt entry
            const [result]: any = await pool.query(
                'INSERT INTO Receipt (userId, storeId, filePath, fileType) VALUES (?, ?, ?, ?)',
                [SYSTEM_USER_ID, null, imageUrl, 'image/jpeg']
            );
            const receiptId = result.insertId;

            // Add to queue
            await receiptQueue.add('process-receipt', { receiptId, parsedData: parsed });
            console.log(`Queued receipt ${receiptId} from ${file}`);

        } catch (error: any) {
            console.error(`Failed to queue ${file}:`, error.message);
        }
    }

    console.log('All receipts queued!');
    process.exit(0);
};

processAllReceipts();