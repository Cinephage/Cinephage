import { describe, it, expect } from 'vitest';

import { shouldProvisionBrowser, ensureCamoufoxBrowserInBackground } from './browserProvisioning';

describe('shouldProvisionBrowser', () => {
	it('skips when the launcher pins nothing (dev checkout)', () => {
		expect(shouldProvisionBrowser(false, null)).toBe(false);
	});

	it('provisions when the paired build is not installed', () => {
		expect(shouldProvisionBrowser(false, 'v156.0.1-beta.34')).toBe(true);
	});

	it('skips when the paired build is installed (even if another build is active)', () => {
		expect(shouldProvisionBrowser(true, 'v156.0.1-beta.34')).toBe(false);
	});
});

describe('ensureCamoufoxBrowserInBackground', () => {
	it('returns cleanly when auto-fetch is disabled', async () => {
		process.env.CAMOUFOX_AUTO_FETCH = 'false';
		try {
			await expect(ensureCamoufoxBrowserInBackground()).resolves.toBeUndefined();
		} finally {
			delete process.env.CAMOUFOX_AUTO_FETCH;
		}
	});
});
