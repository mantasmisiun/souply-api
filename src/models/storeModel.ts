import pool from '../config/db';

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