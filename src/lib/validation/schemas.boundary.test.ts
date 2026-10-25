import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard: `src/lib/validation/schemas.ts` is imported by client-safe modules
 * (`src/lib/api/*`, stores, components). A value import of anything under
 * `#lib/server` would ship server code (e.g. the 65KB generated ISO 639
 * table) to the browser — it only stayed out of the bundle so far because
 * tree-shaking happened to drop the unused exports. Type-only imports are
 * erased at compile time and are always allowed.
 */
describe('validation schemas client/server boundary', () => {
	it('schemas.ts contains no value-level imports from #lib/server', () => {
		const source = readFileSync(join(process.cwd(), 'src/lib/validation/schemas.ts'), 'utf8');
		const valueImports =
			source.match(/^import\s+(?!type\b)[^;]*['"]#lib\/server\/[^'"]*['"]/gm) ?? [];
		expect(valueImports, `value imports found: ${valueImports.join(', ')}`).toEqual([]);
	});
});
