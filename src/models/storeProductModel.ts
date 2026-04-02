import pool from '../config/db';

export const createStoreProduct = async (  
    productId: number,
    storeId: number,
    storeProductName: string,
) => {
    const [result]: any = await pool.query(
        'INSERT INTO StoreProduct (productId, storeId, storeProductName) VALUES (?, ?, ?)',
        [productId, storeId, storeProductName]
    );
    return result.insertId;
};

export const getStoreProductsByProductId = async (productId: number) => {
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, Store.name AS storeName, StoreChain.name AS chainName 
         FROM StoreProduct 
         JOIN Store ON StoreProduct.storeId = Store.id 
         JOIN StoreChain ON Store.chainId = StoreChain.id 
         WHERE StoreProduct.productId = ?`,
        [productId]
    );
    return rows;
};

export const getStoreProductsByStoreId = async (storeId: number) => {
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, Store.name AS storeName, StoreChain.name AS chainName 
         FROM StoreProduct 
         JOIN Store ON StoreProduct.storeId = Store.id 
         JOIN StoreChain ON Store.chainId = StoreChain.id 
         WHERE StoreProduct.storeId = ?`,
        [storeId]
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