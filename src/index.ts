import express from 'express';
import dotenv from 'dotenv';
import pool from './config/db';
import storeRoutes from './routes/storeRoutes';
import productRoutes from './routes/productRoutes';
import categoryRoutes from './routes/categoryRoutes';
import storeProductRoutes from './routes/storeProductRoutes';
import priceRoutes from './routes/priceRoutes';
import { errorHandler } from './middleware/errorHandler';
import userRoutes from './routes/userRoutes';
import basketRoutes from './routes/basketRoutes';
import basketItemRoutes from './routes/basketItemRoutes';
import shoppingListRoutes from './routes/shoppingListRoutes';
import shoppingListItemRoutes from './routes/shoppingListItemRoutes';
import receiptRoutes from './routes/receiptRoutes';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './config/swagger';
import { receiptQueue, startWorker } from './services/queueService';
import { convertPdfToImageBuffer } from './services/pdfService';
import { extractTextFromImage, parseReceiptTextWithOllama } from './services/ocrService';
import { uploadReceiptImage } from './services/storageService';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

app.use('/api', storeRoutes);
app.use('/api', categoryRoutes);
app.use('/api', productRoutes);
app.use('/api', storeProductRoutes);
app.use('/api', priceRoutes);
app.use('/api', userRoutes);
app.use('/api', basketRoutes);
app.use('/api', basketItemRoutes);
app.use('/api', shoppingListRoutes);
app.use('/api', shoppingListItemRoutes);
app.use('/api', receiptRoutes);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.post('/api/receipts/upload', async (req, res, next) => {
    let receiptId: number | null = null;
    try {
        const { imageBase64, filename, mimeType } = req.body;

        let imageBuffer: Buffer;
        let finalMimeType = mimeType || 'image/jpeg';

        if (mimeType === 'application/pdf') {
            const pdfBuffer = Buffer.from(imageBase64, 'base64');
            imageBuffer = await convertPdfToImageBuffer(pdfBuffer);
            finalMimeType = 'image/jpeg';
        } else {
            imageBuffer = Buffer.from(imageBase64, 'base64');
        }

        const finalImageBase64 = imageBuffer.toString('base64');
        const imageFilename = filename ? filename.replace('.pdf', '.jpg') : 'receipt.jpg';
        const imageUrl = await uploadReceiptImage(imageBuffer, imageFilename, finalMimeType);

        const text = await extractTextFromImage(finalImageBase64);
        const parsed = await parseReceiptTextWithOllama(text);

        const { createReceipt } = await import('./models/receiptModel');
        receiptId = await createReceipt(
            '00000000-0000-0000-0000-000000000000',
            null,
            imageUrl,
            finalMimeType
        );

        await receiptQueue.add('process-receipt', {
            receiptId,
            parsedData: parsed
        });

        res.json({ message: 'Receipt uploaded and queued for processing', receiptId, parsed });
    } catch (error) {
        console.error('RECEIPT UPLOAD ERROR:', error);
        if (receiptId) {
            const { updateReceiptDetails } = await import('./models/receiptModel');
            await updateReceiptDetails(receiptId, null, null, 'failed').catch(() => {});
        }
        next(error);
    }
});
// 404 handler for unknown routes
app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Error handler must be last
app.use(errorHandler);
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});
startWorker();
console.log('Receipt queue worker started');

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});