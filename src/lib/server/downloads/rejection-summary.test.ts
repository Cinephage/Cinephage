import { describe, expect, it } from 'vitest';
import { summarizeRejections } from './rejection-summary';

describe('summarizeRejections', () => {
	it('counts each reason once per candidate', () => {
		expect(summarizeRejections(['desired_quality', 'desired_quality', 'duplicate_hash'])).toBe(
			'No acceptable release: 3 rejected (2 x desired_quality, 1 x duplicate_hash)'
		);
	});

	it('falls back to the caller reason when nothing was rejected', () => {
		expect(summarizeRejections([], 'No releases found')).toBe('No releases found');
		expect(summarizeRejections([])).toBeUndefined();
	});

	it('keeps a single rejection readable', () => {
		expect(summarizeRejections(['duplicate_hash'])).toBe(
			'No acceptable release: 1 rejected (1 x duplicate_hash)'
		);
	});
});
