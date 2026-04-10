import { Queue, Worker, Job } from 'bullmq';

const connection = {
    host: process.env.REDIS_HOST || '192.168.1.212',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

export const receiptQueue = new Queue('receipt-processing', { connection });

export const startWorker = () => {
    const worker = new Worker('receipt-processing', async (job: Job) => {
        const { receiptId, parsedData } = job.data;

        const { updateReceiptDetails } = await import('../models/receiptModel');
        const { updateReceiptStore } = await import('../models/receiptModel');
        const { processReceipt } = await import('./receiptProcessingService');

        try {
            // Update status to processing
            await updateReceiptDetails(receiptId, null, null, 'processing', parsedData);

            const result = await processReceipt(receiptId, parsedData);
            await updateReceiptStore(receiptId, result.storeId);

            await updateReceiptDetails(
                receiptId,
                parsedData.receiptNo,
                new Date(parsedData.date),
                'completed'
            );

            return result;
        } catch (error) {
            await updateReceiptDetails(receiptId, null, null, 'failed');
            throw error;
        }
    }, { connection, concurrency: 1 });

    worker.on('completed', (job) => {
        console.log(`Receipt job ${job.id} completed`);
    });

    worker.on('failed', (job, error) => {
        console.error(`Receipt job ${job?.id} failed:`, error.message);
    });

    return worker;
};