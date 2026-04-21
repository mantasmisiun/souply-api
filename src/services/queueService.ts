import { Queue, Worker, Job } from 'bullmq';
import { normalizeReceiptDateForStorage, normalizeReceiptNo } from '../utils/receiptMetadata.js';

const connection = {
    host: process.env.REDIS_HOST || '192.168.1.212',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

export const receiptQueue = new Queue('receipt-processing', { connection });

export const startWorker = () => {
    const worker = new Worker('receipt-processing', async (job: Job) => {
        const { receiptId, parsedData } = job.data;
        const normalizedReceiptNo = normalizeReceiptNo(parsedData?.receiptNo, parsedData?.footer?.rawText);
        const normalizedReceiptDate = normalizeReceiptDateForStorage(parsedData?.date);

        parsedData.receiptNo = normalizedReceiptNo;
        parsedData.date = normalizedReceiptDate;

        const { updateReceiptDetails, updateReceiptStore, getReceiptById, getReceiptByReceiptNoAndUser, deleteReceipt } = await import('../models/receiptModel.js');
        const { deleteReceiptImage } = await import('../services/storageService.js');
        const { processReceipt } = await import('./receiptProcessingService.js');

        try {
            await updateReceiptDetails(receiptId, null, null, 'processing', parsedData);

            if (normalizedReceiptNo) {
                const receipt = await getReceiptById(receiptId);
                
                // Check for completed duplicate
                const completedDuplicate = await getReceiptByReceiptNoAndUser(normalizedReceiptNo, receipt.userId, receiptId);
                if (completedDuplicate && completedDuplicate.processingStatus === 'completed') {
                    await deleteReceiptImage(receipt.filePath);
                    await deleteReceipt(receiptId);
                    return;
                }
                
                // Delete any failed duplicates to clean up
                const failedDuplicate = await getReceiptByReceiptNoAndUser(normalizedReceiptNo, receipt.userId, receiptId);
                if (failedDuplicate && failedDuplicate.processingStatus === 'failed') {
                    await deleteReceiptImage(failedDuplicate.filePath);
                    await deleteReceipt(failedDuplicate.id);
                }
            }

            const result = await processReceipt(receiptId, parsedData);
            await updateReceiptStore(receiptId, result.storeId);
            await updateReceiptDetails(receiptId, normalizedReceiptNo, normalizedReceiptDate, 'completed');

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
