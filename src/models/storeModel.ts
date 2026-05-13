import pool from '../config/db.js';

type Connection = typeof pool | any;

export const createStore = async (
    chainId: number,
    name: string,
    address: string,
    latitude: number,
    longitude: number,
    conn?: Connection
) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO Store (chainId, name, address, latitude, longitude) VALUES (?, ?, ?, ?, ?)',
        [chainId, name, address, latitude, longitude]
    );
    return result.insertId;
};

export const getAllStores = async () => {
    const [rows]: any = await pool.query(
        `SELECT Store.*, StoreChain.name AS chainName, StoreChain.logoUrl 
         FROM Store 
         JOIN StoreChain ON Store.chainId = StoreChain.id`
    );
    return rows.map((row: any) => ({
        ...row,
        latitude: parseFloat(row.latitude),
        longitude: parseFloat(row.longitude)
    }));
};

export const getStoreById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT Store.*, StoreChain.name AS chainName, StoreChain.logoUrl 
         FROM Store 
         JOIN StoreChain ON Store.chainId = StoreChain.id
         WHERE Store.id = ?`,
        [id]
    );
    return rows.map((row: any) => ({
        ...row,
        latitude: parseFloat(row.latitude),
        longitude: parseFloat(row.longitude)
    }));
};

export const getStoreByNameAndAddress = async (name: string, address: string, conn?: Connection) => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        'SELECT * FROM Store WHERE name = ? AND address = ?',
        [name, address]
    );
    return rows[0] || null;
};

export const getChainIdByStoreId = async (storeId: number) => {
    const [rows]: any = await pool.query(
        'SELECT chainId FROM Store WHERE id = ?',
        [storeId]
    );
    return rows[0]?.chainId || null;
};

//For fallback price service
export const getStoresByChainId = async (chainId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM Store WHERE chainId = ?',
        [chainId]
    );
    return rows;
};

//For basket price comparison, pull closest stores to user
export const getClosestStores = async (lat: number, lng: number, limit: number = 10) => {
    const [rows]: any = await pool.query(
        `SELECT s.*, sc.name as chainName, sc.logoUrl,
            (6371 * ACOS(
                COS(RADIANS(?)) * COS(RADIANS(latitude)) *
                COS(RADIANS(longitude) - RADIANS(?)) +
                SIN(RADIANS(?)) * SIN(RADIANS(latitude))
            )) AS distance
         FROM Store s
         JOIN StoreChain sc ON s.chainId = sc.id
         ORDER BY distance ASC
         LIMIT ?`,
        [lat, lng, lat, limit]
    );
    return rows;
};

export interface ClosestChainStore {
    storeId: number;
    storeName: string;
    storeAddress: string;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    /** Distance from the anchor store in kilometres (rounded to 2 dp). */
    distance: number;
    /** Latitude / longitude of the store itself — used by the comparison
     *  service to compute store-to-store haversine for the cluster-fallback
     *  case (no cross-chain alt within the primary range, so we ground a
     *  cluster around the closest alt). */
    latitude: number;
    longitude: number;
}

export const getClosestStorePerChainToStore = async (anchorStoreId: number): Promise<ClosestChainStore[]> => {
    const [anchorRows]: any = await pool.query(
        'SELECT id, latitude, longitude FROM Store WHERE id = ?',
        [anchorStoreId]
    );
    const anchor = anchorRows[0];
    if (!anchor) return [];

    const anchorLat = parseFloat(anchor.latitude);
    const anchorLng = parseFloat(anchor.longitude);

    const [rows]: any = await pool.query(
        `SELECT s.id, s.name, s.address, s.chainId, s.latitude, s.longitude,
                sc.name AS chainName, sc.logoUrl,
                (6371 * ACOS(
                    COS(RADIANS(?)) * COS(RADIANS(s.latitude)) *
                    COS(RADIANS(s.longitude) - RADIANS(?)) +
                    SIN(RADIANS(?)) * SIN(RADIANS(s.latitude))
                )) AS distance
         FROM Store s
         JOIN StoreChain sc ON s.chainId = sc.id
         ORDER BY s.chainId ASC, distance ASC`,
        [anchorLat, anchorLng, anchorLat]
    );

    const perChain = new Map<number, ClosestChainStore>();
    for (const row of rows) {
        if (!perChain.has(row.chainId)) {
            perChain.set(row.chainId, {
                storeId: row.id,
                storeName: row.name,
                storeAddress: row.address,
                chainId: row.chainId,
                chainName: row.chainName,
                chainLogoUrl: row.logoUrl || null,
                distance: parseFloat(Number(row.distance).toFixed(2)),
                latitude: parseFloat(row.latitude),
                longitude: parseFloat(row.longitude),
            });
        }
    }

    return Array.from(perChain.values());
};
