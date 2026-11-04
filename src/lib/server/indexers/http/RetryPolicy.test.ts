import { describe, it, expect, vi, afterEach } from 'vitest';
import { RetryPolicy, calculateRetryDelay, parseRetryAfter } from './RetryPolicy.js';
import type { RetryDecision } from './RetryPolicy.js';

afterEach(() => {
	vi.useRealTimers();
});

/** A decision function that always retries with the given suggested delay. */
function retryWithDelay(suggestedDelayMs: number | undefined) {
	return (): RetryDecision => ({
		shouldRetry: true,
		suggestedDelayMs,
		reason: 'test'
	});
}

/** An operation that fails on every attempt and records the attempt numbers. */
function failingOperation(attempts: number[]) {
	return async (context: { attempt: number }) => {
		attempts.push(context.attempt);
		throw new Error(`fail ${context.attempt}`);
	};
}

describe('RetryPolicy', () => {
	describe('execute', () => {
		it('retries a retryable error up to maxRetries and then throws', async () => {
			vi.useFakeTimers();
			const policy = new RetryPolicy({ maxRetries: 2, initialDelayMs: 100, maxDelayMs: 1000 });
			const attempts: number[] = [];

			const execution = policy.execute(failingOperation(attempts), retryWithDelay(undefined));
			execution.catch(() => {});
			await vi.runAllTimersAsync();

			await expect(execution).rejects.toThrow('fail 3');
			expect(attempts).toEqual([1, 2, 3]);
		});

		it('does not retry when the decision says so', async () => {
			const policy = new RetryPolicy({ maxRetries: 3 });
			const attempts: number[] = [];

			await expect(
				policy.execute(failingOperation(attempts), () => ({
					shouldRetry: false,
					reason: 'test'
				}))
			).rejects.toThrow('fail 1');
			expect(attempts).toEqual([1]);
		});

		it('waits the suggested Retry-After delay when it fits within maxDelayMs', async () => {
			vi.useFakeTimers();
			const policy = new RetryPolicy({ maxRetries: 1, initialDelayMs: 100, maxDelayMs: 5000 });
			const operation = vi.fn(async () => {
				if (operation.mock.calls.length > 1) {
					return 'ok';
				}
				throw new Error('boom');
			});

			const execution = policy.execute(operation, retryWithDelay(500));
			execution.catch(() => {});
			await vi.advanceTimersByTimeAsync(499);
			expect(operation).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(execution).resolves.toMatchObject({ result: 'ok', attempts: 2 });
			expect(operation).toHaveBeenCalledTimes(2);
		});

		it('never retries when Retry-After exceeds maxDelayMs', async () => {
			const policy = new RetryPolicy({ maxRetries: 2, initialDelayMs: 100, maxDelayMs: 5000 });
			const attempts: number[] = [];

			await expect(
				policy.execute(failingOperation(attempts), retryWithDelay(60000))
			).rejects.toThrow('fail 1');
			expect(attempts).toEqual([1]);
		});

		it('still retries when Retry-After is absent', async () => {
			vi.useFakeTimers();
			const policy = new RetryPolicy({ maxRetries: 1, initialDelayMs: 100, maxDelayMs: 1000 });
			const attempts: number[] = [];

			const execution = policy.execute(failingOperation(attempts), retryWithDelay(undefined));
			execution.catch(() => {});
			await vi.runAllTimersAsync();

			await expect(execution).rejects.toThrow('fail 2');
			expect(attempts).toEqual([1, 2]);
		});
	});

	describe('calculateRetryDelay', () => {
		it('prefers the suggested delay, clamped to [initialDelayMs, maxDelayMs]', () => {
			const config = { initialDelayMs: 100, maxDelayMs: 1000 };
			expect(calculateRetryDelay(1, config, 500)).toBe(500);
			expect(calculateRetryDelay(1, config, 50)).toBe(100);
			expect(calculateRetryDelay(1, config, 5000)).toBe(1000);
		});
	});

	describe('parseRetryAfter', () => {
		it('parses delay-seconds and HTTP dates', () => {
			expect(parseRetryAfter(new Headers({ 'Retry-After': '30' }))).toBe(30000);
			const future = new Date(Date.now() + 60_000).toUTCString();
			const parsed = parseRetryAfter(new Headers({ 'Retry-After': future }));
			expect(parsed).toBeGreaterThan(55_000);
			expect(parseRetryAfter(new Headers())).toBeUndefined();
		});
	});
});
