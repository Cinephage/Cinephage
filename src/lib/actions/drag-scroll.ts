/**
 * Click-and-drag horizontal scrolling for carousels, with a short momentum glide.
 *
 * Only mouse pointers are handled: touch and pen keep the browser's native
 * scrolling. A drag that moves further than `threshold` px swallows the click
 * that follows, so letting go over a card does not open it.
 *
 * While dragging, scroll snapping and smooth scrolling are switched off on the
 * node (they fight the 1:1 movement) and restored once the glide ends.
 */
export interface DragScrollOptions {
	/** Turn the behaviour off without removing the action. Default: true. */
	enabled?: boolean;
	/** Distance in px before a press becomes a drag (and the click is swallowed). Default: 5. */
	threshold?: number;
	/** Keep gliding after release. Default: true. */
	momentum?: boolean;
}

const FRICTION = 0.95;
const MIN_VELOCITY = 0.02; // px per ms
const VELOCITY_WINDOW_MS = 100;

export function dragScroll(node: HTMLElement, options: DragScrollOptions = {}) {
	let enabled = options.enabled ?? true;
	let threshold = options.threshold ?? 5;
	let momentum = options.momentum ?? true;

	let pointerId: number | null = null;
	let startX = 0;
	let startScrollLeft = 0;
	let dragging = false;
	let samples: { x: number; t: number }[] = [];
	let glideFrame: number | null = null;
	let suppressClick = false;
	let suppressTimer: ReturnType<typeof setTimeout> | null = null;
	let savedSnap = '';
	let savedBehavior = '';
	let savedUserSelect = '';

	const canScroll = () => node.scrollWidth > node.clientWidth;

	function updateCursor() {
		node.style.cursor = enabled && canScroll() ? (dragging ? 'grabbing' : 'grab') : '';
	}

	function freeze() {
		savedSnap = node.style.scrollSnapType;
		savedBehavior = node.style.scrollBehavior;
		savedUserSelect = node.style.userSelect;
		node.style.scrollSnapType = 'none';
		node.style.scrollBehavior = 'auto';
		node.style.userSelect = 'none';
	}

	function unfreeze() {
		node.style.scrollSnapType = savedSnap;
		node.style.scrollBehavior = savedBehavior;
		node.style.userSelect = savedUserSelect;
	}

	function stopGlide() {
		if (glideFrame !== null) {
			cancelAnimationFrame(glideFrame);
			glideFrame = null;
			unfreeze();
		}
	}

	function glide(velocity: number) {
		let v = velocity;
		let last = performance.now();
		// Track the position as a float: some browsers round scrollLeft, which
		// would stall the slow end of the glide.
		let position = node.scrollLeft;
		const max = node.scrollWidth - node.clientWidth;
		const step = (now: number) => {
			const dt = Math.max(1, now - last);
			last = now;
			position = Math.min(max, Math.max(0, position - v * dt));
			node.scrollLeft = position;
			v *= Math.pow(FRICTION, dt / 16);
			// Stop on low speed or when an edge is reached.
			if (Math.abs(v) < MIN_VELOCITY || position <= 0 || position >= max) {
				glideFrame = null;
				unfreeze();
				return;
			}
			glideFrame = requestAnimationFrame(step);
		};
		glideFrame = requestAnimationFrame(step);
	}

	function onPointerDown(e: PointerEvent) {
		if (!enabled || e.pointerType !== 'mouse' || e.button !== 0 || !canScroll()) return;
		stopGlide();
		pointerId = e.pointerId;
		startX = e.clientX;
		startScrollLeft = node.scrollLeft;
		dragging = false;
		suppressClick = false;
		samples = [{ x: e.clientX, t: e.timeStamp }];
	}

	function onPointerMove(e: PointerEvent) {
		if (e.pointerId !== pointerId) return;
		const dx = e.clientX - startX;
		if (!dragging) {
			if (Math.abs(dx) < threshold) return;
			dragging = true;
			freeze();
			node.setPointerCapture?.(e.pointerId);
			updateCursor();
		}
		e.preventDefault();
		node.scrollLeft = startScrollLeft - dx;
		samples.push({ x: e.clientX, t: e.timeStamp });
		const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
		while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
	}

	function endDrag(e: PointerEvent, cancelled: boolean) {
		if (e.pointerId !== pointerId) return;
		pointerId = null;
		if (!dragging) return;
		dragging = false;
		if (node.hasPointerCapture?.(e.pointerId)) node.releasePointerCapture(e.pointerId);
		updateCursor();

		if (!cancelled) {
			// The click (if any) fires right after pointerup; drop the flag afterwards
			// in case the browser does not send one.
			suppressClick = true;
			if (suppressTimer) clearTimeout(suppressTimer);
			suppressTimer = setTimeout(() => (suppressClick = false), 0);
		}

		const first = samples[0];
		const last = samples[samples.length - 1];
		const dt = last && first ? last.t - first.t : 0;
		const velocity =
			dt > 0 && e.timeStamp - last.t < VELOCITY_WINDOW_MS ? (last.x - first.x) / dt : 0;
		if (momentum && !cancelled && Math.abs(velocity) >= MIN_VELOCITY) {
			glide(velocity);
		} else {
			unfreeze();
		}
	}

	const onPointerUp = (e: PointerEvent) => endDrag(e, false);
	const onPointerCancel = (e: PointerEvent) => endDrag(e, true);

	function onClick(e: MouseEvent) {
		if (!suppressClick) return;
		suppressClick = false;
		e.preventDefault();
		e.stopPropagation();
	}

	// Native link/image dragging would take over the mouse before our threshold.
	function onDragStart(e: DragEvent) {
		if (enabled && canScroll()) e.preventDefault();
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerUp);
	node.addEventListener('pointercancel', onPointerCancel);
	node.addEventListener('click', onClick, true);
	node.addEventListener('dragstart', onDragStart);
	node.addEventListener('mouseenter', updateCursor);

	const resizeObserver =
		typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateCursor()) : null;
	resizeObserver?.observe(node);
	updateCursor();

	return {
		update(next: DragScrollOptions = {}) {
			enabled = next.enabled ?? true;
			threshold = next.threshold ?? 5;
			momentum = next.momentum ?? true;
			if (!enabled) stopGlide();
			updateCursor();
		},
		destroy() {
			stopGlide();
			if (suppressTimer) clearTimeout(suppressTimer);
			resizeObserver?.disconnect();
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', onPointerCancel);
			node.removeEventListener('click', onClick, true);
			node.removeEventListener('dragstart', onDragStart);
			node.removeEventListener('mouseenter', updateCursor);
			node.style.cursor = '';
		}
	};
}
