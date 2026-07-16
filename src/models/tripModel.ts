import pool from '../config/db.js';
import type { Connection } from 'mysql2/promise';
import { deriveTripStage, type TripStage, type TripStageFacts } from '../services/tripStageService.js';

/**
 * Souply 2.0 trip aggregate (Phase 1a). Additive layer over the existing
 * Basket / ShoppingList / Receipt tables — v1.x paths never touch it.
 * Stage is DERIVED on read (tripStageService), never stored.
 */

export interface TripRow {
    id: number;
    createdByUserId: string;
    householdId: number | null;
    name: string | null;
    isAdHoc: 0 | 1;
    scoreExempt: 0 | 1;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export const createTrip = async (
    createdByUserId: string,
    opts: { name?: string | null; isAdHoc?: boolean; scoreExempt?: boolean; householdId?: number | null; createdAt?: string | Date; archivedAt?: string | Date | null } = {},
    conn?: Connection,
): Promise<number> => {
    const db = conn ?? pool;
    const [res]: any = await db.query(
        `INSERT INTO Trip (createdByUserId, householdId, name, isAdHoc, scoreExempt, createdAt, archivedAt)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, NOW()), ?)`,
        [
            createdByUserId,
            opts.householdId ?? null,
            opts.name ?? null,
            opts.isAdHoc ? 1 : 0,
            opts.scoreExempt ? 1 : 0,
            opts.createdAt ?? null,
            opts.archivedAt ?? null,
        ],
    );
    const tripId = res.insertId as number;
    await db.query(
        `INSERT INTO TripMember (tripId, userId, role) VALUES (?, ?, 'owner')
         ON DUPLICATE KEY UPDATE role = role`,
        [tripId, createdByUserId],
    );
    return tripId;
};

export const getTripById = async (id: number): Promise<TripRow | null> => {
    const [rows]: any = await pool.query('SELECT * FROM Trip WHERE id = ?', [id]);
    return rows[0] ?? null;
};

export const isTripMember = async (tripId: number, userId: string): Promise<boolean> => {
    const [rows]: any = await pool.query(
        'SELECT 1 FROM TripMember WHERE tripId = ? AND userId = ? LIMIT 1',
        [tripId, userId],
    );
    return rows.length > 0;
};

export const getTripMemberIds = async (tripId: number): Promise<string[]> => {
    const [rows]: any = await pool.query('SELECT userId FROM TripMember WHERE tripId = ?', [tripId]);
    return rows.map((r: any) => r.userId);
};

export const archiveTrip = async (tripId: number, archived: boolean): Promise<void> => {
    await pool.query('UPDATE Trip SET archivedAt = ? WHERE id = ?', [archived ? new Date() : null, tripId]);
};

/**
 * Load the derivation facts for a trip in TWO queries (basket + slots-with-
 * receipts) — never the load-all-receipts pattern (getUserStats anti-pattern).
 */
export const getTripStageFacts = async (tripId: number): Promise<TripStageFacts | null> => {
    const [tripRows]: any = await pool.query(
        'SELECT isAdHoc FROM Trip WHERE id = ?', [tripId]);
    if (!tripRows.length) return null;

    const [basketRows]: any = await pool.query(
        'SELECT hasBeenCalculated FROM Basket WHERE tripId = ? LIMIT 1', [tripId]);

    // One row per slot; receipt presence via a per-store EXISTS on the trip's
    // receipts (extra receipts with off-plan storeIds don't close any slot).
    const [slotRows]: any = await pool.query(
        `SELECT sl.status, sl.receiptSkippedAt,
                EXISTS(SELECT 1 FROM Receipt r WHERE r.tripId = sl.tripId AND r.storeId = sl.storeId) AS hasReceipt
         FROM ShoppingList sl WHERE sl.tripId = ?`,
        [tripId],
    );
    const [extraRows]: any = await pool.query(
        `SELECT COUNT(*) AS extra FROM Receipt r
         WHERE r.tripId = ?
           AND r.storeId NOT IN (SELECT storeId FROM ShoppingList WHERE tripId = ?)`,
        [tripId, tripId],
    );

    return {
        isAdHoc: tripRows[0].isAdHoc === 1,
        basketCalculated: basketRows.length > 0 && Number(basketRows[0].hasBeenCalculated) === 1,
        slots: slotRows.map((s: any) => ({
            listStatus: s.status === 'completed' ? 'completed' as const : 'active' as const,
            hasReceipt: Number(s.hasReceipt) === 1,
            receiptSkipped: s.receiptSkippedAt != null,
        })),
        extraReceiptCount: Number(extraRows[0]?.extra ?? 0),
    };
};

export const getTripStage = async (tripId: number): Promise<TripStage | null> => {
    const facts = await getTripStageFacts(tripId);
    return facts ? deriveTripStage(facts) : null;
};
