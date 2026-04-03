import pool from '../config/db';

export const createStoreProduct = async (  
    productId: number,
    chainId: number,
    storeProductName: string,
) => {
    const [result]: any = await pool.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName) VALUES (?, ?, ?)',
        [productId, chainId, storeProductName]
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