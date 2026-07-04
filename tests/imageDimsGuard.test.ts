import { guardImageDims } from '../src/services/receiptSaveService.js';

/**
 * Band-drift class pin: a client autosave must never change the persisted OCR
 * coordinate-space dims for the SAME image file. Receipt-230's drift was exactly this —
 * a focus-return autosave built during loadExistingReceipt's null-imageDims window
 * persisted geometry-derived dims (914x3402, = maxGeometry+24 fingerprint) over the
 * real 925x3699; the next open squashed the image ×1.087 under every band.
 */
describe('guardImageDims', () => {
    const stored = { fp: 'http://minio/receipts/1-receipt-230.jpg', w: 925, h: 3699 };

    it('rejects a dims change for the same filePath and restores stored dims in place', () => {
        const incoming: any = { filePath: stored.fp, width: 914, height: 3402 };
        expect(guardImageDims(stored, incoming)).toBe(true);
        expect(incoming.width).toBe(925);
        expect(incoming.height).toBe(3699);
    });

    it('rejects a dims change when the incoming filePath is missing (stale-null client blob)', () => {
        const incoming: any = { filePath: null, width: 914, height: 3402 };
        expect(guardImageDims(stored, incoming)).toBe(true);
        expect(incoming.width).toBe(925);
    });

    it('accepts new dims for a genuinely NEW filePath (re-upload)', () => {
        const incoming: any = { filePath: 'http://minio/receipts/2-receipt-230.jpg', width: 800, height: 3000 };
        expect(guardImageDims(stored, incoming)).toBe(false);
        expect(incoming.width).toBe(800);
    });

    it('no-op when dims are unchanged', () => {
        const incoming: any = { filePath: stored.fp, width: 925, height: 3699 };
        expect(guardImageDims(stored, incoming)).toBe(false);
    });

    it('no-op when the stored row has no valid dims (true legacy image:null receipt)', () => {
        const incoming: any = { filePath: 'x.jpg', width: 914, height: 3402 };
        expect(guardImageDims({ fp: 'x.jpg', w: null, h: null }, incoming)).toBe(false);
        expect(guardImageDims(undefined, incoming)).toBe(false);
        expect(incoming.width).toBe(914);
    });
});
