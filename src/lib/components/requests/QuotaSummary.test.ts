// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import QuotaSummary from './QuotaSummary.svelte';
import type { QuotaStatus } from '#lib/api/requests.js';

function quota(overrides: Partial<QuotaStatus> = {}): QuotaStatus {
	return { days: null, limit: null, used: 0, remaining: null, restricted: false, ...overrides };
}

describe('QuotaSummary', () => {
	afterEach(() => cleanup());

	it('renders the unlimited label when no limit is set', () => {
		render(QuotaSummary, { props: { quota: quota(), type: 'movie' } });
		expect(screen.getByText(/Unlimited/i)).toBeTruthy();
	});

	it('renders used and limit with a progress bar for capped quotas', () => {
		const { container } = render(QuotaSummary, {
			props: { quota: quota({ limit: 5, used: 3, days: 30, remaining: 2 }), type: 'tv' }
		});
		expect(screen.getByText(/3 of 5/)).toBeTruthy();
		expect(screen.getByText(/every 30 days/)).toBeTruthy();
		expect(container.querySelector('progress')).toBeTruthy();
	});

	it('marks the restricted state visually', () => {
		const { container } = render(QuotaSummary, {
			props: { quota: quota({ limit: 5, used: 5, remaining: 0, restricted: true }), type: 'movie' }
		});
		expect((container.firstElementChild as HTMLElement).className).toContain('border-error');
	});

	it('hides the window line when the quota is unlimited', () => {
		const { container } = render(QuotaSummary, { props: { quota: quota(), type: 'movie' } });
		expect(container.querySelector('progress')).toBeNull();
	});
});
