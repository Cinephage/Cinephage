// Load .env into process.env for the dev server. Vite's own loadEnv only copies
// NODE_ENV/BROWSER/BROWSER_ARGS and VITE_-prefixed keys into process.env; everything
// else (e.g. BETTER_AUTH_SECRET) is otherwise invisible to code that reads
// process.env directly, same as server.js needs it explicitly in production.
import 'dotenv/config';

import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import type { Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

/**
 * Vite plugin that triggers eager initialization in dev mode.
 *
 * In dev mode, Vite lazily loads modules on first request. This means hooks.server.ts
 * (which contains service initialization) doesn't run until someone visits the site.
 * This plugin pings /health when the dev server starts, forcing SvelteKit to load
 * hooks.server.ts and start all background services immediately.
 */
function eagerInitPlugin(): Plugin {
	return {
		name: 'eager-init',
		configureServer(server) {
			server.httpServer?.once('listening', () => {
				// Small delay to ensure SvelteKit middleware is fully ready
				setTimeout(async () => {
					try {
						const address = server.httpServer?.address();
						if (address && typeof address === 'object') {
							const url = `http://localhost:${address.port}/health`;
							await fetch(url);
						}
					} catch {
						// Silently ignore - initialization will happen on first real request
					}
				}, 100);
			});
		}
	};
}

export default defineConfig({
	plugins: [
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['cookie', 'globalVariable', 'baseLocale']
		}),
		tailwindcss(),
		sveltekit({
			preprocess: vitePreprocess(),

			// Explicit Node.js adapter for self-hosted deployment
			adapter: adapter(),

			// The CSP below matches the static fallback in
			// src/lib/server/security/headers.ts. SvelteKit renders an inline
			// bootstrap script on every SSR page, so script-src cannot drop
			// 'unsafe-inline' unless hashes/nonces are present; SvelteKit emits
			// those in the per-page CSP header it sets, which hooks.server.ts
			// preserves instead of overwriting.
			//
			// 'auto' (not 'hash'): streamed/deferred load data (e.g. the
			// dashboard's recentlyAdded/missingEpisodes/etc. promises) is pushed
			// via inline <script> tags written AFTER the response headers are
			// already flushed, so their content can't be hashed in time, in
			// hash mode SvelteKit doesn't nonce them either, so the browser
			// silently blocks them and the page's loading state never resolves.
			// 'auto' uses a per-request nonce for any non-prerendered page
			// (falling back to hashes only for fully prerendered pages), and
			// that nonce is attached to every inline script SvelteKit emits,
			// streamed ones included.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'https:', 'http:'],
					'connect-src': ['self'],
					'font-src': ['self'],
					'media-src': ['self', 'blob:', 'https:', 'http:'],
					'object-src': ['none'],
					'child-src': ['self', 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
					'frame-src': ['self', 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
					'frame-ancestors': ['self']
				}
			},
			// SvelteKit's csrf.trustedOrigins uses Array.includes() — exact string match only,
			// wildcards like 'http://10.*:*' are never expanded and have no effect.
			// We disable the built-in check via '*' and implement proper origin validation in
			// hooks.server.ts using isLocalNetworkOrigin + BETTER_AUTH_TRUSTED_ORIGINS.
			csrf: { trustedOrigins: ['*'] }
		}),
		eagerInitPlugin()
	],
	css: {
		transformer: 'postcss'
	},
	build: {
		cssMinify: 'lightningcss'
	},
	ssr: {
		// Externalize native modules that don't work with Vite's SSR bundling
		external: ['better-sqlite3']
	},
	test: {
		expect: { requireAssertions: true },
		setupFiles: ['src/test/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'text-summary', 'lcov'],
			include: ['src/lib/**/*.ts'],
			exclude: [
				'src/lib/**/*.test.ts',
				'src/lib/**/*.spec.ts',
				'src/lib/**/types.ts',
				'src/lib/paraglide/**'
			],
			thresholds: {
				statements: 23,
				branches: 16,
				functions: 23,
				lines: 23
			}
		},
		projects: [
			{
				extends: true,
				test: {
					name: 'node',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: [
						'src/lib/components/**/*.test.ts',
						'src/**/*.svelte.{test,spec}.{js,ts}',
						// Provider-dependent suites stay out of the normal run; `npm run
						// test:live` sets LIVE_TESTS=true to include them (see AGENTS.md).
						...(process.env.LIVE_TESTS === 'true' ? [] : ['src/**/*.live.test.ts'])
					],
					fileParallelism: true,
					// First test in each file bears the full module + DB cold-start cost;
					// under concurrent load this can exceed the 5s default.
					testTimeout: 15000
				}
			},
			{
				extends: true,
				resolve: {
					// Component tests run against the client-side Svelte bundle; without the
					// browser condition, `svelte` resolves to the server entry and `mount()`
					// is unavailable.
					conditions: ['browser']
				},
				test: {
					name: 'component',
					environment: 'jsdom',
					include: ['src/lib/components/**/*.test.ts'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					fileParallelism: true
				}
			}
		]
	}
});
