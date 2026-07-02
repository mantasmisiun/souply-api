import { Router } from 'express';
import { versionCheck, clientVersionDistribution } from '../controllers/appVersionController.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = Router();

// Launch-time client version gate check. Exempt from the global versionGate middleware
// (a blocked client must still be able to ask what to do). Public — no auth.
router.get('/app/version-check', versionCheck);

// Admin: the client-version distribution rollup (telemetry) — see when old builds drained.
router.get('/admin/client-versions', requireAdmin, clientVersionDistribution);

export default router;
