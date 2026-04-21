import { Request, Response, NextFunction } from 'express';
import { createStoreChain, getAllChains } from '../models/storeChainModel.js';
import { createStore, getAllStores, getStoreById, getStoresByChainId } from '../models/storeModel.js';
import { findBestStoreMatch } from '../utils/addressMatcher.js';

export const addStoreChain = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name, logoUrl } = req.body;
        if (!name) {
            res.status(400).json({ error: 'Name is required' });
            return;
        }
        const id = await createStoreChain(name, logoUrl || null);
        res.status(201).json({ id, name, logoUrl });
    } catch (error) {
        next(error);
    }
};

export const addStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { chainId, name, address, latitude, longitude } = req.body;
        if (!chainId || !name || !address || !latitude || !longitude) {
            res.status(400).json({ error: 'All fields are required' });
            return;
        }
        const id = await createStore(chainId, name, address, latitude, longitude);
        res.status(201).json({ id, chainId, name, address, latitude, longitude });
    } catch (error) {
        next(error);
    }
};

export const fetchAllStores = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const stores = await getAllStores();
        res.json(stores);
    } catch (error) {
        next(error);
    }
};

export const fetchStoreById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid store ID' });
            return;
        }
        const store = await getStoreById(id);
        if (!store) {
            res.status(404).json({ error: 'Store not found' });
            return;
        }
        res.json(store);
    } catch (error) {
        next(error);
    }
};
interface StoreRow {
    id: number;
    chainId: number;
    name: string;
    address: string;
    latitude: string;   // DECIMAL from MySQL comes as string
    longitude: string;
}

export const matchStoreByAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chainId = Number(req.query.chainId);
        const address = req.query.address as string;

        if (isNaN(chainId) || !address) {
            res.status(400).json({ error: 'chainId and address query params are required' });
            return;
        }

        const stores = (await getStoresByChainId(chainId)) as StoreRow[];
        const best = findBestStoreMatch<StoreRow>(address, stores);

        if (!best) {
            res.json({ match: null });
            return;
        }

        res.json({
            match: {
                storeId: best.store.id,
                storeName: best.store.name,
                address: best.store.address,
                latitude: parseFloat(best.store.latitude),
                longitude: parseFloat(best.store.longitude),
                confidence: Math.round(best.confidence * 100) / 100,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const fetchAllChains = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name } = req.query;
        const rows = await getAllChains(name as string | undefined);
        res.json(rows);
    } catch (error) {
        next(error);
    }
};

export const fetchStoresByChainId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chainId = Number(req.params.chainId);
        if (isNaN(chainId)) {
            res.status(400).json({ error: 'Invalid chain ID' });
            return;
        }
        const stores = await getStoresByChainId(chainId);
        res.json(stores);
    } catch (error) {
        next(error);
    }
};