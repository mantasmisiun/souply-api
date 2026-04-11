import { Queue, Worker, Job } from 'bullmq';

const connection = {
    host: process.env.REDIS_HOST || '192.168.1.212',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

export const receiptQueue = new Queue('receipt-processing', { connection });

export const startWorker = () => {
    const worker = new Worker('receipt-processing', async (job: Job) => {
        const { receiptId, parsedData } = job.data;

        const { updateReceiptDetails, updateReceiptStore, getReceiptById, getReceiptByReceiptNoAndUser, deleteReceipt } = await import('../models/receiptModel');
        const { deleteReceiptImage } = await import('../services/storageService');
        const { processReceipt } = await import('./receiptProcessingService');

        try {
            await updateReceiptDetails(receiptId, null, null, 'processing', parsedData);

            if (parsedData.receiptNo) {
                const receipt = await getReceiptById(receiptId);
                
                // Check for completed duplicate
                const completedDuplicate = await getReceiptByReceiptNoAndUser(parsedData.receiptNo, receipt.userId, receiptId);
                if (completedDuplicate && completedDuplicate.processingStatus === 'completed') {
                    await deleteReceiptImage(receipt.filePath);
                    await deleteReceipt(receiptId);
                    return;
                }
                
                // Delete any failed duplicates to clean up
                const failedDuplicate = await getReceiptByReceiptNoAndUser(parsedData.receiptNo, receipt.userId, receiptId);
                if (failedDuplicate && failedDuplicate.processingStatus === 'failed') {
                    await deleteReceiptImage(failedDuplicate.filePath);
                    await deleteReceipt(failedDuplicate.id);
                }
            }

            const result = await processReceipt(receiptId, parsedData);
            await updateReceiptStore(receiptId, result.storeId);
            await updateReceiptDetails(receiptId, parsedData.receiptNo, new Date(parsedData.date), 'completed');

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