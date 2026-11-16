import { describe, expect, it } from 'vitest';
import { DesiredQualityStage } from './DesiredQualityStage.js';
import { makeGrabDecisionContext } from '../../../../../test/fixtures/filters.js';
import type { GrabDecisionContext } from './types.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';

interface MovieCtxOptions {
	desiredQualities?: Resolution[];
	resolution?: Resolution;
	force?: boolean;
	profile?: Record<string, unknown>;
}

function movieCtx(options: MovieCtxOptions = {}): GrabDecisionContext {
	const { desiredQualities, resolution, force = false, profile } = options;
	const base = makeGrabDecisionContext();
	return makeGrabDecisionContext({
		desiredQualities,
		profile: { ...base.profile, ...(profile ?? {}) } as GrabDecisionContext['profile'],
		options: { force, skipBlocklist: false, allowSidegrade: false, isAutomatic: true },
		computed: resolution ? { scoringResult: { resolution } as never } : {}
	});
}

const stage = new DesiredQualityStage();

describe('DesiredQualityStage', () => {
	it('is enabled for movie targets only, and never under force', () => {
		expect(stage.isEnabled(movieCtx())).toBe(true);
		expect(stage.isEnabled(movieCtx({ force: true }))).toBe(false);
		expect(
			stage.isEnabled(
				makeGrabDecisionContext({
					target: { type: 'episode', episodeId: 'ep-1', seriesId: 'series-1' }
				})
			)
		).toBe(false);
	});

	it('accepts when the movie declares no desired qualities', async () => {
		const result = await stage.evaluate(movieCtx({ resolution: '2160p' }));
		expect(result.accepted).toBe(true);
	});

	it('accepts a candidate at the declared resolution', async () => {
		const result = await stage.evaluate(
			movieCtx({ desiredQualities: ['1080p'], resolution: '1080p' })
		);
		expect(result.accepted).toBe(true);
	});

	it('rejects a candidate above the declared resolution', async () => {
		const result = await stage.evaluate(
			movieCtx({ desiredQualities: ['1080p'], resolution: '2160p' })
		);
		expect(result.accepted).toBe(false);
		expect(result.details?.rejectionType).toBe('desired_quality');
		expect(result.reason).toContain('2160p');
		expect(result.reason).toContain('1080p');
	});

	it('rejects a candidate below the declared resolution', async () => {
		const result = await stage.evaluate(
			movieCtx({ desiredQualities: ['1080p'], resolution: '720p' })
		);
		expect(result.accepted).toBe(false);
	});

	it('accepts every tier of a multi-quality list', async () => {
		for (const resolution of ['2160p', '1080p'] as Resolution[]) {
			const result = await stage.evaluate(
				movieCtx({ desiredQualities: ['2160p', '1080p'], resolution })
			);
			expect(result.accepted).toBe(true);
		}
	});

	it('accepts an unknown resolution (absence of evidence)', async () => {
		const result = await stage.evaluate(
			movieCtx({ desiredQualities: ['1080p'], resolution: 'unknown' })
		);
		expect(result.accepted).toBe(true);
	});

	it('accepts when the profile range empties the declared list', async () => {
		const result = await stage.evaluate(
			movieCtx({
				desiredQualities: ['2160p'],
				resolution: '2160p',
				profile: { maxResolution: '1080p' }
			})
		);
		expect(result.accepted).toBe(true);
	});
});
