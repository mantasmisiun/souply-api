import { jest } from '@jest/globals';
import { semverCompare, isBelow } from '../src/utils/semverCompare.js';

// ── pure semver ──
describe('semverCompare / isBelow', () => {
    it('orders releases', () => {
        expect(semverCompare('1.2.0', '1.2.1')).toBe(-1);
        expect(semverCompare('1.3.0', '1.2.9')).toBe(1);
        expect(semverCompare('2.0.0', '2.0.0')).toBe(0);
        expect(semverCompare('1.2', '1.2.0')).toBe(0); // missing patch = 0
    });
    it('a release outranks its prerelease', () => {
        expect(semverCompare('1.2.0', '1.2.0-beta.1')!).toBe(1);
        expect(semverCompare('1.2.0-beta.1', '1.2.0')!).toBe(-1);
    });
    it('returns null on garbage (callers fail open)', () => {
        expect(semverCompare('abc', '1.0.0')).toBeNull();
        expect(semverCompare('1.0.0', '')).toBeNull();
    });
    it('isBelow is fail-open: null/empty floor or version ⇒ false', () => {
        expect(isBelow('1.0.0', null)).toBe(false);
        expect(isBelow(null, '2.0.0')).toBe(false);
        expect(isBelow('garbage', '2.0.0')).toBe(false);
        expect(isBelow('1.9.9', '2.0.0')).toBe(true);
        expect(isBelow('2.0.0', '2.0.0')).toBe(false); // at floor = ok
    });
});

// ── service evaluation (mock the model) ──
const mockGetAll = jest.fn<any>();
jest.unstable_mockModule('../src/models/clientVersionPolicyModel.js', () => ({
    getAllClientVersionPolicies: mockGetAll,
}));

let evaluateClientVersion: any;
let invalidateVersionPolicyCache: any;
beforeAll(async () => {
    const mod = await import('../src/services/versionPolicyService.js');
    evaluateClientVersion = mod.evaluateClientVersion;
    invalidateVersionPolicyCache = mod.invalidateVersionPolicyCache;
});
beforeEach(() => { jest.clearAllMocks(); invalidateVersionPolicyCache(); });

const policies = (over: any = {}) => [
    { platform: 'android', minVersion: '1.2.0', recommendedVersion: '1.5.0', storeUrl: 'play://x', message: null, ...over },
];

describe('evaluateClientVersion', () => {
    it('hard-blocks strictly below minVersion', async () => {
        mockGetAll.mockResolvedValue(policies());
        expect((await evaluateClientVersion('android', '1.1.9')).status).toBe('hard');
    });
    it('soft-nudges below recommendedVersion but at/above min', async () => {
        mockGetAll.mockResolvedValue(policies());
        expect((await evaluateClientVersion('android', '1.3.0')).status).toBe('soft');
    });
    it('ok at/above recommended', async () => {
        mockGetAll.mockResolvedValue(policies());
        expect((await evaluateClientVersion('android', '1.5.0')).status).toBe('ok');
    });
    it('FAIL OPEN: unknown platform ⇒ ok', async () => {
        mockGetAll.mockResolvedValue(policies());
        expect((await evaluateClientVersion('windows-phone', '0.0.1')).status).toBe('ok');
    });
    it('FAIL OPEN: no version ⇒ ok', async () => {
        mockGetAll.mockResolvedValue(policies());
        expect((await evaluateClientVersion('android', '')).status).toBe('ok');
    });
    it('FAIL OPEN: null floors block nobody', async () => {
        mockGetAll.mockResolvedValue(policies({ minVersion: null, recommendedVersion: null }));
        expect((await evaluateClientVersion('android', '0.0.1')).status).toBe('ok');
    });
    it('FAIL OPEN: DB error ⇒ ok', async () => {
        mockGetAll.mockRejectedValue(new Error('db down'));
        expect((await evaluateClientVersion('android', '0.0.1')).status).toBe('ok');
    });
});
