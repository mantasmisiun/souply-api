import express from 'express';
import dotenv from 'dotenv';
import pool from './config/db.js';
import storeRoutes from './routes/storeRoutes.js';
import productRoutes from './routes/productRoutes.js';
import categoryRoutes from './routes/categoryRoutes.js';
import storeProductRoutes from './routes/storeProductRoutes.js';
import priceRoutes from './routes/priceRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import userRoutes from './routes/userRoutes.js';
import basketRoutes from './routes/basketRoutes.js';
import basketItemRoutes from './routes/basketItemRoutes.js';
import shoppingListRoutes from './routes/shoppingListRoutes.js';
import shoppingListItemRoutes from './routes/shoppingListItemRoutes.js';
import receiptRoutes from './routes/receiptRoutes.js';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './config/swagger.js';

dotenv.config({
    path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env'
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

app.use('/api', storeRoutes);
app.use('/api', categoryRoutes);
app.use('/api', productRoutes);
app.use('/api', storeProductRoutes);
app.use('/api', priceRoutes);
app.use('/api', userRoutes);
app.use('/api', basketRoutes);
app.use('/api', basketItemRoutes);
app.use('/api', shoppingListRoutes);
app.use('/api', shoppingListItemRoutes);
app.use('/api', receiptRoutes);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
// 404 handler for unknown routes
app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Error handler must be last
app.use(errorHandler);
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});
export default app;
if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}
