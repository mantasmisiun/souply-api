import { jest } from '@jest/globals';
import { withDeadlockRetry } from '../src/utils/withDeadlockRetry.js';
import { countFailOpen, snapshotFailOpen, drainFailOpen } from '../src/services/failOpenMetrics.js';

describe('withDeadlockRetry', () => {
    it('returns the result on first success (no retry)', async () => {
        const op = jest.fn<any>(async () => 'ok');
        expect(await withDeadlockRetry(op)).toBe('ok');
        expect(op).toHaveBeenCalledTimes(1);
    });

    it('retries on ER_LOCK_DEADLOCK then succeeds', async () => {
        let n = 0;
        const op = jest.fn<any>(async () => {
            if (++n < 2) { const e: any = new Error('deadlock'); e.code = 'ER_LOCK_DEADLOCK'; throw e; }
            return 'recovered';
        });
        expect(await withDeadlockRetry(op, { attempts: 3, baseDelayMs: 1 })).toBe('recovered');
        expect(op).toHaveBeenCalledTimes(2);
    });

    it('retries on ER_LOCK_WAIT_TIMEOUT', async () => {
        let n = 0;
        const op = jest.fn<any>(async () => {
            if (++n < 3) { const e: any = new Error('wait'); e.code = 'ER_LOCK_WAIT_TIMEOUT'; throw e; }
            return 'done';
        });
        expect(await withDeadlockRetry(op, { attempts: 3, baseDelayMs: 1 })).toBe('done');
        expect(op).toHaveBeenCalledTimes(3);
    });

    it('gives up after N attempts and rethrows the deadlock', async () => {
        const op = jest.fn<any>(async () => { const e: any = new Error('dl'); e.code = 'ER_LOCK_DEADLOCK'; throw e; });
        await expect(withDeadlockRetry(op, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow('dl');
        expect(op).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a non-deadlock error (rethrows immediately)', async () => {
        const op = jest.fn<any>(async () => { const e: any = new Error('constraint'); e.code = 'ER_DUP_ENTRY'; throw e; });
        await expect(withDeadlockRetry(op, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('constraint');
        expect(op).toHaveBeenCalledTimes(1);
    });
});

describe('failOpenMetrics', () => {
    beforeEach(() => drainFailOpen()); // reset

    it('counts by site and snapshots without resetting', () => {
        countFailOpen('fallback-propagation');
        countFailOpen('fallback-propagation');
        countFailOpen('points');
        expect(snapshotFailOpen()).toEqual({ 'fallback-propagation': 2, points: 1 });
        // snapshot did not reset:
        expect(snapshotFailOpen()).toEqual({ 'fallback-propagation': 2, points: 1 });
    });

    it('drain returns the snapshot AND resets to empty', () => {
        countFailOpen('resolver-line');
        expect(drainFailOpen()).toEqual({ 'resolver-line': 1 });
        expect(drainFailOpen()).toEqual({});
    });
});
