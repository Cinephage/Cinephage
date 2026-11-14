import { describe, it, expect } from 'vitest';
import { describeRejectionReason, RejectionReason } from './types';

describe('describeRejectionReason', () => {
	it('maps a known RejectionReason enum value to a human-readable sentence', () => {
		expect(describeRejectionReason(RejectionReason.QUALITY_NOT_BETTER)).toBe(
			'No upgrades found - existing file quality is sufficient'
		);
	});

	it('returns an already-human-readable reason (e.g. from BlocklistSpecification) unchanged', () => {
		expect(describeRejectionReason('Release is blocklisted')).toBe('Release is blocklisted');
	});

	it('passes through undefined/empty input unchanged', () => {
		expect(describeRejectionReason(undefined)).toBeUndefined();
	});
});
