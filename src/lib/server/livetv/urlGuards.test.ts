import { describe, expect, it } from 'vitest';
import { resolveHttpUrl } from './urlGuards';

describe('resolveHttpUrl', () => {
	it('accepts ordinary http and https URLs', () => {
		expect(resolveHttpUrl('http://epg.local/xmltv.php?user=a&pass=b')?.protocol).toBe('http:');
		expect(resolveHttpUrl('https://example.com/epg.xml')?.protocol).toBe('https:');
	});

	it('rejects non-http schemes a malicious playlist could declare', () => {
		expect(resolveHttpUrl('file:///etc/passwd')).toBeNull();
		expect(resolveHttpUrl('javascript:alert(1)')).toBeNull();
		expect(resolveHttpUrl('data:text/html,x')).toBeNull();
		expect(resolveHttpUrl('ftp://example.com/epg')).toBeNull();
	});

	it('rejects malformed values', () => {
		expect(resolveHttpUrl('not a url')).toBeNull();
		expect(resolveHttpUrl('')).toBeNull();
		expect(resolveHttpUrl(null)).toBeNull();
		expect(resolveHttpUrl(undefined)).toBeNull();
	});
});
