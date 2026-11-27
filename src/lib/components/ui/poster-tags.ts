/**
 * The look of every tag drawn on a poster corner: Discover and filmography
 * cards, library cards, the home rows and the smart lists. Kept in one place
 * so a tag sits at the same spot, at the same size and with the same
 * background on every poster, at every width.
 *
 * - Position: 4 px from the corner on phones, 6 px from `sm` up.
 * - Size: 18 px tall, 10 px text; round status icons are 18 px too.
 * - Background: 90 % opaque (readable over any poster), blurred from `sm` up.
 */

/** A corner slot; tags inside stack downwards with a 4 px gap. */
export const POSTER_CORNER = {
	topRight: 'absolute top-1 right-1 z-10 flex flex-col items-end gap-1 sm:top-1.5 sm:right-1.5',
	topLeft: 'absolute top-1 left-1 z-10 flex flex-col items-start gap-1 sm:top-1.5 sm:left-1.5',
	/** Top-right, side by side (a hover button next to the tag). */
	topRightRow: 'absolute top-1 right-1 z-10 flex items-center gap-1 sm:top-1.5 sm:right-1.5'
} as const;

/** Top-left slot below the 24 px selection checkbox (which sits in `topLeft`). */
export const POSTER_CORNER_BELOW_CHECKBOX =
	'absolute top-8 left-1 z-10 flex flex-col items-start gap-1 sm:top-8.5 sm:left-1.5';

/** A tag ("Movie", "Missing", "★ 7.3"); icons inside it are `size-2.5`, text goes in `POSTER_TAG_TEXT`. */
export const POSTER_TAG =
	'badge h-4.5 justify-start gap-0.5 overflow-hidden rounded-full border-none px-1.5 text-[10px] font-semibold whitespace-nowrap shadow-sm sm:backdrop-blur-sm';

/**
 * The text inside a tag. Fonts put their letters above the middle of the line box
 * (1.5 px high at this size), so the box is trimmed to the capital letters and the
 * flex row centres them exactly, next to any icon. Browsers without `text-box`
 * (Firefox) get the measured 1.5 px nudge instead. Long text ends in "…"; only the
 * sides are clipped, so descenders and i-dots stay whole.
 */
export const POSTER_TAG_TEXT =
	'min-w-0 overflow-x-clip overflow-y-visible text-ellipsis whitespace-nowrap [text-box:trim-both_cap_alphabetic] [@supports_not_(text-box:trim-both_cap_alphabetic)]:translate-y-[1.5px]';

/** A round icon-only tag (in library, monitored, requested); icons inside are `size-3`. */
export const POSTER_ICON =
	'flex size-4.5 shrink-0 items-center justify-center rounded-full shadow-sm sm:backdrop-blur-sm';

export type PosterTone =
	| 'primary'
	| 'secondary'
	| 'accent'
	| 'success'
	| 'warning'
	| 'error'
	| 'neutral'
	| 'base'
	| 'muted';

export const POSTER_TONE: Record<PosterTone, string> = {
	primary: 'bg-primary/90 text-primary-content',
	secondary: 'bg-secondary/90 text-secondary-content',
	accent: 'bg-accent/90 text-accent-content',
	success: 'bg-success/90 text-success-content',
	warning: 'bg-warning/90 text-warning-content',
	error: 'bg-error/90 text-error-content',
	neutral: 'bg-neutral/90 text-neutral-content',
	base: 'bg-base-100/90 text-base-content',
	muted: 'bg-base-300/90 text-base-content/70'
};
