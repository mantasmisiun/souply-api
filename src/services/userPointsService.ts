import { addPoints, getPoints } from '../models/userModel.js';

// Level N requires N*10 points beyond the previous level.
// Cumulative threshold for level N = N*(N+1)*5
// L1: 10, L2: 30, L3: 60, L4: 100, L5: 150 ...
export const cumulativePointsForLevel = (level: number): number => level * (level + 1) * 5;

export const levelForPoints = (points: number): number => {
    let level = 1;
    while (cumulativePointsForLevel(level) <= points) level++;
    return level;
};

export const levelProgress = (points: number): {
    level: number;
    currentLevelStart: number;
    nextLevelAt: number;
    pointsIntoLevel: number;
    pointsNeededForNext: number;
    progressFraction: number;
} => {
    const level = levelForPoints(points);
    const currentLevelStart = level <= 1 ? 0 : cumulativePointsForLevel(level - 1);
    const nextLevelAt = cumulativePointsForLevel(level);
    const pointsIntoLevel = points - currentLevelStart;
    const pointsNeededForNext = nextLevelAt - currentLevelStart;
    return {
        level,
        currentLevelStart,
        nextLevelAt,
        pointsIntoLevel,
        pointsNeededForNext,
        progressFraction: pointsIntoLevel / pointsNeededForNext,
    };
};

export const awardReceiptPoints = async (userId: string, itemCount: number, conn?: any) => {
    if (itemCount <= 0) return;
    await addPoints(userId, itemCount, conn);
};

export const awardSwipePoint = async (userId: string, conn?: any) => {
    await addPoints(userId, 1, conn);
};

export const getUserPointsProfile = async (userId: string) => {
    const points = await getPoints(userId);
    return { points, ...levelProgress(points) };
};
