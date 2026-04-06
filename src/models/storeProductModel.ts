import pool from '../config/db';

export const createStoreProduct = async (  
    productId: number,
    chainId: number,
    storeProductName: string,
    brandName: string | null
) => {
    const [result]: any = await pool.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName, brandName) VALUES (?, ?, ?, ?)',
        [productId, chainId, storeProductName, brandName]
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

//Get store product by name and chain for OCR matching
export const getStoreProductByNameAndChain = async (storeProductName: string, chainId: number) => {
    // Use first 60% of the name for fuzzy matching
    const matchLength = Math.floor(storeProductName.length * 0.6);
    const searchTerm = storeProductName.substring(0, matchLength);
    
    const [rows]: any = await pool.query(
        `SELECT * FROM StoreProduct 
         WHERE chainId = ? 
         AND storeProductName LIKE ?`,
        [chainId, `%${searchTerm}%`]
    );
    return rows[0] || null;
};