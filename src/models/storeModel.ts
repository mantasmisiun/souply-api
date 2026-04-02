import pool from '../config/db';

export const createStore = async (
    chainId: number,
    name: string,
    address: string,
    latitude: number,
    longitude: number
) => {
    const [result]: any = await pool.query(
        'INSERT INTO Store (chainId, name, address, latitude, longitude) VALUES (?, ?, ?, ?, ?)',
        [chainId, name, address, latitude, longitude]
    );
    return result.insertId;
};
// Function to get all stores
export const getAllStores = async () => {
    // JOIN with StoreChain to include chain name and logo in the result
    const [rows]: any = await pool.query(
        `SELECT Store.*, StoreChain.name AS chainName, StoreChain.logoUrl 
         FROM Store 
         JOIN StoreChain ON Store.chainId = StoreChain.id`
    );
    // Convert latitude and longitude from string to number
    return rows.map((row: any) => ({
        ...row,
        latitude: parseFloat(row.latitude),
        longitude: parseFloat(row.longitude)
    }));
    return rows;
};

// Function to get a single store by ID
export const getStoreById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT Store.*, StoreChain.name AS chainName, StoreChain.logoUrl 
         FROM Store 
         JOIN StoreChain ON Store.chainId = StoreChain.id
         WHERE Store.id = ?`,
        [id]
    );
    // Convert latitude and longitude from string to number
    return rows.map((row: any) => ({
        ...row,
        latitude: parseFloat(row.latitude),
        longitude: parseFloat(row.longitude)
    }));
    // Return the first row or null if not found
    return rows[0] || null;
};