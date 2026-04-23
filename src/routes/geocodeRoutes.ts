import { Router } from 'express';
import { geocodeAddress } from '../controllers/geocodeController.js';

const router = Router();

// POST /api/geocode { address } → { lat, lng, displayName }
// Proxies to Nominatim with caching + UA + timeout. Used by the app when
// the device's location permission is denied and the user enters a
// fallback address.
router.post('/geocode', geocodeAddress);

export default router;
