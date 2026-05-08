import {
    getLastThreeReceiptBurstFlags,
    getPendingMandatorySwipeCount,
    incrementMandatorySwipesCompleted,
    setHasBurstSwipes,
    setMandatorySwipesRequired,
} from '../models/receiptModel.js';

// Swipes under this dwell are counted as burst within a mandatory session.
export const BURST_DWELL_MS = 1000;

// How many mandatory swipes are required per receipt upload.
export const MANDATORY_SWIPES_PER_RECEIPT = 3;

export const isBurstSwipe = (dwellMs: number): boolean => dwellMs < BURST_DWELL_MS;

/**
 * Called after receipt processing completes and the swipe queue is built.
 * Sets mandatorySwipesRequired to min(MANDATORY_SWIPES_PER_RECEIPT, availablePairs).
 */
export const initMandatorySwipeSession = async (
    receiptId: number,
    availablePairCount: number,
    conn?: any
): Promise<number> => {
    const required = Math.min(MANDATORY_SWIPES_PER_RECEIPT, availablePairCount);
    await setMandatorySwipesRequired(receiptId, required, conn);
    return required;
};

/**
 * Records one completed mandatory swipe. Pass dwellMs so burst tracking works.
 * Returns whether the session is now fully complete.
 */
export const recordMandatorySwipe = async (
    receiptId: number,
    dwellMs: number,
    conn?: any
): Promise<{ complete: boolean; wasBurst: boolean }> => {
    const wasBurst = isBurstSwipe(dwellMs);
    await incrementMandatorySwipesCompleted(receiptId, conn);
    if (wasBurst) {
        await setHasBurstSwipes(receiptId, conn);
    }
    return { complete: false, wasBurst };
};

/**
 * Returns true if the user has any receipts with incomplete mandatory swipes.
 * Used to gate basket comparison results.
 */
export const hasPendingMandatorySwipes = async (userId: string): Promise<boolean> => {
    const count = await getPendingMandatorySwipeCount(userId);
    return count > 0;
};

/**
 * Returns true if ALL of the last 3 receipt uploads had burst swipe sessions,
 * which triggers the in-app warning message.
 */
export const shouldShowBurstWarning = async (userId: string): Promise<boolean> => {
    const flags = await getLastThreeReceiptBurstFlags(userId);
    return flags.length === 3 && flags.every(Boolean);
};
