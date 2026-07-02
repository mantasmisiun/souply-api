import { jest } from '@jest/globals';

// The middleware test mocks the service (kept separate from versionGate.test.ts, which
// exercises the REAL service against a mocked model — the two module graphs conflict in
// one file).
const mockEval = jest.fn<any>();
jest.unstable_mockModule('../src/services/versionPolicyService.js', () => ({
    evaluateClientVersion: mockEval,
}));

let versionGate: any;
beforeAll(async () => {
    versionGate = (await import('../src/middleware/versionGate.js')).versionGate;
});
beforeEach(() => jest.clearAllMocks());

function mkReqRes(path: string, headers: Record<string, string> = {}) {
    const req: any = { path, originalUrl: path, header: (h: string) => headers[h.toLowerCase()] };
    const res: any = {
        statusCode: 200, body: null, headers: {} as Record<string, string>,
        status(c: number) { this.statusCode = c; return this; },
        json(b: any) { this.body = b; return this; },
        setHeader(k: string, v: string) { this.headers[k] = v; },
    };
    return { req, res };
}

describe('versionGate middleware', () => {
    it('426s a hard-blocked client', async () => {
        mockEval.mockResolvedValue({ status: 'hard', storeUrl: 'play://x', message: 'update', minVersion: '1.2.0' });
        const { req, res } = mkReqRes('/api/baskets', { 'x-client-platform': 'android', 'x-client-version': '1.0.0' });
        const next = jest.fn();
        await versionGate(req, res, next);
        expect(res.statusCode).toBe(426);
        expect(res.body.error).toBe('upgrade_required');
        expect(res.body.storeUrl).toBe('play://x');
        expect(next).not.toHaveBeenCalled();
    });
    it('passes soft clients with the recommend header', async () => {
        mockEval.mockResolvedValue({ status: 'soft', storeUrl: 'play://x' });
        const { req, res } = mkReqRes('/api/baskets', { 'x-client-platform': 'android', 'x-client-version': '1.3.0' });
        const next = jest.fn();
        await versionGate(req, res, next);
        expect(res.headers['X-Client-Update']).toBe('recommended');
        expect(next).toHaveBeenCalled();
    });
    it('FAIL OPEN: no version headers ⇒ next(), never evaluated', async () => {
        const { req, res } = mkReqRes('/api/baskets', {});
        const next = jest.fn();
        await versionGate(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(mockEval).not.toHaveBeenCalled();
    });
    it('EXEMPT: version-check + health always pass even with an old version', async () => {
        for (const p of ['/api/app/version-check', '/health']) {
            const { req, res } = mkReqRes(p, { 'x-client-platform': 'android', 'x-client-version': '0.0.1' });
            const next = jest.fn();
            await versionGate(req, res, next);
            expect(next).toHaveBeenCalled();
        }
        expect(mockEval).not.toHaveBeenCalled();
    });
});
