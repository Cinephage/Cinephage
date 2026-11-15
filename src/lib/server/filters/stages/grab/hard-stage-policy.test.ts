import { describe, expect, it } from 'vitest';
import { skipsHardStages } from './hard-stage-policy.js';

describe('skipsHardStages', () => {
	it('is off for an automatic grab', () => {
		expect(skipsHardStages({ isAutomatic: true })).toBe(false);
	});

	it('is off for an automatic grab even when force is set', () => {
		expect(skipsHardStages({ isAutomatic: true, overrideHardStages: false })).toBe(false);
	});

	it('is on for a manual grab', () => {
		expect(skipsHardStages({ isAutomatic: false })).toBe(true);
	});

	it('is on for an explicit hard override of an automatic grab', () => {
		expect(skipsHardStages({ isAutomatic: true, overrideHardStages: true })).toBe(true);
	});
});
