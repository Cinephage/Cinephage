import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';

export interface MockIndexer {
	id: string;
	name: string;
	definitionId: string;
	protocol: string;
	accessType: string;
	baseUrl: string;
	enableAutomaticSearch: boolean;
	enableInteractiveSearch: boolean;
	priority: number;
	capabilities: Record<string, unknown>;
	additionalCategories: number[];
	search: (...args: unknown[]) => unknown;
	grab: ReturnType<typeof vi.fn>;
	test: ReturnType<typeof vi.fn>;
	canSearch: ReturnType<typeof vi.fn>;
}

export function createMockIndexer(overrides?: Partial<MockIndexer>): MockIndexer {
	return {
		id: randomUUID(),
		name: 'Test Indexer',
		definitionId: 'test-definition',
		protocol: 'torrent',
		accessType: 'public',
		baseUrl: 'https://example.test',
		enableAutomaticSearch: true,
		enableInteractiveSearch: true,
		priority: 25,
		capabilities: {},
		additionalCategories: [],
		search: async () => [],
		grab: vi.fn().mockResolvedValue({ success: true }),
		test: vi.fn().mockResolvedValue(undefined),
		canSearch: vi.fn().mockReturnValue(true),
		...overrides
	};
}

export interface MockIndexerManagerFixture {
	searchEnhanced: ReturnType<typeof vi.fn>;
	getIndexers: ReturnType<typeof vi.fn>;
	getDefinitionCapabilities: ReturnType<typeof vi.fn>;
}

export function createMockIndexerManager(
	overrides?: Partial<MockIndexerManagerFixture>
): MockIndexerManagerFixture {
	return {
		searchEnhanced: vi.fn().mockResolvedValue({ releases: [], rejectedCount: 0 }),
		getIndexers: vi.fn().mockResolvedValue([]),
		getDefinitionCapabilities: vi.fn().mockReturnValue(undefined),
		...overrides
	};
}
