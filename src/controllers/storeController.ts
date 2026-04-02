import { Request, Response } from 'express';
import { createStoreChain } from '../models/storeChainModel';
import { createStore } from '../models/storeModel';
import { getAllStores, getStoreById } from '../models/storeModel';

export const addStoreChain = async (req: Request, res: Response) => {
    const { name, logoUrl } = req.body;
    if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }
    const id = await createStoreChain(name, logoUrl || null);
    res.status(201).json({ id, name, logoUrl });
};

export const addStore = async (req: Request, res: Response) => {
    const { chainId, name, address, latitude, longitude } = req.body;
    if (!chainId || !name || !address || !latitude || !longitude) {
        res.status(400).json({ error: 'All fields are required' });
        return;
    }
    const id = await createStore(chainId, name, address, latitude, longitude);
    res.status(201).json({ id, chainId, name, address, latitude, longitude });
};

// Controller to get all stores
export const fetchAllStores = async (req: Request, res: Response) => {
    const stores = await getAllStores();
    res.json(stores);
};

// Controller to get a single store by ID
export const fetchStoreById = async (req: Request, res: Response) => {
    // Extract the id from the URL parameters and convert to number
    const id = Number(req.params.id);

    // Validate that id is a valid number
    if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid store ID' });
        return;
    }

    const store = await getStoreById(id);

    // Return 404 if store not found
    if (!store) {
        res.status(404).json({ error: 'Store not found' });
        return;
    }

    res.json(store);
};