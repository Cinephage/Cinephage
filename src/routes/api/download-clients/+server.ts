import type { RequestHandler } from './$types';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import {
	downloadClientCreateSchema,
	type DownloadClientCreateDiscriminated
} from '#lib/validation/schemas.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import type { DownloadClientInput } from '#lib/types/downloadClient.js';

/**
 * GET /api/download-clients
 * List all configured download clients.
 * Note: Passwords are redacted for security.
 */
export const GET: RequestHandler = async () => {
	const manager = getDownloadClientManager();
	const clients = await manager.getClients();

	// Password is already excluded from DownloadClient type (only hasPassword boolean is included)
	return Response.json(clients);
};

/**
 * POST /api/download-clients
 * Create a new download client.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	const validated = (await parseBody(
		request,
		downloadClientCreateSchema
	)) as DownloadClientCreateDiscriminated;

	const manager = getDownloadClientManager();

	const commonInput: DownloadClientInput = {
		name: validated.name,
		implementation: validated.implementation,
		enabled: validated.enabled,
		priority: validated.priority,
		apiToken: validated.apiToken,
		removeAfterImport: validated.removeAfterImport,
		allowMovies: validated.allowMovies,
		allowTv: validated.allowTv
	};

	let input: DownloadClientInput;
	if ('host' in validated) {
		input = {
			...commonInput,
			host: validated.host,
			port: validated.port,
			useSsl: validated.useSsl,
			urlBase: validated.urlBase,
			mountMode: validated.mountMode,
			username: validated.username,
			password: validated.password,
			movieCategory: validated.movieCategory,
			tvCategory: validated.tvCategory,
			recentPriority: validated.recentPriority,
			olderPriority: validated.olderPriority,
			initialState: validated.initialState,
			seedRatioLimit: validated.seedRatioLimit,
			seedTimeLimit: validated.seedTimeLimit,
			sequentialDownload: validated.sequentialDownload,
			downloadPathLocal: validated.downloadPathLocal,
			downloadPathRemote: validated.downloadPathRemote,
			tempPathLocal: validated.tempPathLocal,
			tempPathRemote: validated.tempPathRemote
		};
	} else {
		input = commonInput;
	}

	const created = await manager.createClient(input);

	return Response.json({ success: true, client: created });
};
