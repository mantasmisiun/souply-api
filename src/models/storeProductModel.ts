import pool from '../config/db';

type Connection = typeof pool | any;

export const createStoreProduct = async (
    productId: number,
    chainId: number,
    storeProductName: string,
    brandName: string | null,
    isWeighable: boolean = false,
    amount: number | null = null,
    unit: string | null = null,
    conn?: Connection
) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName, brandName, isWeighable, amount, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [productId, chainId, storeProductName, brandName, isWeighable, amount, unit]
    );
    return result.insertId;
};

export const getStoreProductsByProductId = async (productId: number) => {
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM StoreProduct
         JOIN StoreChain ON StoreProduct.chainId = StoreChain.id 
         WHERE StoreProduct.productId = ?`,
        [productId]
    );
    return rows;
};

export const getStoreProductsByChainId = async (chainId: number) => {
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM StoreProduct
         JOIN StoreChain ON StoreProduct.chainId = StoreChain.id 
         WHERE StoreProduct.chainId = ?`,
        [chainId]
    );
    return rows;
};

export const getStoreProductByName = async (storeProductName: string) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM StoreProduct WHERE storeProductName LIKE ?',
        [`%${storeProductName}%`]
    );
    return rows;
};

export const getStoreProductByNameAndChain = async (storeProductName: string, chainId: number, conn?: Connection) => {
    const db = conn || pool;
    const matchLength = Math.floor(storeProductName.length * 0.6);
    const searchTerm = storeProductName.substring(0, matchLength);
    const [rows]: any = await db.query(
        `SELECT * FROM StoreProduct 
         WHERE chainId = ? 
         AND storeProductName LIKE ?`,
        [chainId, `%${searchTerm}%`]
    );
    return rows[0] || null;
};

export const getStoreProductByProductAndChain = async (productId: number, chainId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM StoreProduct WHERE productId = ? AND chainId = ?',
        [productId, chainId]
    );
    return rows[0] || null;
};

export const searchStoreProductsByChain = async (name: string, chainId: number) => {
    const [rows]: any = await pool.query(
        `SELECT sp.*, p.imageUrl
         FROM StoreProduct sp
         JOIN Product p ON sp.productId = p.id
         WHERE sp.chainId = ?
         AND sp.storeProductName LIKE ?
         LIMIT 5`,
        [chainId, `%${name}%`]
    );
    return rows;
};

export const updateStoreProductName = async (id: number, storeProductName: string) => {
    await pool.query(
        'UPDATE StoreProduct SET storeProductName = ? WHERE id = ?',
        [storeProductName, id]
    );
};

//For verifying price's storeProduct and store belong to the same chain
export const getChainIdByStoreProductId = async (storeProductId: number) => {
    const [rows]: any = await pool.query(
        'SELECT chainId FROM StoreProduct WHERE id = ?',
        [storeProductId]
    );
    return rows[0]?.chainId || null;
};

// At the end of storeProductModel.ts
export const getStoreProductsByChainWithProductData = async (chainId: number) => {
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                sp.isWeighable, sp.amount, sp.unit,
                p.imageUrl
         FROM StoreProduct sp
         JOIN Product p ON sp.productId = p.id
         WHERE sp.chainId = ?`,
        [chainId]
    );
    return rows.map((r: any) => ({
        ...r,
        isWeighable: !!r.isWeighable,
        amount: r.amount !== null ? parseFloat(r.amount) : null,
    }));
};