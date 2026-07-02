import { jest } from '@jest/globals';
import { v1Shim } from '../src/utils/versionedRoute.js';

// ── v1Shim (pure) ──
function mkRes() {
    const res: any = { body: undefined, json(b: any) { this.body = b; return this; } };
    return res;
}

describe('v1Shim', () => {
    it('adapts the request before the v2 handler runs', async () => {
        const seen: any = {};
        const v2: any = (req: any, res: any) => { seen.userId = req.query.userId; res.json({ ok: true }); };
        const shim = v1Shim(v2, { adaptRequest: (req) => { (req.query as any).userId = (req.query as any).uid; } });
        const req: any = { query: { uid: 'u1' } };
        shim(req, mkRes(), jest.fn() as any);
        expect(seen.userId).toBe('u1');
    });

    it('reshapes the v2 response into the v1 contract', () => {
        const v2: any = (_req: any, res: any) => res.json({ items: [1, 2, 3] });
        const shim = v1Shim(v2, { adaptResponse: (body: any) => body.items }); // unwrap to bare array
        const res = mkRes();
        shim({ query: {} } as any, res, jest.fn() as any);
        expect(res.body).toEqual([1, 2, 3]);
    });

    it('a throwing request adapter goes to next(err), not the handler', () => {
        const v2 = jest.fn();
        const next = jest.fn();
        const shim = v1Shim(v2 as any, { adaptRequest: () => { throw new Error('bad'); } });
        shim({ query: {} } as any, mkRes(), next as any);
        expect(next).toHaveBeenCalled();
        expect(v2).not.toHaveBeenCalled();
    });
});

// ── versionTelemetry (mock pool) ──
const mockQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query: mockQuery } }));

let recordSighting: any, flushSightings: any, getClientVersionDistribution: any;
beforeAll(async () => {
    const mod = await import('../src/services/versionTelemetry.js');
    recordSighting = mod.recordSighting;
    flushSightings = mod.flushSightings;
    getClientVersionDistribution = mod.getClientVersionDistribution;
});
beforeEach(() => jest.clearAllMocks());

describe('versionTelemetry', () => {
    it('buffers sightings and flushes them as one upsert; ignores unknown platform/blank version', async () => {
        recordSighting('android', '1.2.0');
        recordSighting('android', '1.2.0');
        recordSighting('ios', '1.3.0');
        recordSighting('windows', '9.9.9'); // unknown platform → ignored
        recordSighting('android', '');       // blank version → ignored
        mockQuery.mockResolvedValue([{}]);
        await flushSightings();
        expect(mockQuery).toHaveBeenCalledTimes(1);
        const values = mockQuery.mock.calls[0][1][0]; // the VALUES array
        // android|1.2.0 counted twice, ios|1.3.0 once — two rows, no windows/blank.
        expect(values).toHaveLength(2);
        const android = values.find((r: any[]) => r[0] === 'android' && r[1] === '1.2.0');
        expect(android[3]).toBe(2);
    });

    it('flush is a no-op when the buffer is empty', async () => {
        await flushSightings();
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('re-buffers on a flush error so counts are not lost', async () => {
        recordSighting('web', '2.0.0');
        mockQuery.mockRejectedValueOnce(new Error('db down'));
        await flushSightings();           // fails → counts restored
        mockQuery.mockResolvedValue([{}]);
        await flushSightings();           // retry succeeds
        const values = mockQuery.mock.calls[1][1][0];
        expect(values.find((r: any[]) => r[0] === 'web')[3]).toBe(1);
    });

    it('getClientVersionDistribution clamps + maps rows', async () => {
        mockQuery.mockResolvedValue([[{ platform: 'android', version: '1.2.0', day: '2026-07-01', requests: '42' }]]);
        const out = await getClientVersionDistribution(14);
        expect(out[0]).toEqual({ platform: 'android', version: '1.2.0', day: '2026-07-01', requests: 42 });
    });
});
