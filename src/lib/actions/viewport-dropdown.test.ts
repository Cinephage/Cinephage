import { describe, it, expect } from 'vitest';
import { computeDropdownPosition } from './viewport-dropdown.js';

function rect(top: number, bottom: number, right: number) {
	return { top, bottom, right };
}

describe('computeDropdownPosition', () => {
	it('opens below with its right edge on the trigger when there is room', () => {
		const pos = computeDropdownPosition(
			rect(100, 124, 900),
			{ width: 208, height: 140 },
			{ width: 1280, height: 800 }
		);
		expect(pos.placement).toBe('bottom');
		expect(pos.top).toBe(124);
		expect(pos.left + 208).toBe(900);
		expect(pos.maxHeight).toBe(800 - 8 - 124);
	});

	it('opens above a trigger in the last row near the bottom of the viewport', () => {
		const pos = computeDropdownPosition(
			rect(740, 764, 900),
			{ width: 256, height: 180 },
			{ width: 1280, height: 800 }
		);
		expect(pos.placement).toBe('top');
		expect(pos.top).toBe(740 - 180);
		expect(pos.top).toBeGreaterThanOrEqual(8);
		expect(pos.maxHeight).toBe(740 - 8);
	});

	it('clamps left to the margin near the left edge of a phone', () => {
		const pos = computeDropdownPosition(
			rect(200, 224, 120),
			{ width: 256, height: 180 },
			{ width: 375, height: 667 }
		);
		expect(pos.left).toBe(8);
	});

	it('clamps left so the content never leaves the right edge', () => {
		const pos = computeDropdownPosition(
			rect(200, 224, 400),
			{ width: 256, height: 180 },
			{ width: 375, height: 667 }
		);
		expect(pos.left).toBe(375 - 256 - 8);
	});

	it('caps the height at the larger room when the content fits on neither side', () => {
		const pos = computeDropdownPosition(
			rect(400, 424, 300),
			{ width: 288, height: 1000 },
			{ width: 375, height: 667 }
		);
		expect(pos.placement).toBe('top');
		expect(pos.maxHeight).toBe(400 - 8);
		expect(pos.top).toBe(8);

		const below = computeDropdownPosition(
			rect(100, 124, 300),
			{ width: 288, height: 1000 },
			{ width: 375, height: 667 }
		);
		expect(below.placement).toBe('bottom');
		expect(below.maxHeight).toBe(667 - 8 - 124);
		expect(below.top).toBe(124);
	});

	it('places the w-52 menu on a 375x667 phone fully inside the viewport', () => {
		const pos = computeDropdownPosition(
			rect(620, 644, 360),
			{ width: 208, height: 140 },
			{ width: 375, height: 667 }
		);
		expect(pos.placement).toBe('top');
		expect(pos.top).toBe(480);
		expect(pos.left).toBe(152);
		expect(pos.left).toBeGreaterThanOrEqual(8);
		expect(pos.left + 208).toBeLessThanOrEqual(375 - 8);
		expect(pos.top + 140).toBeLessThanOrEqual(644);
	});
});
