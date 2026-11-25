// @vitest-environment jsdom
/**
 * The notification panel closes on Escape, on a tap outside (without the tap
 * also activating what is underneath) and on navigation.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';

const navigation = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }));

vi.mock('$app/navigation', () => ({
	afterNavigate: (callback: () => void) => {
		navigation.callbacks.push(callback);
	}
}));

vi.mock('#lib/api/requests.js', () => ({
	listNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0 })),
	markNotificationsRead: vi.fn(async () => {})
}));

import NotificationBell from './NotificationBell.svelte';
import * as m from '#lib/paraglide/messages.js';

async function openPanel() {
	render(NotificationBell, { props: { enabled: false } });
	await fireEvent.click(screen.getByRole('button', { name: m.requests_notifTitle() }));
	expect(screen.getByText(m.requests_notifEmpty())).toBeTruthy();
}

const isOpen = () => screen.queryByText(m.requests_notifEmpty()) !== null;

describe('NotificationBell panel', () => {
	beforeEach(() => {
		navigation.callbacks.length = 0;
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
	});

	it('closes on Escape', async () => {
		await openPanel();
		await fireEvent.keyDown(document.body, { key: 'Escape' });
		expect(isOpen()).toBe(false);
	});

	it('closes on a tap outside without activating what is underneath', async () => {
		await openPanel();
		const poster = document.createElement('a');
		poster.href = '#movie';
		const onPosterClick = vi.fn();
		poster.addEventListener('click', onPosterClick);
		document.body.appendChild(poster);

		await fireEvent.pointerDown(poster);
		await fireEvent.click(poster);

		expect(isOpen()).toBe(false);
		expect(onPosterClick).not.toHaveBeenCalled();
	});

	it('stays open on a tap inside', async () => {
		await openPanel();
		await fireEvent.pointerDown(screen.getByText(m.requests_notifEmpty()));
		expect(isOpen()).toBe(true);
	});

	it('closes after navigation', async () => {
		await openPanel();
		expect(navigation.callbacks.length).toBeGreaterThan(0);
		navigation.callbacks.forEach((callback) => callback());
		await Promise.resolve();
		expect(isOpen()).toBe(false);
	});
});
