import express from 'express';
import dotenv from 'dotenv';
import pool from './config/db';
import storeRoutes from './routes/storeRoutes';
import productRoutes from './routes/productRoutes';
import categoryRoutes from './routes/categoryRoutes';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/api', storeRoutes);
app.use('/api', categoryRoutes);
app.use('/api', productRoutes);

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});