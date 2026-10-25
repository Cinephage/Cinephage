import prettier from 'eslint-config-prettier';
import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import { loadConfig } from '@sveltejs/load-config';

const svelteConfig = (await loadConfig('./', { traverse: false }))?.config;
import noEmoji from './eslint-rules/no-emoji.js';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));

// Local plugin housing project-specific rules (e.g. no-emoji).
const local = {
	meta: { name: 'cinephage-local' },
	rules: { 'no-emoji': noEmoji }
};

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{
		ignores: [
			// Browser extension asset shipped as-is (loaded by Camoufox, not app code)
			'src/lib/server/captcha/browser/addon/**',
			// Build artifacts
			'.svelte-kit/**',
			// Generated language data
			'src/lib/server/languages/iso-data.generated.ts'
		]
	},
	{
		// Disable the built-in unused-disable reporting globally — it's too coarse
		// (can't suppress per-file). We re-enable specific checks for source files below.
		linterOptions: {
			reportUnusedDisableDirectives: 0
		}
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		// Project-specific rules
		plugins: { local },
		rules: {
			// Disallow pictographic emoji in code/comments (see eslint-rules/no-emoji.js).
			// Svelte template markup is naturally exempt — only JS/TS nodes are checked.
			'local/no-emoji': 'error'
		}
	},
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			// Allow underscore-prefixed unused variables (common for interface implementations)
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			]
		}
	},
	{
		files: ['src/**/*.{ts,js}'],
		ignores: [
			'src/**/*.test.ts',
			'src/**/*.spec.ts',
			'src/**/__tests__/**',
			'src/**/*.svelte.ts',
			'src/**/*.svelte.js'
		],
		rules: {
			'no-console': 'error'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		},
		rules: {
			'no-console': 'error'
		}
	},
	{
		// Allow 'any' in test files for partial mocks
		files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	},
	{
		// Enforce use of shared test fixtures instead of local factories
		files: ['src/**/*.test.ts'],
		ignores: ['src/test/**', 'src/lib/server/db/schema-sync.test.ts'],
		rules: {
			// Discourage local makeCtx / makeGrabContext / makeEligibilityContext
			// Point to src/test/fixtures/filters.ts instead
			'no-restricted-syntax': [
				'warn',
				{
					selector:
						'FunctionDeclaration[id.name=/^make(Ctx|GrabContext|EligibilityContext|GrabDecisionContext|SearchEligibilityContext)$/]',
					message:
						'Use makeGrabDecisionContext() or makeSearchEligibilityContext() from src/test/fixtures/filters.js instead of defining a local makeCtx.'
				},
				{
					selector:
						'FunctionDeclaration[id.name=/^create(TestMovie|TestSeries|TestEpisode|TestEpisodeFile|TestMovieFile|TestRelease|TestProfile|MockIndexer|MockIndexerManager)$/]',
					message:
						'Use shared fixture factories from src/test/fixtures/ instead of defining local create* functions.'
				}
			]
		}
	},
	{
		// Svelte-specific rule overrides
		files: ['**/*.svelte'],
		rules: {
			// resolvePath internally calls resolve(), so navigation is correctly handled
			'svelte/no-navigation-without-resolve': 'off',
			// $state + $effect pattern is valid for URL sync and form state
			'svelte/prefer-writable-derived': 'off',
			'svelte/valid-prop-names-in-kit-pages': 'off'
		}
	}
);
