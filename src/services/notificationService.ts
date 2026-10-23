import pool from '../config/db.js';

/**
 * Souply 2.0 Phase 6 — the notification INBOX (source of truth) + the Expo
 * push doorbell. Inbox rows always land; push delivery is best-effort
 * fire-and-forget (no permission / no token / Expo hiccup → the bell badge
 * still works via polling).
 */

export interface NotificationPayload {
    title: string;
    body: string;
    /** Deep-link route the tap opens (e.g. "/trip/42"). */
    route?: string;
    [k: string]: unknown;
}

export const notifyUser = async (
    userId: string,
    type: string,
    payload: NotificationPayload,
): Promise<void> => {
    await pool.query(
        'INSERT INTO Notification (userId, type, payload) VALUES (?, ?, ?)',
        [userId, type, JSON.stringify(payload)],
    );
    // Doorbell: Expo push to every registered device token.
    void (async () => {
        try {
            const [tokens]: any = await pool.query('SELECT token FROM PushToken WHERE userId = ?', [userId]);
            if (tokens.length === 0) return;
            const messages = tokens.map((t: any) => ({
                to: t.token,
                title: payload.title,
                body: payload.body,
                data: { type, route: payload.route ?? null },
                sound: 'default',
            }));
            const res = await fetch('https://exp.host/--/api/v2/push/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(messages),
            });
            const out: any = await res.json().catch(() => null);
            // Prune tokens Expo reports as dead (DeviceNotRegistered).
            const tickets: any[] = out?.data ?? [];
            for (let i = 0; i < tickets.length; i++) {
                if (tickets[i]?.details?.error === 'DeviceNotRegistered') {
                    await pool.query('DELETE FROM PushToken WHERE token = ?', [tokens[i].token]);
                }
            }
        } catch (e: any) {
            console.warn('[notify] push send failed:', e?.message);
        }
    })();
};

export const registerPushToken = async (userId: string, token: string, platform: 'ios' | 'android'): Promise<void> => {
    await pool.query(
        `INSERT INTO PushToken (userId, token, platform) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE userId = VALUES(userId), platform = VALUES(platform), updatedAt = NOW()`,
        [userId, token, platform],
    );
};

export const unregisterPushToken = async (token: string): Promise<void> => {
    await pool.query('DELETE FROM PushToken WHERE token = ?', [token]);
};

export const listNotifications = async (userId: string, limit = 50) => {
    const [rows]: any = await pool.query(
        'SELECT id, type, payload, readAt, createdAt FROM Notification WHERE userId = ? ORDER BY id DESC LIMIT ?',
        [userId, limit],
    );
    return rows.map((r: any) => ({
        ...r,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    }));
};

export const unreadCount = async (userId: string): Promise<number> => {
    const [[row]]: any = await pool.query(
        'SELECT COUNT(*) AS n FROM Notification WHERE userId = ? AND readAt IS NULL', [userId]);
    return Number(row.n) || 0;
};

export const markAllRead = async (userId: string): Promise<void> => {
    await pool.query('UPDATE Notification SET readAt = NOW() WHERE userId = ? AND readAt IS NULL', [userId]);
};
