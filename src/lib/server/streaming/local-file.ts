/**
 * Range-aware serving for one local media file.
 *
 * The movie, episode and music routes all need the same rules — 200 for a full
 * read, 206 for a range, 416 for an unsatisfiable one — so the logic lives here
 * and each route only resolves its own file.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { parseRangeHeader } from './usenet/types.js';

export interface LocalFileDescriptor {
	absolutePath: string;
	size: number;
	contentType: string;
}

export function serveLocalFile(request: Request, file: LocalFileDescriptor): Response {
	const rangeHeader = request.headers.get('range');
	const range = parseRangeHeader(rangeHeader, file.size);

	const headers: Record<string, string> = {
		'Content-Type': file.contentType,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive'
	};

	if (rangeHeader && !range) {
		headers['Content-Range'] = `bytes */${file.size}`;
		return new Response('Range Not Satisfiable', { status: 416, headers });
	}

	if (range) {
		const startByte = range.start;
		const endByte = range.end === -1 ? file.size - 1 : range.end;
		const contentLength = endByte - startByte + 1;

		headers['Content-Range'] = `bytes ${startByte}-${endByte}/${file.size}`;
		headers['Content-Length'] = String(contentLength);

		const nodeStream = createReadStream(file.absolutePath, { start: startByte, end: endByte });
		return new Response(Readable.toWeb(nodeStream) as ReadableStream, { status: 206, headers });
	}

	headers['Content-Length'] = String(file.size);
	const nodeStream = createReadStream(file.absolutePath);
	return new Response(Readable.toWeb(nodeStream) as ReadableStream, { status: 200, headers });
}
