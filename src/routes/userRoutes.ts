import { Router } from 'express';
import { addUser, fetchUserById, updateUserLastActive } from '../controllers/userController';

const router = Router();

// POST /api/users - Create a new user
router.post('/users', addUser);

// GET /api/users/:id - Get a single user by ID
router.get('/users/:id', fetchUserById);

// PUT /api/users/:id/last-active - Update user's last active time
router.patch('/users/:id/last-active', updateUserLastActive);

export default router; 