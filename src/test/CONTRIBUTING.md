# Writing Tests in Cinephage

## Quick Start

All tests are colocated with source files, named `*.test.ts`. No `__tests__/` directories.

### Pure logic tests (no DB, no mocks)

```ts
import { describe, expect, it } from 'vitest';
import { myFunction } from './myModule.js';

describe('myFunction', () => {
	it('does the thing', () => {
		expect(myFunction(1, 2)).toBe(3);
	});
});
```

### Database tests

```ts
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../test/db-helper.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

describe('my service', () => {
	beforeEach(() => clearTestDb(testDb));
	afterAll(() => destroyTestDb(testDb));

	it('works with the database', async () => {
		// seed data, call service, assert
	});
});
```

**Note:** Vitest hoists `vi.mock` calls to the top of the file before imports resolve. Mock factories can only reference variables declared with `vi.hoisted()`. The DB mock must be inlined — imported helper functions cannot be called inside `vi.mock` factories.

### Tests with logging mocks

```ts
import { vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));
```

## Fixture Factories

All fixtures live in `src/test/fixtures/`. They follow the `Partial<T> = {}` pattern:

```ts
import { createMovie } from '../../test/fixtures/media.js';

const movie = createMovie({ title: 'The Matrix', year: 1999 });
```

### Available factories

| File                   | Factories                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fixtures/media.ts`    | `createMovie`, `createSeries`, `createEpisode`, `createEpisodeFile`, `createMovieFile`, `createMovieTarget`, `createEpisodeTarget`, `createSeasonTarget`, `createSeriesTarget` |
| `fixtures/releases.ts` | `createReleaseAttributes`, `createSearchRelease`, `createGrabResponse`, `createScoringResult`, `createScoringProfile`, `createCustomFormat`                                    |
| `fixtures/indexers.ts` | `createMockIndexer`, `createMockIndexerManager`                                                                                                                                |
| `fixtures/filters.ts`  | `makeGrabDecisionContext`, `makeSearchEligibilityContext`                                                                                                                      |
| `fixtures/auth.ts`     | `createTestUser`, `createTestSession`                                                                                                                                          |

## Patterns

### When to use `vi.hoisted()`

Use `vi.hoisted()` when mock functions need to be accessed in test assertions:

```ts
const mockSearch = vi.hoisted(() => vi.fn());
vi.mock('./SearchService.js', () => ({
  searchService: { search: mockSearch }
}));

// In test:
mockSearch.mockResolvedValue({ results: [...] });
expect(mockSearch).toHaveBeenCalledWith(...);
```

Use direct `vi.mock()` for simple value mocks that don't need assertion access:

```ts
vi.mock('./constants.js', () => ({ MAX_RETRIES: 3 }));
```

### DB isolation

- `clearTestDb(testDb)` clears all common tables (scoringProfiles, customFormats, blockedMedia, downloadClients, movies, movieFiles, series, seasons, episodes, episodeFiles, downloadQueue). Use it in `beforeEach`.
- `destroyTestDb(testDb)` closes the connection. Use it in `afterAll`.
- Never mock `#lib/server/db/index.js` when a real in-memory DB works for your test.

### File naming

- `*.test.ts` — server/logic tests (Node environment)
- `*.svelte.test.ts` — future: browser component tests
- `*.ssr.test.ts` — future: server-side rendering tests
