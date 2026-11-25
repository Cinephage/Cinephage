// @vitest-environment jsdom
/**
 * The 'Prefer Original Title' toggle row used to share a half-width grid cell,
 * which squeezed its label onto three lines on phones. It spans the full row.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import * as m from '#lib/paraglide/messages.js';
import EditMetadataSection from './EditMetadataSection.svelte';

describe('EditMetadataSection prefer-original-title row', () => {
	afterEach(() => {
		cleanup();
	});

	it('spans both grid columns', () => {
		render(EditMetadataSection, { props: { idPrefix: 'movie', preferOriginalTitle: null } });
		const toggle = screen.getByRole('checkbox', {
			name: m.library_metadata_preferOriginalTitle()
		});
		const row = toggle.closest('label')?.parentElement as HTMLElement;

		expect(row.classList.contains('col-span-2')).toBe(true);
	});

	it('still toggles the value and offers Reset', async () => {
		render(EditMetadataSection, { props: { idPrefix: 'movie', preferOriginalTitle: null } });
		expect(
			screen.queryByRole('button', { name: m.library_subtitleRequirements_reset() })
		).toBeNull();

		await fireEvent.click(
			screen.getByRole('checkbox', { name: m.library_metadata_preferOriginalTitle() })
		);

		expect(
			screen.getByRole('button', { name: m.library_subtitleRequirements_reset() })
		).toBeTruthy();
	});
});
