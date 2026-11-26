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

describe('EpisodeRow dropdowns stay inside the viewport', () => {
	const mediaInfo = { videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 };

	function stubRect(el: Element, r: { top: number; bottom: number; left: number; right: number }) {
		const value = {
			...r,
			x: r.left,
			y: r.top,
			width: r.right - r.left,
			height: r.bottom - r.top,
			toJSON: () => ({})
		};
		(el as HTMLElement).getBoundingClientRect = () => value as DOMRect;
	}

	function dropdowns(container: HTMLElement) {
		return Array.from(container.querySelectorAll<HTMLElement>('.dropdown'));
	}

	function openNearBottom(dropdown: HTMLElement) {
		const trigger = dropdown.querySelector<HTMLElement>(':scope > [role="button"]')!;
		const content = dropdown.querySelector<HTMLElement>(':scope > .dropdown-content')!;
		const bottom = window.innerHeight - 20;
		stubRect(trigger, { top: bottom - 24, bottom, left: 300, right: 330 });
		stubRect(content, { top: 0, bottom: 150, left: 0, right: 208 });
		trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		return { trigger, content, triggerTop: bottom - 24 };
	}

	function hasSearch(dropdown: HTMLElement) {
		return dropdown.querySelector('.menu.dropdown-content') !== null;
	}

	function hasMediaInfo(dropdown: HTMLElement) {
		return /h264/i.test(dropdown.querySelector('.dropdown-content')?.textContent ?? '');
	}

	it('pins every dropdown to the viewport, opening upward near the bottom', () => {
		const { container } = renderRow(makeEpisode({ file: { ...fileStub, mediaInfo } }));
		const all = dropdowns(container);

		// Phone + desktop copies of the search menu, media info and subtitles.
		expect(all.filter(hasSearch).length).toBe(2);
		expect(all.filter(hasMediaInfo).length).toBe(2);
		expect(all.length).toBe(6);

		for (const dropdown of all) {
			const { content, triggerTop } = openNearBottom(dropdown);
			expect(content.style.position).toBe('fixed');
			expect(parseFloat(content.style.top)).toBeLessThan(triggerTop);
			expect(parseFloat(content.style.top) + 150).toBeLessThanOrEqual(triggerTop);

			dropdown.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
			expect(content.style.position).toBe('');
			expect(content.style.top).toBe('');
		}
	});

	it('keeps the content pinned while focus moves inside the dropdown', () => {
		const { container } = renderRow(makeEpisode({ file: { ...fileStub, mediaInfo } }));
		const dropdown = dropdowns(container).find(hasSearch)!;
		const { content } = openNearBottom(dropdown);
		const button = content.querySelector('button')!;

		dropdown.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: button }));
		expect(content.style.position).toBe('fixed');
	});

	it('read-only: no search dropdown, media info still pinned', () => {
		const { container } = renderRow(makeEpisode({ file: { ...fileStub, mediaInfo } }), {
			readOnly: true
		});
		const all = dropdowns(container);
		expect(all.filter(hasSearch).length).toBe(0);

		const info = all.filter(hasMediaInfo);
		expect(info.length).toBe(2);
		for (const dropdown of info) {
			const { content } = openNearBottom(dropdown);
			expect(content.style.position).toBe('fixed');
		}
	});
});
