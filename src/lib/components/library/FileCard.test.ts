// @vitest-environment jsdom
/**
 * FileCard requirement-aware subtitle badge tests (language system phase 6).
 *
 * The movie loader's subtitleStatus + effective profile are distilled into a
 * SubtitleRequirementProgress view-model; FileCard renders:
 * - nothing requirement-aware when the progress is absent (fallback),
 * - "0 of 3" missing / "2 of 3" partial / "3 of 3" satisfied,
 * - a "Cutoff met" marker when satisfied via the profile's cutoff rank.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import FileCard from './FileCard.svelte';
import type { SubtitleRequirementProgress } from '#lib/utils/subtitle-status-display.js';

const fileStub = {
	id: 'file-1',
	relativePath: '/mnt/movies/The.Matrix/The.Matrix.1999.1080p.BluRay.mkv',
	size: 2_000_000_000,
	dateAdded: '2024-01-01T00:00:00Z',
	quality: { resolution: '1080p' },
	mediaInfo: null,
	releaseGroup: null,
	edition: null
};

function progress(
	overrides: Partial<SubtitleRequirementProgress> = {}
): SubtitleRequirementProgress {
	return {
		satisfiedCount: 2,
		totalCount: 3,
		satisfiedViaCutoff: false,
		state: 'partial',
		...overrides
	};
}

function renderCard(subtitleProgress: SubtitleRequirementProgress | null = null) {
	return render(FileCard, {
		props: {
			file: fileStub,
			subtitles: [{ id: 's1', language: 'en' }],
			subtitleProgress
		}
	});
}

afterEach(() => {
	cleanup();
});

describe('FileCard subtitle badge', () => {
	it('shows no requirement text without a progress payload (fallback)', () => {
		renderCard(null);

		expect(screen.queryByText(/ of /)).toBeNull();
		expect(screen.queryByText('Cutoff met')).toBeNull();
	});

	it('renders "0 of 3" missing state', () => {
		renderCard(progress({ satisfiedCount: 0, totalCount: 3, state: 'missing' }));

		expect(screen.getByText('0 of 3')).not.toBeNull();
	});

	it('renders "2 of 3" partial state', () => {
		renderCard(progress());

		expect(screen.getByText('2 of 3')).not.toBeNull();
	});

	it('renders "3 of 3" satisfied state', () => {
		renderCard(progress({ satisfiedCount: 3, totalCount: 3, state: 'satisfied' }));

		expect(screen.getByText('3 of 3')).not.toBeNull();
	});

	it('shows the "Cutoff met" marker only when satisfied via cutoff', () => {
		renderCard(
			progress({ satisfiedCount: 1, totalCount: 2, satisfiedViaCutoff: true, state: 'partial' })
		);
		expect(screen.getByText('Cutoff met')).not.toBeNull();

		cleanup();

		renderCard(progress({ satisfiedViaCutoff: false }));
		expect(screen.queryByText('Cutoff met')).toBeNull();
	});

	it('keeps the badge readable by screen readers (role="status")', () => {
		const { container } = renderCard(progress());

		const statusRegions = container.querySelectorAll('span[role="status"]');
		expect(statusRegions.length).toBe(1);
		expect(statusRegions[0].textContent).toContain('2 of 3');
	});
});
