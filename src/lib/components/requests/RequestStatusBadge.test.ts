// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import RequestStatusBadge from './RequestStatusBadge.svelte';
import type { RequestStatus } from '#lib/api/requests.js';

describe('RequestStatusBadge', () => {
	afterEach(() => cleanup());

	it.each([
		['pending', /Pending/i],
		['approved', /Approved/i],
		['awaiting_target', /Waiting for destination/i],
		['failed', /Failed/i],
		['declined', /Declined/i],
		['expired', /Expired/i],
		['cancelled', /Cancelled/i],
		['fulfilled', /Fulfilled/i]
	] as const)('renders the label for status %s', (status, matcher) => {
		render(RequestStatusBadge, { props: { status, size: 'xs' } });
		expect(screen.getByText(matcher)).toBeTruthy();
	});

	it('renders compact text for the extra-small size', () => {
		const { container } = render(RequestStatusBadge, {
			props: { status: 'pending' as RequestStatus, size: 'xs' }
		});
		expect((container.firstElementChild as HTMLElement).className).toContain('text-xs');
	});
});
