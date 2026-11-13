import { describe, it, expect, beforeEach } from 'vitest';
import { TemplateEngine, createTemplateEngine } from './TemplateEngine';
import type { SettingsField } from '../schema/yamlDefinition';
import type { TvSearchCriteria } from '../types';

describe('TemplateEngine', () => {
	let engine: TemplateEngine;

	beforeEach(() => {
		engine = createTemplateEngine();
	});

	describe('setQuery episode tokens', () => {
		const tvCriteria = {
			searchType: 'tv',
			query: 'Fargo',
			season: 1
		} as TvSearchCriteria;

		it('appends the season token to the keywords by default', () => {
			engine.setQuery(tvCriteria);

			expect(engine.getVariable('.Keywords')).toBe('Fargo S01');
		});

		it('leaves the token out when the definition cannot match one', () => {
			engine.setQuery(tvCriteria, { includeEpisodeTokens: false });

			expect(engine.getVariable('.Keywords')).toBe('Fargo');
			// Still set for definitions that format the token themselves.
			expect(engine.getVariable('.Query.Episode')).toBe('S01');
		});
	});

	describe('setConfigWithDefaults', () => {
		it('should apply default values for missing settings', () => {
			const definitionSettings: SettingsField[] = [
				{ name: 'username', type: 'text', default: 'guest' },
				{ name: 'password', type: 'password', default: '' }
			];

			engine.setConfigWithDefaults({}, definitionSettings);

			expect(engine.getVariable('.Config.username')).toBe('guest');
			expect(engine.getVariable('.Config.password')).toBe('');
		});

		it('should prefer user-provided values over defaults', () => {
			const definitionSettings: SettingsField[] = [
				{ name: 'username', type: 'text', default: 'guest' },
				{ name: 'apikey', type: 'password', default: '' }
			];

			engine.setConfigWithDefaults({ username: 'myuser', apikey: 'abc123' }, definitionSettings);

			expect(engine.getVariable('.Config.username')).toBe('myuser');
			expect(engine.getVariable('.Config.apikey')).toBe('abc123');
		});

		it('should convert checkbox to .True or null', () => {
			const definitionSettings: SettingsField[] = [
				{ name: 'freeleech', type: 'checkbox', default: false },
				{ name: 'internal', type: 'checkbox', default: true }
			];

			// Test with defaults
			engine.setConfigWithDefaults({}, definitionSettings);
			expect(engine.getVariable('.Config.freeleech')).toBeNull();
			expect(engine.getVariable('.Config.internal')).toBe('.True');

			// Test with user values
			engine.setConfigWithDefaults({ freeleech: true, internal: false }, definitionSettings);
			expect(engine.getVariable('.Config.freeleech')).toBe('.True');
			expect(engine.getVariable('.Config.internal')).toBeNull();
		});

		it('should convert checkbox string values correctly', () => {
			const definitionSettings: SettingsField[] = [
				{ name: 'enabled', type: 'checkbox', default: false }
			];

			engine.setConfigWithDefaults({ enabled: 'true' }, definitionSettings);
			expect(engine.getVariable('.Config.enabled')).toBe('.True');

			engine.setConfigWithDefaults({ enabled: 'false' }, definitionSettings);
			expect(engine.getVariable('.Config.enabled')).toBeNull();
		});

		it('should convert select index to option key', () => {
			const definitionSettings: SettingsField[] = [
				{
					name: 'quality',
					type: 'select',
					default: 'hd', // Default is a key, will be converted to index 1
					options: {
						all: 'All Qualities',
						hd: 'HD Only',
						sd: 'SD Only'
					}
				}
			];

			// Default (index 1) - options are sorted, so: all=0, hd=1, sd=2
			engine.setConfigWithDefaults({}, definitionSettings);
			expect(engine.getVariable('.Config.quality')).toBe('hd');

			// User selects index 2 (sd)
			engine.setConfigWithDefaults({ quality: 2 }, definitionSettings);
			expect(engine.getVariable('.Config.quality')).toBe('sd');

			// User selects index 0 (all)
			engine.setConfigWithDefaults({ quality: 0 }, definitionSettings);
			expect(engine.getVariable('.Config.quality')).toBe('all');
		});

		it('should handle select with string index', () => {
			const definitionSettings: SettingsField[] = [
				{
					name: 'category',
					type: 'select',
					options: {
						movies: 'Movies',
						tv: 'TV Shows',
						music: 'Music'
					}
				}
			];

			// String "1" should be parsed as index
			engine.setConfigWithDefaults({ category: '1' }, definitionSettings);
			// Sorted: movies=0, music=1, tv=2
			expect(engine.getVariable('.Config.category')).toBe('music');
		});

		it('should handle select with default as key string', () => {
			const definitionSettings: SettingsField[] = [
				{
					name: 'sort',
					type: 'select',
					default: 'seeders', // Default is the key itself
					options: {
						created: 'Date Added',
						seeders: 'Seeders',
						size: 'Size'
					}
				}
			];

			engine.setConfigWithDefaults({}, definitionSettings);
			// "seeders" is at index 2 (sorted: created=0, seeders=1, size=2)
			// Wait, the default is 'seeders' which is a key, so we find its index (1) and use that
			expect(engine.getVariable('.Config.sort')).toBe('seeders');
		});

		it('should clamp select index to valid range', () => {
			const definitionSettings: SettingsField[] = [
				{
					name: 'category',
					type: 'select',
					options: {
						a: 'Option A',
						b: 'Option B'
					}
				}
			];

			// Index out of range (should clamp to last)
			engine.setConfigWithDefaults({ category: 100 }, definitionSettings);
			expect(engine.getVariable('.Config.category')).toBe('b');

			// Negative index (should clamp to 0)
			engine.setConfigWithDefaults({ category: -5 }, definitionSettings);
			expect(engine.getVariable('.Config.category')).toBe('a');
		});

		it('should ignore info-type settings', () => {
			const definitionSettings: SettingsField[] = [
				{ name: 'cookie_info', type: 'info_cookie' },
				{ name: 'flaresolverr_info', type: 'info_flaresolverr' },
				{ name: 'captcha', type: 'cardigannCaptcha' },
				{ name: 'username', type: 'text', default: 'test' }
			];

			engine.setConfigWithDefaults({}, definitionSettings);

			// Info types should not set variables
			expect(engine.hasVariable('.Config.cookie_info')).toBe(false);
			expect(engine.hasVariable('.Config.flaresolverr_info')).toBe(false);
			expect(engine.hasVariable('.Config.captcha')).toBe(false);

			// But normal types should
			expect(engine.getVariable('.Config.username')).toBe('test');
		});

		it('should set user settings not in definition (backward compatibility)', () => {
			const definitionSettings: SettingsField[] = [
				{ name: 'username', type: 'text', default: 'guest' }
			];

			engine.setConfigWithDefaults(
				{ username: 'user', customSetting: 'value123' },
				definitionSettings
			);

			expect(engine.getVariable('.Config.username')).toBe('user');
			expect(engine.getVariable('.Config.customSetting')).toBe('value123');
		});

		it('should handle empty definition settings', () => {
			engine.setConfigWithDefaults({ apikey: 'xyz' }, []);

			expect(engine.getVariable('.Config.apikey')).toBe('xyz');
		});

		it('should handle boolean user settings not in definition', () => {
			engine.setConfigWithDefaults({ enabled: true, disabled: false }, []);

			expect(engine.getVariable('.Config.enabled')).toBe('.True');
			expect(engine.getVariable('.Config.disabled')).toBeNull();
		});
	});

	describe('setConfig (legacy)', () => {
		it('should still work for simple settings', () => {
			engine.setConfig({ username: 'test', password: 'secret' });

			expect(engine.getVariable('.Config.username')).toBe('test');
			expect(engine.getVariable('.Config.password')).toBe('secret');
		});

		it('should convert booleans to .True/null', () => {
			engine.setConfig({ enabled: true, disabled: false });

			expect(engine.getVariable('.Config.enabled')).toBe('.True');
			expect(engine.getVariable('.Config.disabled')).toBeNull();
		});
	});
});
