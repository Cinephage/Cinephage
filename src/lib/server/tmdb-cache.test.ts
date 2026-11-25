import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TmdbCache } from './tmdb-cache';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('TmdbCache stale-while-revalidate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('serves a fresh entry as fresh', () => {
		const cache = new TmdbCache();
		cache.set('k', { a: 1 }, '/discover/movie');
		expect(cache.lookup('k')).toEqual({ data: { a: 1 }, stale: false });
		expect(cache.get('k')).toEqual({ a: 1 });
	});

	it('keeps an expired entry as stale for the stale window, but get() treats it as a miss', () => {
		const cache = new TmdbCache();
		cache.set('k', { a: 1 }, '/discover/movie'); // 1 minute TTL
		vi.advanceTimersByTime(2 * MINUTE);
		expect(cache.lookup('k')).toEqual({ data: { a: 1 }, stale: true });
		expect(cache.get('k')).toBeNull();
	});

	it('drops an entry once it is past TTL plus the stale window', () => {
		const cache = new TmdbCache();
		cache.set('k', { a: 1 }, '/discover/movie');
		vi.advanceTimersByTime(25 * HOUR);
		expect(cache.lookup('k')).toBeNull();
		expect(cache.getStats().size).toBe(0);
	});

	it('a refresh of an existing key does not evict another entry when full', () => {
		const cache = new TmdbCache(2);
		cache.set('a', 1, '/movie/1');
		cache.set('b', 2, '/movie/2');
		cache.set('a', 3, '/movie/1');
		expect(cache.get('a')).toBe(3);
		expect(cache.get('b')).toBe(2);
	});
});
