import { describe, expect, it } from 'vitest';
import { RateGate } from './rate-gate.js';

function fakeClock() {
	let clock = 1_000_000;
	const sleeps: number[] = [];
	const sleep = async (ms: number) => {
		sleeps.push(ms);
		clock += ms;
	};
	return {
		sleep,
		sleeps,
		now: () => clock,
		advance: (ms: number) => {
			clock += ms;
		}
	};
}

describe('RateGate', () => {
	it('spaces two callers that arrive together', async () => {
		const clock = fakeClock();
		const gate = new RateGate(1200, clock.now, clock.sleep);

		await gate.wait();
		await gate.wait();

		expect(clock.sleeps).toEqual([1200]);
	});

	it('does not wait when the interval has already passed', async () => {
		const clock = fakeClock();
		const gate = new RateGate(1200, clock.now, clock.sleep);

		await gate.wait();
		clock.advance(5000);
		await gate.wait();

		expect(clock.sleeps).toEqual([]);
	});

	it('holds every caller, not just the one that saw the 503', async () => {
		const clock = fakeClock();
		const gate = new RateGate(1200, clock.now, clock.sleep);

		gate.hold(5000);
		await gate.wait();

		// A second caller queued behind the hold waits as well.
		await gate.wait();
		expect(clock.sleeps[0]).toBe(5000);
		expect(clock.sleeps[1]).toBe(1200);
	});

	it('keeps a slower pace for a while after a throttle, not just one sleep', async () => {
		const clock = fakeClock();
		const gate = new RateGate(1000, clock.now, clock.sleep);

		gate.throttle(0, 60_000);
		await gate.wait();
		await gate.wait();

		// 2.5x the base interval inside the penalty window.
		expect(clock.sleeps).toEqual([2500]);
	});

	it('returns to its base interval once the penalty window has passed', async () => {
		const clock = fakeClock();
		const gate = new RateGate(1000, clock.now, clock.sleep);

		gate.throttle(0, 60_000);
		clock.advance(61_000);
		await gate.wait();
		await gate.wait();

		expect(clock.sleeps).toEqual([1000]);
	});

	it('never shortens a hold that is already further out', async () => {
		const clock = fakeClock();
		const gate = new RateGate(1200, clock.now, clock.sleep);

		gate.hold(9000);
		gate.hold(2000);
		await gate.wait();

		expect(clock.sleeps).toEqual([9000]);
	});
});
