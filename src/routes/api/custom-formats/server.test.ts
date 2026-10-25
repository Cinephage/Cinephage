import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import {
	api,
	type ErrorResponse,
	type DeleteResponse,
	type FormatResponse,
	type FormatsListResponse
} from '../../../test/api-helper';
import { customFormats } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

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

const { GET, POST, PUT, DELETE } = await import('./+server');

const validCondition = {
	name: 'Test Condition',
	type: 'release_title' as const,
	required: true,
	negate: false,
	pattern: 'TEST'
};

describe('Custom Formats API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
	});

	describe('GET /api/custom-formats', () => {
		it('returns built-in formats when database is empty', async () => {
			const { status, data } = await api.get<FormatsListResponse>(GET);

			expect(status).toBe(200);
			expect(data.formats.length).toBeGreaterThan(0);
			expect(data.builtInCount).toBeGreaterThan(0);
			expect(data.customCount).toBe(0);

			data.formats.forEach((f) => {
				expect(f.isBuiltIn).toBe(true);
			});
		});

		it('returns custom formats along with built-in formats', async () => {
			await testDb.db.insert(customFormats).values({
				id: 'my-custom-format',
				name: 'My Custom Format',
				description: 'Test format',
				category: 'other',
				tags: ['test'],
				conditions: [validCondition],
				enabled: true
			});

			const { data } = await api.get<FormatsListResponse>(GET);

			expect(data.customCount).toBe(1);
			const customFormat = data.formats.find((f) => f.id === 'my-custom-format');
			expect(customFormat).toBeDefined();
			expect(customFormat?.name).toBe('My Custom Format');
			expect(customFormat?.isBuiltIn).toBe(false);
		});

		it('filters by type=builtin', async () => {
			await testDb.db.insert(customFormats).values({
				id: 'test-custom',
				name: 'Test Custom',
				category: 'other',
				conditions: [validCondition]
			});

			const { data } = await api.get<FormatsListResponse>(GET, {
				url: 'http://localhost/api/custom-formats?type=builtin'
			});

			data.formats.forEach((f) => {
				expect(f.isBuiltIn).toBe(true);
			});
		});

		it('filters by type=custom', async () => {
			await testDb.db.insert(customFormats).values({
				id: 'test-custom',
				name: 'Test Custom',
				category: 'other',
				conditions: [validCondition]
			});

			const { data } = await api.get<FormatsListResponse>(GET, {
				url: 'http://localhost/api/custom-formats?type=custom'
			});

			expect(data.formats.length).toBe(1);
			data.formats.forEach((f) => {
				expect(f.isBuiltIn).toBe(false);
			});
		});

		it('filters by category', async () => {
			const { data } = await api.get<FormatsListResponse>(GET, {
				url: 'http://localhost/api/custom-formats?category=audio'
			});

			data.formats.forEach((f) => {
				expect(f.category).toBe('audio');
			});
		});

		it('searches by name', async () => {
			const { data } = await api.get<FormatsListResponse>(GET, {
				url: 'http://localhost/api/custom-formats?search=truehd'
			});

			expect(data.formats.length).toBeGreaterThan(0);
			data.formats.forEach((f) => {
				const matches =
					f.name.toLowerCase().includes('truehd') ||
					f.description?.toLowerCase().includes('truehd') ||
					f.tags?.some((t) => t.toLowerCase().includes('truehd'));
				expect(matches).toBe(true);
			});
		});
	});

	describe('POST /api/custom-formats', () => {
		it('creates format with required fields only', async () => {
			const { status, data } = await api.post<FormatResponse>(POST, {
				name: 'Test Format',
				category: 'other',
				conditions: [validCondition]
			});

			expect(status).toBe(201);
			expect(data.name).toBe('Test Format');
			expect(data.id).toBeDefined();
			expect(data.category).toBe('other');
			expect(data.enabled).toBe(true);
		});

		it('creates format with custom ID', async () => {
			const { status, data } = await api.post<FormatResponse>(POST, {
				id: 'custom-id-format',
				name: 'Custom ID Format',
				category: 'other',
				conditions: [validCondition]
			});

			expect(status).toBe(201);
			expect(data.id).toBe('custom-id-format');
		});

		it('creates format with all optional fields', async () => {
			const { status, data } = await api.post<FormatResponse>(POST, {
				id: 'full-format',
				name: 'Full Format',
				description: 'A complete format',
				category: 'release_group_tier',
				tags: ['tier1', 'hdr'],
				conditions: [
					validCondition,
					{
						name: 'HDR Check',
						type: 'hdr',
						required: false,
						negate: false,
						hdr: 'HDR10'
					}
				],
				enabled: false
			});

			expect(status).toBe(201);
			expect(data.description).toBe('A complete format');
			expect(data.tags).toEqual(['tier1', 'hdr']);
			expect(data.conditions!.length).toBe(2);
			expect(data.enabled).toBe(false);
		});

		it('validates condition types', async () => {
			const { status, data } = await api.post<FormatResponse>(POST, {
				name: 'Audio Codec Format',
				category: 'audio',
				conditions: [
					{
						name: 'Codec Check',
						type: 'audio_codec',
						required: true,
						negate: false,
						audioCodec: 'truehd'
					}
				]
			});

			expect(status).toBe(201);
			expect(data.name).toBe('Audio Codec Format');
		});

		it('rejects reserved format IDs', async () => {
			const { status, data } = await api.post<ErrorResponse>(POST, {
				id: 'audio-truehd',
				name: 'Fake TrueHD',
				category: 'audio',
				conditions: [validCondition]
			});

			expect(status).toBe(400);
			expect(data.error).toContain('reserved');
		});

		it('rejects duplicate format IDs', async () => {
			await api.post<FormatResponse>(POST, {
				id: 'duplicate-test',
				name: 'First',
				category: 'other',
				conditions: [validCondition]
			});

			const { status, data } = await api.post<ErrorResponse>(POST, {
				id: 'duplicate-test',
				name: 'Second',
				category: 'other',
				conditions: [validCondition]
			});

			expect(status).toBe(409);
			expect(data.error).toContain('already exists');
		});

		it('requires at least one condition', async () => {
			const { status, data } = await api.post<ErrorResponse>(POST, {
				name: 'No Conditions',
				category: 'other',
				conditions: []
			});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});

		it('validates required name field', async () => {
			const { status, data } = await api.post<ErrorResponse>(POST, {
				category: 'other',
				conditions: [validCondition]
			});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});

		it('validates category enum', async () => {
			const { status, data } = await api.post<ErrorResponse>(POST, {
				name: 'Bad Category',
				category: 'invalid_category',
				conditions: [validCondition]
			});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});
	});

	describe('PUT /api/custom-formats', () => {
		it('updates custom format fields', async () => {
			await api.post<FormatResponse>(POST, {
				id: 'update-test',
				name: 'Original Name',
				category: 'other',
				conditions: [validCondition]
			});

			const { status, data } = await api.put<FormatResponse>(PUT, {
				id: 'update-test',
				name: 'Updated Name',
				description: 'New description',
				category: 'other',
				conditions: [validCondition]
			});

			expect(status).toBe(200);
			expect(data.name).toBe('Updated Name');
			expect(data.description).toBe('New description');
		});

		it('updates conditions', async () => {
			await api.post<FormatResponse>(POST, {
				id: 'conditions-test',
				name: 'Conditions Test',
				category: 'other',
				conditions: [validCondition]
			});

			const newCondition = {
				name: 'New Condition',
				type: 'release_group' as const,
				required: true,
				negate: false,
				pattern: '^SPARKS$'
			};

			const { status, data } = await api.put<FormatResponse>(PUT, {
				id: 'conditions-test',
				name: 'Conditions Test',
				category: 'other',
				conditions: [newCondition]
			});

			expect(status).toBe(200);
			expect(data.conditions!.length).toBe(1);
		});

		it('rejects updates to built-in formats', async () => {
			const { status, data } = await api.put<ErrorResponse>(PUT, {
				id: 'audio-truehd',
				name: 'Modified TrueHD',
				category: 'audio',
				conditions: [validCondition]
			});

			expect(status).toBe(400);
			expect(data.error).toContain('built-in');
		});

		it('returns 404 for non-existent format', async () => {
			const { status, data } = await api.put<ErrorResponse>(PUT, {
				id: 'does-not-exist',
				name: 'New Name',
				category: 'other',
				conditions: [validCondition]
			});

			expect(status).toBe(404);
			expect(data.error).toContain('not found');
		});

		it('requires format ID', async () => {
			const { status, data } = await api.put<ErrorResponse>(PUT, {
				name: 'No ID',
				category: 'other',
				conditions: [validCondition]
			});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});
	});

	describe('DELETE /api/custom-formats', () => {
		it('deletes custom format', async () => {
			await api.post<FormatResponse>(POST, {
				id: 'delete-me',
				name: 'Delete Me',
				category: 'other',
				conditions: [validCondition]
			});

			const { status, data } = await api.delete<DeleteResponse>(DELETE, { id: 'delete-me' });

			expect(status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.deleted.id).toBe('delete-me');

			const remaining = await testDb.db
				.select()
				.from(customFormats)
				.where(eq(customFormats.id, 'delete-me'));
			expect(remaining.length).toBe(0);
		});

		it('rejects deletion of built-in format', async () => {
			const { status, data } = await api.delete<ErrorResponse>(DELETE, { id: 'audio-truehd' });

			expect(status).toBe(400);
			expect(data.error).toContain('built-in');
		});

		it('returns 404 for non-existent format', async () => {
			const { status, data } = await api.delete<ErrorResponse>(DELETE, { id: 'ghost' });

			expect(status).toBe(404);
			expect(data.error).toContain('not found');
		});

		it('requires format ID', async () => {
			const { status, data } = await api.delete<ErrorResponse>(DELETE, {});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});
	});
});
