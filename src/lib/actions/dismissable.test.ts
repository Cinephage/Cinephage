// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dismissable, blurOnEscape, DISMISS_PASSTHROUGH_ATTR } from './dismissable.js';

const mounted: Array<{ destroy: () => void }> = [];

function mount(options: Parameters<typeof dismissable>[1]) {
	const node = document.createElement('div');
	node.innerHTML = '<button type="button">inside</button>';
	document.body.appendChild(node);
	const action = dismissable(node, options);
	mounted.push(action);
	return { node, action };
}

function escape(target: EventTarget = document.body) {
	const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
}

afterEach(() => {
	while (mounted.length) mounted.pop()?.destroy();
	document.body.innerHTML = '';
	document.documentElement.style.overflow = '';
	vi.useRealTimers();
});

describe('dismissable', () => {
	it('closes on Escape wherever focus is', () => {
		const onDismiss = vi.fn();
		mount({ onDismiss });
		escape();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('ignores Escape when escape is off', () => {
		const onDismiss = vi.fn();
		mount({ onDismiss, escape: false });
		escape();
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('closes only the topmost overlay on Escape', () => {
		const lower = vi.fn();
		const upper = vi.fn();
		mount({ onDismiss: lower });
		const top = mount({ onDismiss: upper });
		escape();
		expect(upper).toHaveBeenCalledOnce();
		expect(lower).not.toHaveBeenCalled();

		top.action.destroy();
		escape();
		expect(lower).toHaveBeenCalledOnce();
	});

	it('leaves Escape to a modal dialog stacked on top', () => {
		const onDismiss = vi.fn();
		mount({ onDismiss });
		const modal = document.createElement('div');
		modal.setAttribute('aria-modal', 'true');
		modal.innerHTML = '<input />';
		document.body.appendChild(modal);
		escape(modal.querySelector('input')!);
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('closes on a press outside and swallows the click that follows', () => {
		const onDismiss = vi.fn();
		mount({ onDismiss, outside: true });
		const link = document.createElement('a');
		link.href = '#poster';
		const onLinkClick = vi.fn();
		link.addEventListener('click', onLinkClick);
		document.body.appendChild(link);

		link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(onDismiss).toHaveBeenCalledOnce();

		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		link.dispatchEvent(click);
		expect(onLinkClick).not.toHaveBeenCalled();
		expect(click.defaultPrevented).toBe(true);

		// Only that one click: the next one goes through.
		link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(onLinkClick).toHaveBeenCalledOnce();
	});

	it('stops swallowing when no click follows the press', () => {
		vi.useFakeTimers();
		mount({ onDismiss: vi.fn(), outside: true });
		const target = document.createElement('button');
		const onClick = vi.fn();
		target.addEventListener('click', onClick);
		document.body.appendChild(target);

		target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		vi.advanceTimersByTime(1000);
		target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(onClick).toHaveBeenCalledOnce();
	});

	it('closes on a press on a pass-through control and lets its click through', () => {
		const onDismiss = vi.fn();
		mount({ onDismiss, outside: true });
		const nav = document.createElement('nav');
		nav.setAttribute(DISMISS_PASSTHROUGH_ATTR, '');
		const link = document.createElement('a');
		link.href = '#library';
		const onLinkClick = vi.fn();
		link.addEventListener('click', onLinkClick);
		nav.appendChild(link);
		document.body.appendChild(nav);

		link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(onDismiss).toHaveBeenCalledOnce();

		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		link.dispatchEvent(click);
		expect(onLinkClick).toHaveBeenCalledOnce();
		expect(click.defaultPrevented).toBe(false);
	});

	it('a pass-through press does not leave an earlier swallow behind', () => {
		mount({ onDismiss: vi.fn(), outside: true });
		const plain = document.createElement('div');
		document.body.appendChild(plain);
		const nav = document.createElement('nav');
		nav.setAttribute(DISMISS_PASSTHROUGH_ATTR, '');
		const link = document.createElement('a');
		const onLinkClick = vi.fn();
		link.addEventListener('click', onLinkClick);
		nav.appendChild(link);
		document.body.appendChild(nav);

		// A press with no click after it (a scroll, a drag) arms the swallow.
		plain.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(onLinkClick).toHaveBeenCalledOnce();
	});

	it('does not close on a press inside', () => {
		const onDismiss = vi.fn();
		const { node } = mount({ onDismiss, outside: true });
		node.querySelector('button')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('ignores outside presses unless asked', () => {
		const onDismiss = vi.fn();
		mount({ onDismiss });
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('locks page scroll while open and restores it after', () => {
		const { action } = mount({ onDismiss: vi.fn(), lockScroll: true });
		expect(document.documentElement.style.overflow).toBe('hidden');
		action.destroy();
		expect(document.documentElement.style.overflow).toBe('');
	});

	it('moves focus inside when trapping focus and gives it back on close', async () => {
		// jsdom has no layout, so every element reports a null offsetParent.
		const offsetParent = vi
			.spyOn(HTMLElement.prototype, 'offsetParent', 'get')
			.mockImplementation(function (this: HTMLElement) {
				return this.parentElement;
			});
		const opener = document.createElement('button');
		document.body.appendChild(opener);
		opener.focus();

		const { node, action } = mount({ onDismiss: vi.fn(), trapFocus: true });
		const inside = node.querySelector('button')!;
		await vi.waitFor(() => expect(document.activeElement).toBe(inside));

		action.destroy();
		expect(document.activeElement).toBe(opener);
		offsetParent.mockRestore();
	});

	it('uses the latest options after an update', () => {
		const first = vi.fn();
		const second = vi.fn();
		const { action } = mount({ onDismiss: first });
		action.update({ onDismiss: second });
		escape();
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});
});

describe('blurOnEscape', () => {
	function mountDropdown() {
		const dropdown = document.createElement('div');
		dropdown.className = 'dropdown';
		dropdown.innerHTML =
			'<button type="button" tabindex="0">More</button>' +
			'<ul tabindex="0" class="dropdown-content"><li><button type="button">Delete</button></li></ul>';
		document.body.appendChild(dropdown);
		dropdown.addEventListener('keydown', blurOnEscape);
		const [trigger, item] = Array.from(dropdown.querySelectorAll('button'));
		return { dropdown, trigger, item };
	}

	it('Escape from a menu item returns focus to the trigger and closes the menu', () => {
		const { dropdown, trigger, item } = mountDropdown();
		item.focus();
		const event = escape(item);
		expect(document.activeElement).toBe(trigger);
		expect(dropdown.classList.contains('dropdown-close')).toBe(true);
		expect(event.defaultPrevented).toBe(true);
	});

	it('Escape on the open trigger closes the menu and keeps focus on the trigger', () => {
		const { dropdown, trigger } = mountDropdown();
		trigger.focus();
		const event = escape(trigger);
		expect(document.activeElement).toBe(trigger);
		expect(dropdown.classList.contains('dropdown-close')).toBe(true);
		expect(event.defaultPrevented).toBe(true);
	});

	it('leaves a second Escape to an outer overlay', () => {
		const onDismiss = vi.fn();
		mount({ onDismiss });
		const { item, trigger } = mountDropdown();
		item.focus();
		escape(item);
		expect(onDismiss).not.toHaveBeenCalled();
		escape(trigger);
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('clicking the trigger after Escape reopens the menu', () => {
		const { dropdown, trigger, item } = mountDropdown();
		item.focus();
		escape(item);
		trigger.click();
		expect(dropdown.classList.contains('dropdown-close')).toBe(false);
	});

	it('focus leaving the dropdown clears the close state', () => {
		const { dropdown, item } = mountDropdown();
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		item.focus();
		escape(item);
		outside.focus();
		expect(dropdown.classList.contains('dropdown-close')).toBe(false);
	});

	it('does not stack reopen listeners on repeated Escapes', () => {
		const { dropdown, trigger, item } = mountDropdown();
		const remove = vi.spyOn(dropdown, 'removeEventListener');
		item.focus();
		escape(item);
		trigger.click();
		item.focus();
		escape(item);
		trigger.click();
		expect(remove).toHaveBeenCalledTimes(4);
		expect(dropdown.classList.contains('dropdown-close')).toBe(false);
	});

	it('ignores other keys', () => {
		const dropdown = document.createElement('div');
		dropdown.innerHTML = '<button type="button">More</button>';
		document.body.appendChild(dropdown);
		dropdown.addEventListener('keydown', blurOnEscape);
		const trigger = dropdown.querySelector('button')!;
		trigger.focus();
		trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(document.activeElement).toBe(trigger);
	});
});
