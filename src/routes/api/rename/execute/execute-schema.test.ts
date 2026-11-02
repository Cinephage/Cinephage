import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callHandler } from '../../../../test/api-helper';

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

vi.mock('#lib/server/auth/authorization.js', () => ({
	requireAdmin: vi.fn().mockReturnValue(null)
}));

const mockExecuteRenames = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/library/naming/RenamePreviewService.js', () => ({
	RenamePreviewService: class {
		executeRenames = mockExecuteRenames;
	}
}));

const scanState = vi.hoisted(() => ({ scanning: false }));

vi.mock('#lib/server/library/disk-scan.js', () => ({
	diskScanService: scanState
}));

const { renameExecuteSchema } = await import('#lib/server/library/naming/rename-execute-schema.js');
const { POST } = await import('./+server');

describe('renameExecuteSchema', () => {
	it('rejects batches larger than 500 file ids', () => {
		const tooMany = Array.from({ length: 501 }, (_, i) => `file-${i}`);
		expect(renameExecuteSchema.safeParse({ fileIds: tooMany }).success).toBe(false);
	});

	it('accepts batches up to 500 file ids', () => {
		const ok = Array.from({ length: 500 }, (_, i) => `file-${i}`);
		expect(renameExecuteSchema.safeParse({ fileIds: ok }).success).toBe(true);
	});
});

describe('POST /api/rename/execute', () => {
	beforeEach(() => {
		scanState.scanning = false;
		mockExecuteRenames.mockReset();
		mockExecuteRenames.mockResolvedValue({ processed: 1, succeeded: 1, failed: 0 });
	});

	it('returns 409 when a library scan is in progress', async () => {
		scanState.scanning = true;
		const { status, data } = await callHandler(POST, 'POST', { fileIds: ['file-1'] });
		expect(status).toBe(409);
		expect((data as { error: string }).error).toMatch(/scan/i);
		expect(mockExecuteRenames).not.toHaveBeenCalled();
	});

	it('returns 409 before body validation when a library scan is in progress', async () => {
		scanState.scanning = true;
		// Invalid body ({ fileIds: [] } fails min(1)) — a 400 would mean the scan
		// guard fires after parseBody, so the response must still be 409.
		const { status, data } = await callHandler(POST, 'POST', { fileIds: [] });
		expect(status).toBe(409);
		expect((data as { error: string }).error).toMatch(/scan/i);
		expect(mockExecuteRenames).not.toHaveBeenCalled();
	});

	it('proceeds when no scan is running', async () => {
		const { status } = await callHandler(POST, 'POST', { fileIds: ['file-1'] });
		expect(status).toBe(200);
		expect(mockExecuteRenames).toHaveBeenCalledTimes(1);
	});
});
