/**
 * The action vocabulary every library detail page speaks.
 *
 * Movie, series, album and artist pages all present the same two bars: a row
 * above the hero, and a fixed bar on phones. Both are rendered by one pair of
 * components from this list — a page describes what it can do, never how the
 * bar looks.
 */

import type { Component } from 'svelte';

export type DetailActionTone = 'default' | 'primary' | 'success' | 'error';

export interface DetailAction {
	key: string;
	/** Desktop button text, and the accessible name of the icon-only form. */
	label: string;
	icon: Component<{ size?: number | string; class?: string }>;
	/** Button behaviour; ignored when `href` is set. */
	onSelect?: () => void;
	/** Renders an anchor (external link) instead of a button. */
	href?: string;
	disabled?: boolean;
	/** Swaps the icon for a spinner and disables the control. */
	busy?: boolean;
	/** A toggle that is currently on (monitor), coloured success. */
	active?: boolean;
	tone?: DetailActionTone;
	/** Filled primary button on the desktop row; everything else is ghost. */
	emphasis?: 'primary' | 'ghost';
	/** Icon only on the desktop row, with the label as its tooltip. */
	iconOnly?: boolean;
	/** Count badge beside the desktop label (missing episodes). */
	badge?: string | number | null;
	/** Short label for the mobile bar; falls back to `label`. */
	compactLabel?: string;
}
