/**
 * Cloudflare Streaming Bypass Test
 *
 * Tests the Cloudflare-aware streaming functionality
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { clearCloudflareSessions, getCloudflareSessionStats } from './cloudflare-streaming.js';

describe('Cloudflare Streaming Bypass', () => {
	beforeEach(() => {
		clearCloudflareSessions();
	});

	describe('Session Management', () => {
		it('should start with empty session cache', () => {
			const stats = getCloudflareSessionStats();
			expect(stats.cachedDomains).toBe(0);
			expect(stats.sessions).toHaveLength(0);
		});

		it('should clear all sessions', () => {
			expect(() => clearCloudflareSessions()).not.toThrow();
		});
	});
});
