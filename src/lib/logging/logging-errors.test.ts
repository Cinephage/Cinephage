import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testing } from './index.js';

const { getBasePinoOptions, prepareLogEvent } = __testing;

/**
 * Regression coverage: `logger.error({ err }, msg)` sanitizes `err` into a
 * plain object before pino sees it, and the pino `err` serializer then rebuilt
 * that object with `new Error(message)`. The class, `code` and stack of the
 * real error were replaced by a stack pointing at the logger itself, so an
 * uncaught exception logged by the crash guard could not be traced.
 */
describe('error serialization', () => {
	let previousIncludeStack: string | undefined;

	beforeEach(() => {
		previousIncludeStack = process.env.LOG_INCLUDE_STACK;
		process.env.LOG_INCLUDE_STACK = 'true';
	});

	afterEach(() => {
		if (previousIncludeStack === undefined) delete process.env.LOG_INCLUDE_STACK;
		else process.env.LOG_INCLUDE_STACK = previousIncludeStack;
	});

	function logError(args: unknown[]): Record<string, unknown> {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				lines.push(chunk.toString());
				callback();
			}
		});
		const log = pino(getBasePinoOptions(), stream);
		const prepared = prepareLogEvent('error', args);
		log.error(prepared.payload, prepared.message);
		return JSON.parse(lines[0]).err;
	}

	class InformationalError extends Error {
		code = 'UND_ERR_INFO';
		constructor(message: string) {
			super(message);
			this.name = 'InformationalError';
		}
	}

	function thrownHere(): InformationalError {
		return new InformationalError('socket idle timeout');
	}

	// Redaction flattens newlines, so compare frames rather than the whole string.
	function expectOriginalStack(stack: unknown): void {
		expect(stack).toMatch(/^InformationalError: socket idle timeout\s+at thrownHere /);
		expect(stack).not.toContain('toError');
	}

	it('keeps the class, code and original stack of an `err` field', () => {
		const err = logError([{ err: thrownHere(), origin: 'uncaughtException' }, 'fatal']);

		expect(err.type).toBe('InformationalError');
		expect(err.code).toBe('UND_ERR_INFO');
		expect(err.message).toBe('socket idle timeout');
		expectOriginalStack(err.stack);
	});

	it('keeps the details of an `error` field', () => {
		const err = logError([{ error: thrownHere() }, 'failed']);

		expect(err.type).toBe('InformationalError');
		expect(err.code).toBe('UND_ERR_INFO');
		expectOriginalStack(err.stack);
	});

	it('keeps the details of an error passed as the second argument', () => {
		const err = logError(['failed', thrownHere()]);

		expect(err.type).toBe('InformationalError');
		expect(err.code).toBe('UND_ERR_INFO');
		expectOriginalStack(err.stack);
	});

	it('keeps the fields of a thrown plain object', () => {
		const err = logError([
			{ err: { name: 'InformationalError', code: 'UND_ERR_INFO', message: 'socket idle timeout' } },
			'fatal'
		]);

		expect(err.type).toBe('InformationalError');
		expect(err.code).toBe('UND_ERR_INFO');
		expect(err.message).toBe('socket idle timeout');
	});

	it('drops the stack when LOG_INCLUDE_STACK is false', () => {
		process.env.LOG_INCLUDE_STACK = 'false';
		const err = logError([{ err: thrownHere() }, 'fatal']);

		expect(err.stack).toBeUndefined();
		expect(err.code).toBe('UND_ERR_INFO');
	});

	it('still redacts secrets inside error messages', () => {
		const err = logError([{ err: new Error('GET /api?api_key=secret123 failed') }, 'fatal']);

		expect(err.message).toBe('GET /api?api_key=[REDACTED] failed');
	});
});
