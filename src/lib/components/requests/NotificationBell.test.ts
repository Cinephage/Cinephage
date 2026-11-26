// @vitest-environment jsdom
/**
 * The notification panel closes on Escape, on a tap outside (without the tap
 * also activating what is underneath, except for marked app chrome such as the
 * side menu, which closes the panel and acts in one tap) and on navigation.
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

	it('a tap on the side menu closes the panel and follows the link in one tap', async () => {
		await openPanel();
		const aside = document.createElement('aside');
		aside.setAttribute('data-dismiss-passthrough', '');
		const link = document.createElement('a');
		link.href = '#library';
		const onLinkClick = vi.fn();
		link.addEventListener('click', onLinkClick);
		aside.appendChild(link);
		document.body.appendChild(aside);

		await fireEvent.pointerDown(link);
		await fireEvent.click(link);

		expect(isOpen()).toBe(false);
		expect(onLinkClick).toHaveBeenCalledOnce();
	});

	it('a tap on the menu button closes the panel and opens the menu', async () => {
		await openPanel();
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.id = 'main-drawer';
		const label = document.createElement('label');
		label.htmlFor = 'main-drawer';
		label.setAttribute('data-dismiss-passthrough', '');
		label.textContent = 'menu';
		document.body.append(checkbox, label);

		await fireEvent.pointerDown(label);
		await fireEvent.click(label);

		expect(isOpen()).toBe(false);
		expect(checkbox.checked).toBe(true);
	});

	it('a tap on the bell while open closes the panel and keeps it closed', async () => {
		await openPanel();
		const bell = screen.getByRole('button', { name: m.requests_notifTitle() });
		await fireEvent.pointerDown(bell);
		await fireEvent.click(bell);
		expect(isOpen()).toBe(false);
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
