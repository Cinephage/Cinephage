// @vitest-environment jsdom
/**
 * EpisodeRow requirement-aware subtitle badge tests (language system phase 6).
 *
 * Pins the badge display rules:
 * 1. No `subtitleCounts` on the episode -> legacy behavior exactly (raw count
 *    tooltip, "Missing" label when wantsSubtitles + no subtitles).
 * 2. Counts present -> requirement-aware "X of Y" text with state icons:
 *    0 of N missing (CaptionsOff, warning), partial, satisfied.
 * 3. Cutoff-denominator case: the loader sends the already-truncated
 *    denominator, e.g. "1 of 1".
 * 4. Badge text is screen-reader readable (role="status", not icon-only).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import EpisodeRow from './EpisodeRow.svelte';
import * as m from '#lib/paraglide/messages.js';

const fileStub = {
	id: 'file-1',
	relativePath: '/mnt/tv/Breaking Bad/S01/Breaking.Bad.S01E01.mkv',
	size: 1_000_000,
	quality: { resolution: '1080p' },
	mediaInfo: null,
	releaseGroup: null
};

function makeEpisode(overrides: Record<string, unknown> = {}) {
	return {
		id: 'ep-1',
		seasonNumber: 1,
		episodeNumber: 1,
		absoluteEpisodeNumber: 1,
		title: 'Pilot',
		airDate: '2008-01-20',
		runtime: 58,
		monitored: true,
		hasFile: true,
		file: fileStub,
		subtitles: [] as Array<Record<string, unknown>>,
		...overrides
	};
}

function renderRow(episode = makeEpisode(), props: Record<string, unknown> = {}) {
	return render(EpisodeRow, {
		props: {
			episode: episode as any,
			seriesMonitored: true,
			wantsSubtitles: true,
			...props
		}
	});
}

afterEach(() => {
	cleanup();
});

describe('EpisodeRow subtitle badge without counts (legacy fallback)', () => {
	it('shows the raw count tooltip and no requirement text', () => {
		const { container } = renderRow(makeEpisode({ subtitles: [{ id: 's1', language: 'en' }] }));

		expect(screen.queryByText('0 of 3')).toBeNull();
		expect(screen.queryByText('2 of 3')).toBeNull();
		// Legacy tooltip still present on the popover trigger.
		const triggers = container.querySelectorAll('[role="button"][title*="subtitle"]');
		expect(triggers.length).toBeGreaterThan(0);
	});

	it('keeps the "Missing" label when wantsSubtitles and no subtitles exist', () => {
		renderRow();

		expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
	});
});

describe('EpisodeRow requirement-aware badge', () => {
	it('renders "0 of 3" as missing with the CaptionsOff icon', () => {
		const { container } = renderRow(
			makeEpisode({ subtitleCounts: { satisfiedCount: 0, totalRequirements: 3 } })
		);

		expect(screen.getAllByText('0 of 3').length).toBeGreaterThan(0);
		expect(container.querySelector('.lucide-captions-off')).not.toBeNull();
		// Missing (0 of N) must not keep the legacy "Missing" label.
		expect(screen.queryByText('Missing')).toBeNull();
	});

	it('renders "2 of 3" as partial', () => {
		renderRow(
			makeEpisode({
				subtitles: [{ id: 's1', language: 'en' }],
				subtitleCounts: { satisfiedCount: 2, totalRequirements: 3 }
			})
		);

		expect(screen.getAllByText('2 of 3').length).toBeGreaterThan(0);
	});

	it('renders "3 of 3" as satisfied', () => {
		renderRow(
			makeEpisode({
				subtitles: [{ id: 's1', language: 'en' }],
				subtitleCounts: { satisfiedCount: 3, totalRequirements: 3 }
			})
		);

		expect(screen.getAllByText('3 of 3').length).toBeGreaterThan(0);
	});

	it('handles the cutoff denominator ("1 of 1")', () => {
		renderRow(
			makeEpisode({
				subtitles: [{ id: 's1', language: 'en' }],
				subtitleCounts: { satisfiedCount: 1, totalRequirements: 1 }
			})
		);

		expect(screen.getAllByText('1 of 1').length).toBeGreaterThan(0);
	});

	it('states the progress honestly in the tooltip', () => {
		const { container } = renderRow(
			makeEpisode({
				subtitles: [{ id: 's1', language: 'en' }],
				subtitleCounts: { satisfiedCount: 2, totalRequirements: 3 }
			})
		);

		const triggers = container.querySelectorAll(
			'[role="button"][title="2 of 3 subtitle requirements met"]'
		);
		expect(triggers.length).toBeGreaterThan(0);
	});

	it('exposes the badge to screen readers via role="status"', () => {
		const { container } = renderRow(
			makeEpisode({
				subtitles: [{ id: 's1', language: 'en' }],
				subtitleCounts: { satisfiedCount: 2, totalRequirements: 3 }
			})
		);

		const statusRegions = container.querySelectorAll('span[role="status"]');
		expect(statusRegions.length).toBeGreaterThan(0);
		expect(statusRegions[0].textContent).toContain('2 of 3');
	});

	it('treats a counts payload with requirements as authoritative over wantsSubtitles=false', () => {
		// Counts present means an effective profile governs the series; the
		// requirement progress shows even when the legacy wantsSubtitles flag
		// is off (fallback path unchanged: no counts + wantsSubtitles=false ->
		// no badge, no "Missing").
		renderRow(
			makeEpisode({
				subtitles: [{ id: 's1', language: 'en' }],
				subtitleCounts: { satisfiedCount: 1, totalRequirements: 2 }
			}),
			{ wantsSubtitles: false }
		);

		expect(screen.getAllByText('1 of 2').length).toBeGreaterThan(0);
	});
});

describe('EpisodeRow phone action touch targets', () => {
	function phoneCluster(container: HTMLElement): HTMLElement {
		const deleteButton = container.querySelector<HTMLElement>(
			`button[title="${m.library_episodeRow_deleteEpisode()}"]`
		);
		const cluster = deleteButton?.closest<HTMLElement>('.sm\\:hidden');
		if (!cluster) throw new Error('Expected the phone action cluster to render');
		return cluster;
	}

	it('uses square btn-sm for every phone action button', () => {
		const { container } = renderRow(makeEpisode(), { onDelete: () => {} });
		const controls = phoneCluster(container).querySelectorAll('.btn');
		expect(controls.length).toBeGreaterThanOrEqual(3);
		for (const control of controls) {
			expect(control.classList.contains('btn-sm')).toBe(true);
			expect(control.classList.contains('btn-square')).toBe(true);
			expect(control.classList.contains('btn-xs')).toBe(false);
		}
	});

	it('keeps Delete last in the cluster with its own spacing', () => {
		const { container } = renderRow(makeEpisode(), { onDelete: () => {} });
		const cluster = phoneCluster(container);
		const deleteButton = cluster.querySelector(
			`button[title="${m.library_episodeRow_deleteEpisode()}"]`
		);
		expect(cluster.lastElementChild).toBe(deleteButton);
		expect(deleteButton?.classList.contains('ml-2')).toBe(true);
	});

	it('uses btn-sm for the phone subtitle trigger', () => {
		const { container } = renderRow();
		const trigger = container.querySelector('.sm\\:hidden [role="button"][title*="subtitle"]');
		expect(trigger).not.toBeNull();
		expect(trigger?.classList.contains('btn-sm')).toBe(true);
	});
});
