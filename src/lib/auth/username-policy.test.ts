import { describe, expect, it } from 'vitest';
import {
	HARD_RESERVED_USERNAMES,
	isHardReservedUsername,
	isValidUsernameFormat
} from './username-policy.js';

describe('username policy', () => {
	it('hard-reserves route namespaces and system identities', () => {
		expect(HARD_RESERVED_USERNAMES).toContain('login');
		expect(HARD_RESERVED_USERNAMES).toContain('root');
		expect(HARD_RESERVED_USERNAMES).toContain('setup');
		expect(HARD_RESERVED_USERNAMES).toContain('system');
		expect(isHardReservedUsername('LOGIN')).toBe(true);
		expect(isHardReservedUsername('profile')).toBe(true);
		expect(isHardReservedUsername('Root')).toBe(true);
		expect(isHardReservedUsername('SYSTEM')).toBe(true);
		expect(isHardReservedUsername('admin')).toBe(false);
	});

	it('shares the same basic format rules used by auth validation', () => {
		expect(isValidUsernameFormat('admin_user')).toBe(true);
		expect(isValidUsernameFormat('ab')).toBe(false);
	});

	it('allows single periods and hyphens between other characters', () => {
		expect(isValidUsernameFormat('john.doe')).toBe(true);
		expect(isValidUsernameFormat('mary-jane')).toBe(true);
		expect(isValidUsernameFormat('a.b-c_d')).toBe(true);
		expect(isValidUsernameFormat('.john')).toBe(false);
		expect(isValidUsernameFormat('john.')).toBe(false);
		expect(isValidUsernameFormat('-john')).toBe(false);
		expect(isValidUsernameFormat('john..doe')).toBe(false);
		expect(isValidUsernameFormat('john.-doe')).toBe(false);
		expect(isValidUsernameFormat('john doe')).toBe(false);
		expect(isValidUsernameFormat('john@doe')).toBe(false);
	});

	it('keeps every username the underscore-only rule accepted', () => {
		for (const name of ['_admin', 'admin_', 'john__doe', '___', 'abc123']) {
			expect(isValidUsernameFormat(name)).toBe(true);
		}
	});
});
