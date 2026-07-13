import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    findRecoveryCandidates,
    failedAttemptsInLast24h,
    logRecoveryAttempt,
    finaliseRecoveryAttempt,
    RATE_LIMIT_MAX_FAILURES,
    type FailureReason,
} from '../models/recoveryModel.js';
import type { RecoveryFields } from '../utils/receiptIntrospect.js';
import { mergeFreshIntoRecovered, MergeRollbackError } from '../services/accountMergeService.js';

/**
 * Account recovery — POST /api/users/recover
 *
 * Spec: Documentation/roadmap/user-accounts-recovery.md
 *
 * Body shape:
 *   {
 *     deviceFingerprint: string,    // sha256(deviceId + freshInstallUUID)
 *     freshUserId: string,          // UUID created on this fresh install,
 *                                   // for the auto-merge of any data the
 *                                   // user already uploaded under it
 *     receipts: RecoveryFields[]    // exactly 3 entries from the new OCR
 *   }
 *
 * Response:
 *   { status: 'success', recoveredUserId: string }
 *   { status: 'failed' }            // generic — client doesn't surface reasons
 *   { status: 'locked' }            // server returns this so the client can
 *                                   // show the same modal as 'failed' but we
 *                                   // can log it differently
 */

interface RecoverRequestBody {
    deviceFingerprint?: unknown;
    freshUserId?: unknown;
    receipts?: unknown;
}

export const recoverAccount = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body as RecoverRequestBody;

        const deviceFingerprint = typeof body.deviceFingerprint === 'string' ? body.deviceFingerprint.trim() : '';
        const freshUserId       = typeof body.freshUserId === 'string' ? body.freshUserId.trim() : '';
        const submitted         = parseSubmittedReceipts(body.receipts);

        if (!deviceFingerprint || !freshUserId || submitted.length !== 3) {
            res.status(400).json({ error: 'deviceFingerprint, freshUserId, and exactly 3 receipts are required' });
            return;
        }

        // ── Rate-limit gate ───────────────────────────────────────────────
        // 3 failed attempts in the last 24h → lockout. Success in between
        // doesn't decrement the counter (it stays at whatever it was when
        // recovery succeeded), but a locked-out user gets a fresh window
        // 24h after their oldest failure rolls off.
        const recentFailures = await failedAttemptsInLast24h(deviceFingerprint);
        if (recentFailures >= RATE_LIMIT_MAX_FAILURES) {
            console.log(`[recover] short-circuited — deviceFingerprint locked (${recentFailures} failures in last 24h)`);
            await logRecoveryAttempt({
                deviceFingerprint,
                matchedUserId: null,
                succeeded: false,
                failureReason: 'locked',
            });
            res.json({ status: 'locked' });
            return;
        }

        // ── Run the match algorithm across the 3 submitted receipts ──────
        const result = await tryMatch(submitted, freshUserId);

        if (result.status !== 'matched') {
            await logRecoveryAttempt({
                deviceFingerprint,
                matchedUserId: null,
                succeeded: false,
                failureReason: result.reason,
            });
            // Generic failure to the client — spec calls for not exposing
            // attempt counts or reason codes.
            res.json({ status: 'failed' });
            return;
        }

        const recoveredUserId = result.userId;

        // Log the attempt up front so the merge service can reference its
        // id in the rollback Telegram alert. We finalise the row (success
        // vs merge-rollback) after the merge resolves either way.
        const attemptId = await logRecoveryAttempt({
            deviceFingerprint,
            matchedUserId: recoveredUserId,
            succeeded: false,
            failureReason: null,
        });

        try {
            await mergeFreshIntoRecovered(freshUserId, recoveredUserId, attemptId);
        } catch (e) {
            if (e instanceof MergeRollbackError) {
                // Telegram alert already fired from inside the merge service.
                // Update the attempt row with the rollback reason so telemetry
                // queries can distinguish merge failures from match failures.
                await finaliseRecoveryAttempt({
                    attemptId,
                    succeeded: false,
                    failureReason: 'merge-rollback',
                });
                console.error(`[recover] merge rollback for attempt=${attemptId}, stage=${e.stage}`);
                res.json({ status: 'failed' });
                return;
            }
            throw e;
        }

        await finaliseRecoveryAttempt({
            attemptId,
            succeeded: true,
            failureReason: null,
        });
        res.json({ status: 'success', recoveredUserId });
    } catch (error) {
        next(error);
    }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

type MatchOutcome =
    | { status: 'matched'; userId: string }
    | { status: 'failed';  reason: Exclude<FailureReason, 'locked'> };

/**
 * Three receipts in, one recovered userId out (or a failure reason).
 *
 * Rules:
 *   - Each receipt must have exactly one candidate matching on
 *     receiptNo + date + total (within tolerance). Zero candidates or
 *     ambiguous (>1) → no-match.
 *   - All three matched candidates must point to the *same* userId.
 *     Different users → no-match (someone submitted receipts that
 *     coincidentally exist under multiple accounts — defensive against
 *     social engineering).
 *   - The matched userId must NOT equal freshUserId. That would mean the
 *     user is "recovering" their own current account — pointless, and
 *     would short-circuit the merge.
 *   - The union of chainIds across the 3 candidates must have size >= 2.
 *     Spec rule: blocks attackers who only know a victim's habitual
 *     single store.
 */
/** Normalize a receipt identifier for cross-parse comparison (OCR spacing/case noise). */
const canonicaliseId = (s: string): string => (s ?? '').replace(/\s+/g, '').toUpperCase();
/** A receipt identifier unique ENOUGH to disambiguate users: a long structured id
 *  ("168/645/104148", "104148") qualifies; a short per-terminal sequence (IKI "Kvitas 3157")
 *  does NOT, so a coincidental short collision can never tiebreak. (≥6 alphanumerics OR a "/".) */
const isStrongId = (s: string): boolean => !!s && (s.replace(/[^0-9A-Z]/gi, '').length >= 6 || s.includes('/'));

async function tryMatch(submitted: RecoveryFields[], freshUserId: string): Promise<MatchOutcome> {
    const hits: { receiptId: number; userId: string; chainId: number | null }[] = [];

    for (let i = 0; i < submitted.length; i++) {
        const fields = submitted[i];
        const candidates = await findRecoveryCandidates(fields);
        // Drop self-matches (user's own fresh-install receipts shouldn't
        // recover them to themselves).
        const others = candidates.filter(c => c.userId !== freshUserId && c.userId !== null);
        if (others.length === 0) {
            // Distinguish the SELF-MATCH case: the fields matched a stored
            // receipt, but it belongs to THIS device's own current account, so
            // it was filtered out. That's not an OCR/field divergence — the user
            // is already signed into the account they're trying to recover (a
            // common dev pitfall: re-installing with the same persisted UUID).
            const selfMatched = candidates.some(c => c.userId === freshUserId);
            if (selfMatched) {
                console.log(`[recover] no-match on submission[${i}]: matched receipt belongs to the CURRENT device account (freshUserId=${freshUserId}) — you are already on this account, nothing to recover. receiptNo="${fields.receiptNo}"`);
            } else {
                // Print the submission + near-misses ONLY on failure, so the
                // happy-path log stays quiet. Tells you which field diverged
                // (receiptNo OK + total off → OCR misread the total, etc.).
                console.log(`[recover] no-match on submission[${i}]: receiptNo="${fields.receiptNo}" date=${fields.date} total=${fields.total}`);
                await logDiagnosticMisses(fields);
            }
            return { status: 'failed', reason: 'no-match' };
        }
        // AMBIGUITY GUARD: matching is by date+total (receiptNo can diverge across re-parses, so
        // it's not the key), so a collision could surface receipts from DIFFERENT users with the
        // same date+total. Refuse to pick one arbitrarily — that would let an attacker ride a
        // coincidental collision. Multiple rows for the SAME user (e.g. a re-upload) are fine.
        const distinctUsers = new Set(others.map(o => o.userId));
        if (distinctUsers.size > 1) {
            // TIEBREAKER ONLY: among the colliding users, if the submission shares a STRONG
            // (unique-enough) receipt identifier with EXACTLY ONE of them, disambiguate to that
            // user — date+total still had to match, so this only resolves the rare collision; it
            // never broadens the match. Never tiebreaks on a short value (e.g. IKI "Kvitas 3157").
            const submittedStrong = new Set(
                [fields.receiptNo, ...(fields.receiptNos ?? [])].map(canonicaliseId).filter(isStrongId),
            );
            const overlapUsers = new Set<string>();
            if (submittedStrong.size > 0) {
                for (const o of others) {
                    const stored = (o.storedReceiptNos.length ? o.storedReceiptNos : [o.storedReceiptNo])
                        .map(canonicaliseId).filter(isStrongId);
                    if (stored.some(s => submittedStrong.has(s))) overlapUsers.add(o.userId!);
                }
            }
            if (overlapUsers.size === 1) {
                const winner = [...overlapUsers][0];
                const c = others.find(o => o.userId === winner)!;
                console.log(`[recover] tiebreak on submission[${i}]: ${distinctUsers.size} users by date+total → one strong receiptNo overlap → user resolved`);
                hits.push({ receiptId: c.receiptId, userId: c.userId!, chainId: c.chainId });
                continue;
            }
            console.log(`[recover] no-match on submission[${i}]: AMBIGUOUS — date=${fields.date} total=${fields.total} matched ${distinctUsers.size} different users (no single strong receiptNo overlap)`);
            return { status: 'failed', reason: 'no-match' };
        }
        const c = others[0];
        hits.push({ receiptId: c.receiptId, userId: c.userId!, chainId: c.chainId });
    }

    // De-dupe by receiptId — two submitted photos of the same stored
    // receipt collapse to one hit, which then fails the "3 receipts"
    // implicit floor.
    const uniqueReceiptIds = new Set(hits.map(h => h.receiptId));
    if (uniqueReceiptIds.size < 3) {
        return { status: 'failed', reason: 'no-match' };
    }

    // All hits must point to the same user.
    const userIds = new Set(hits.map(h => h.userId));
    if (userIds.size !== 1) {
        return { status: 'failed', reason: 'no-match' };
    }
    const userId = hits[0].userId;

    // 2-chain rule.
    const chainIds = new Set(hits.map(h => h.chainId).filter(c => c !== null) as number[]);
    if (chainIds.size < 2) {
        return { status: 'failed', reason: 'insufficient-chains' };
    }

    return { status: 'matched', userId };
}

/**
 * Loose diagnostic queries that print near-misses to the server log when
 * a submission found zero candidates. Helps tell which field diverged
 * between client OCR and stored receipt:
 *   - receiptNo match only → date OR total drifted (likely OCR noise)
 *   - date+total match only → receiptNo OCR was wrong
 * Never used for matching, just visibility.
 */
async function logDiagnosticMisses(fields: RecoveryFields): Promise<void> {
    try {
        const [byReceiptNo]: any = await pool.query(
            `SELECT r.id, r.userId, DATE_FORMAT(r.receiptDate, '%Y-%m-%d') AS storedDate,
                    CAST(JSON_EXTRACT(r.parsedData, '$.footer.total') AS DECIMAL(10,2)) AS storedTotal,
                    r.processingStatus, s.chainId
               FROM Receipt r
               LEFT JOIN Store s ON s.id = r.storeId
              WHERE r.receiptNoCanonical = ?
              LIMIT 5`,
            [fields.receiptNo],
        );
        if ((byReceiptNo as any[]).length === 0) {
            console.log(`[recover]     diag: no Receipt row anywhere with receiptNo="${fields.receiptNo}" — OCR likely misread the receipt number, or this receipt was never uploaded to this DB`);
        } else {
            for (const r of byReceiptNo as any[]) {
                console.log(`[recover]     diag: receiptNo MATCH but other fields — id=${r.id} userId=${r.userId} status=${r.processingStatus} storedDate=${r.storedDate} storedTotal=${r.storedTotal} chainId=${r.chainId} | submitted date=${fields.date} total=${fields.total}`);
            }
        }
        const [byDateTotal]: any = await pool.query(
            `SELECT r.id, r.receiptNoCanonical AS receiptNo, r.userId, DATE_FORMAT(r.receiptDate, '%Y-%m-%d') AS storedDate,
                    CAST(JSON_EXTRACT(r.parsedData, '$.footer.total') AS DECIMAL(10,2)) AS storedTotal,
                    r.processingStatus
               FROM Receipt r
              WHERE DATE(r.receiptDate) = ?
                AND ABS(CAST(JSON_EXTRACT(r.parsedData, '$.footer.total') AS DECIMAL(10,2)) - ?) <= 0.05
              LIMIT 5`,
            [fields.date, fields.total],
        );
        for (const r of byDateTotal as any[]) {
            console.log(`[recover]     diag: date+total NEAR-MATCH — id=${r.id} userId=${r.userId} storedReceiptNo="${r.receiptNo}" status=${r.processingStatus} storedDate=${r.storedDate} storedTotal=${r.storedTotal} | submitted receiptNo="${fields.receiptNo}"`);
        }
    } catch (e) {
        console.warn('[recover] diagnostic query failed', e);
    }
}

/**
 * Validates the receipts array from the request body. Each entry must
 * carry receiptNo + date + total in the shape the client extracted via
 * its local OCR. Returns `[]` if anything is off — the controller will
 * reject the request with 400.
 */
function parseSubmittedReceipts(raw: unknown): RecoveryFields[] {
    if (!Array.isArray(raw)) return [];
    const out: RecoveryFields[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') return [];
        // The requirement "each receipt must carry an identifier" is satisfied by ANY value — the
        // client may send the full receiptNos array; the canonical receiptNo is its first element.
        const receiptNos = Array.isArray((r as any).receiptNos)
            ? (r as any).receiptNos.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0).map((v: string) => v.trim())
            : [];
        const receiptNo = (typeof (r as any).receiptNo === 'string' ? (r as any).receiptNo.trim() : '') || receiptNos[0] || '';
        const date      = typeof (r as any).date === 'string' ? (r as any).date.trim() : '';
        const total     = typeof (r as any).total === 'number' ? (r as any).total : NaN;
        if (!receiptNo || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(total) || total <= 0) return [];
        out.push({ receiptNo, receiptNos: receiptNos.length ? receiptNos : undefined, date, total });
    }
    return out;
}
