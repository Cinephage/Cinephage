/**
 * CloudflareClickSolver tests.
 *
 * Validates challenge-frame detection and the coordinate-based checkbox click
 * (page.mouse.click at the element's bounding-box centre) with a mocked Page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Frame } from 'playwright-core';

vi.mock('#lib/logging/index.js', () => {
	const mockLogger = {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn().mockReturnThis()
	};
	return { logger: mockLogger, createChildLogger: vi.fn(() => mockLogger) };
});

const { findChallengeFrame, attemptChallengeCheckboxClick, hasTurnstileToken } =
	await import('./CloudflareClickSolver');

const CF_URL = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2';

function makeCheckboxLocator(opts: {
	visible?: boolean;
	box?: { x: number; y: number; width: number; height: number } | null;
}) {
	const loc = {
		isVisible: vi.fn().mockResolvedValue(opts.visible ?? true),
		boundingBox: vi
			.fn()
			.mockResolvedValue('box' in opts ? opts.box : { x: 100, y: 200, width: 24, height: 24 })
	};
	return { first: () => loc, _loc: loc };
}

function makeFrame(url: string, checkboxLocator: unknown, detached = false): Frame {
	return {
		url: () => url,
		isDetached: () => detached,
		locator: vi.fn().mockReturnValue(checkboxLocator)
	} as unknown as Frame;
}

function makePage(frames: Frame[], tokenLength = 0) {
	const mouse = {
		move: vi.fn().mockResolvedValue(undefined),
		click: vi.fn().mockResolvedValue(undefined)
	};
	const page = {
		frames: () => frames,
		mouse,
		evaluate: vi.fn().mockResolvedValue(tokenLength)
	} as unknown as Page;
	return { page, mouse };
}

describe('findChallengeFrame', () => {
	it('returns the live Cloudflare challenge frame', () => {
		const main = makeFrame('https://example.com/', {});
		const cf = makeFrame(CF_URL, {});
		const { page } = makePage([main, cf]);
		expect(findChallengeFrame(page)).toBe(cf);
	});

	it('ignores detached challenge frames', () => {
		const cf = makeFrame(CF_URL, {}, true);
		const { page } = makePage([cf]);
		expect(findChallengeFrame(page)).toBeNull();
	});

	it('returns null when no challenge frame is present', () => {
		const { page } = makePage([makeFrame('https://example.com/', {})]);
		expect(findChallengeFrame(page)).toBeNull();
	});
});

describe('attemptChallengeCheckboxClick', () => {
	beforeEach(() => vi.clearAllMocks());

	it('coordinate-clicks the checkbox centre and returns true', async () => {
		const checkbox = makeCheckboxLocator({
			visible: true,
			box: { x: 100, y: 200, width: 24, height: 24 }
		});
		const cf = makeFrame(CF_URL, checkbox);
		const { page, mouse } = makePage([makeFrame('https://example.com/', {}), cf]);

		const clicked = await attemptChallengeCheckboxClick(page);

		expect(clicked).toBe(true);
		// centre = (112, 212)
		expect(mouse.click).toHaveBeenCalledWith(112, 212);
	});

	it('returns false when there is no challenge frame', async () => {
		const { page, mouse } = makePage([makeFrame('https://example.com/', {})]);
		const clicked = await attemptChallengeCheckboxClick(page);
		expect(clicked).toBe(false);
		expect(mouse.click).not.toHaveBeenCalled();
	});

	it('returns false when the checkbox is not visible', async () => {
		const checkbox = makeCheckboxLocator({ visible: false });
		const cf = makeFrame(CF_URL, checkbox);
		const { page, mouse } = makePage([cf]);
		const clicked = await attemptChallengeCheckboxClick(page);
		expect(clicked).toBe(false);
		expect(mouse.click).not.toHaveBeenCalled();
	});

	it('returns false when the checkbox has no bounding box', async () => {
		const checkbox = makeCheckboxLocator({ visible: true, box: null });
		const cf = makeFrame(CF_URL, checkbox);
		const { page, mouse } = makePage([cf]);
		const clicked = await attemptChallengeCheckboxClick(page);
		expect(clicked).toBe(false);
		expect(mouse.click).not.toHaveBeenCalled();
	});
});

describe('hasTurnstileToken', () => {
	it('is true when the response input holds a token', async () => {
		const { page } = makePage([], 21);
		expect(await hasTurnstileToken(page)).toBe(true);
	});

	it('is false when there is no token', async () => {
		const { page } = makePage([], 0);
		expect(await hasTurnstileToken(page)).toBe(false);
	});
});
