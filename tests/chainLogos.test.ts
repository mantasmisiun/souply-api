/**
 * Tests that getProductsByCategoryWithAmounts and getDiscountedProducts
 * return chainLogos in the expected shape: array of { chainId, logoUrl }.
 *
 * DB pool is mocked — no live connection needed.
 */
import { jest } from '@jest/globals';

const mockQuery = jest.fn();

jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockQuery },
}));

const { getProductsByCategoryWithAmounts, getDiscountedProducts } =
    await import('../src/models/productModel.js');

const makeProduct = (chainLogos: any) => ({
    id: 1,
    name: 'Test Product',
    categoryId: 10,
    imageUrls: ['https://example.com/img.jpg'],
    chainLogos,
    minAmount: 100,
    maxAmount: 200,
    unit: 'g',
    hasWeighable: 0,
});

beforeEach(() => mockQuery.mockReset());

describe('chainLogos — getProductsByCategoryWithAmounts', () => {
    it('returns chainLogos as parsed array when product is in multiple chains', async () => {
        const logos = [
            { chainId: 1, logoUrl: 'https://cdn.example.com/rimi.png' },
            { chainId: 2, logoUrl: 'https://cdn.example.com/maxima.png' },
        ];
        mockQuery.mockResolvedValue([[makeProduct(JSON.stringify(logos))]]);

        const results = await getProductsByCategoryWithAmounts(10);
        const product = results[0];

        const parsed = typeof product.chainLogos === 'string'
            ? JSON.parse(product.chainLogos)
            : product.chainLogos;

        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({ chainId: 1, logoUrl: expect.any(String) });
        expect(parsed[1]).toMatchObject({ chainId: 2, logoUrl: expect.any(String) });
    });

    it('returns chainLogos with single chain when product is in one chain only', async () => {
        const logos = [{ chainId: 3, logoUrl: 'https://cdn.example.com/lidl.png' }];
        mockQuery.mockResolvedValue([[makeProduct(JSON.stringify(logos))]]);

        const results = await getProductsByCategoryWithAmounts(10);
        const parsed = typeof results[0].chainLogos === 'string'
            ? JSON.parse(results[0].chainLogos)
            : results[0].chainLogos;

        expect(parsed).toHaveLength(1);
        expect(parsed[0].chainId).toBe(3);
    });

    it('handles null chainLogos gracefully', async () => {
        mockQuery.mockResolvedValue([[makeProduct(null)]]);

        const results = await getProductsByCategoryWithAmounts(10);
        expect(results[0].chainLogos).toBeNull();
    });
});

describe('chainLogos — getDiscountedProducts', () => {
    it('returns chainLogos field on discounted products', async () => {
        const logos = [
            { chainId: 1, logoUrl: 'https://cdn.example.com/rimi.png' },
        ];
        const discountedProduct = {
            ...makeProduct(JSON.stringify(logos)),
            l2CategoryId: 5,
            bestDiscountPct: 20,
        };
        mockQuery.mockResolvedValue([[discountedProduct]]);

        const results = await getDiscountedProducts({});
        const parsed = typeof results[0].chainLogos === 'string'
            ? JSON.parse(results[0].chainLogos)
            : results[0].chainLogos;

        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed[0]).toMatchObject({ chainId: 1, logoUrl: expect.any(String) });
    });
});
