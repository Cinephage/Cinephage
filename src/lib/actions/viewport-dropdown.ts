/**
 * Keep a daisyUI CSS dropdown visible inside a scroll box.
 *
 * A `.dropdown-content` is absolutely positioned, so a box with `overflow`
 * other than `visible` (the episode table's `overflow-x-hidden` /
 * `sm:overflow-x-auto` wrapper, which also forces `overflow-y: auto`) clips it
 * and grows a scrollbar for it. While the dropdown is open this action pins
 * the content to the viewport (`position: fixed`) next to its trigger, so no
 * ancestor clips it. It opens upward when there is no room below.
 *
 * The open/close behaviour stays daisyUI's own (`:focus-within`); the action
 * only positions the content while focus is inside the wrapper.
 */

export type DropdownPlacement = 'bottom' | 'top';

export interface DropdownPosition {
	top: number;
	left: number;
	placement: DropdownPlacement;
	maxHeight: number;
}

interface Rect {
	top: number;
	bottom: number;
	right: number;
}

interface Size {
	width: number;
	height: number;
}

/**
 * Where to put dropdown content of `content` size next to `trigger`.
 * The right edge lines up with the trigger's right edge (like `dropdown-end`),
 * the content opens below unless it doesn't fit there and there is more room
 * above, it never leaves the viewport sideways, and `maxHeight` is the room on
 * the chosen side.
 */
export function computeDropdownPosition(
	trigger: Rect,
	content: Size,
	viewport: Size,
	margin = 8
): DropdownPosition {
	const roomBelow = Math.max(0, viewport.height - margin - trigger.bottom);
	const roomAbove = Math.max(0, trigger.top - margin);
	const placement: DropdownPlacement =
		content.height > roomBelow && roomAbove > roomBelow ? 'top' : 'bottom';
	const maxHeight = placement === 'top' ? roomAbove : roomBelow;
	const height = Math.min(content.height, maxHeight);

	const top = placement === 'top' ? trigger.top - height : trigger.bottom;
	const maxLeft = viewport.width - content.width - margin;
	const left = Math.max(margin, Math.min(trigger.right - content.width, maxLeft));

	return { top, left, placement, maxHeight };
}

const STYLE_PROPS = [
	'position',
	'top',
	'left',
	'right',
	'bottom',
	'max-height',
	'overflow-y',
	'transform-origin'
] as const;

export function viewportDropdown(node: HTMLElement) {
	let content: HTMLElement | null = null;
	let listening = false;

	function position() {
		if (!content) return;
		const trigger = node.querySelector<HTMLElement>(':scope > [role="button"]') ?? node;
		const box = content.getBoundingClientRect();
		// Layout sizes ignore the open animation's scale. The natural height also
		// counts what a max-height set on an earlier call hides. jsdom has no
		// layout, so fall back to the bounding box there.
		const naturalHeight = content.scrollHeight + content.offsetHeight - content.clientHeight;
		const size = {
			width: content.offsetWidth || box.width,
			height: naturalHeight || box.height
		};
		const pos = computeDropdownPosition(trigger.getBoundingClientRect(), size, {
			width: document.documentElement.clientWidth || window.innerWidth,
			height: window.innerHeight
		});
		const s = content.style;
		s.setProperty('position', 'fixed');
		s.setProperty('top', `${pos.top}px`);
		s.setProperty('left', `${pos.left}px`);
		s.setProperty('right', 'auto');
		s.setProperty('bottom', 'auto');
		s.setProperty('max-height', `${pos.maxHeight}px`);
		s.setProperty('overflow-y', 'auto');
		s.setProperty('transform-origin', pos.placement === 'top' ? 'bottom' : 'top');
	}

	function start() {
		if (listening) return;
		listening = true;
		window.addEventListener('scroll', position, { capture: true, passive: true });
		window.addEventListener('resize', position);
	}

	function stop() {
		if (listening) {
			window.removeEventListener('scroll', position, { capture: true });
			window.removeEventListener('resize', position);
			listening = false;
		}
		if (content) {
			for (const prop of STYLE_PROPS) content.style.removeProperty(prop);
			content = null;
		}
	}

	function onFocusIn() {
		content = node.querySelector<HTMLElement>(':scope > .dropdown-content');
		if (!content) return;
		position();
		start();
	}

	function onFocusOut(event: FocusEvent) {
		const next = event.relatedTarget;
		if (next instanceof Node && node.contains(next)) return;
		stop();
	}

	node.addEventListener('focusin', onFocusIn);
	node.addEventListener('focusout', onFocusOut);

	return {
		destroy() {
			node.removeEventListener('focusin', onFocusIn);
			node.removeEventListener('focusout', onFocusOut);
			stop();
		}
	};
}
