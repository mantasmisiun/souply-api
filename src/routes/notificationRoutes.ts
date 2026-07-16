import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../middleware/sessionAuth.js';
import {
    registerPushToken, unregisterPushToken, listNotifications, unreadCount, markAllRead,
} from '../services/notificationService.js';

/**
 * Souply 2.0 Phase 6 — push-token lifecycle + the notification inbox.
 * All self-scoped via the session subject (no ids in URLs).
 */
const router = Router();

router.post('/push-tokens', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { token, platform } = req.body ?? {};
        if (typeof token !== 'string' || !token || !['ios', 'android'].includes(platform)) {
            res.status(400).json({ error: 'token and platform required' }); return;
        }
        await registerPushToken(req.authUserId!, token, platform);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.delete('/push-tokens', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { token } = req.body ?? {};
        if (typeof token === 'string' && token) await unregisterPushToken(token);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.get('/notifications', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await listNotifications(req.authUserId!)); } catch (e) { next(e); }
});

router.get('/notifications/unread-count', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try { res.json({ unread: await unreadCount(req.authUserId!) }); } catch (e) { next(e); }
});

router.post('/notifications/mark-read', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try { await markAllRead(req.authUserId!); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
