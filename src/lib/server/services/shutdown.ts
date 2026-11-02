import { createChildLogger } from '#lib/logging/index.js';
import { getImportService } from '#lib/server/downloadClients/import/ImportService.js';
import { getServiceManager } from '#lib/server/services/service-manager.js';
import { sqlite } from '#lib/server/db/index.js';

const logger = createChildLogger({ module: 'Shutdown', logDomain: 'system' });

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
	if (isShuttingDown) {
		logger.info('Shutdown already in progress, waiting...');
		return;
	}

	isShuttingDown = true;
	logger.info(`Received ${signal}, starting graceful shutdown...`);

	const timeout = setTimeout(() => {
		logger.error('Graceful shutdown timed out after 30s, forcing exit');
		closeDb();
		process.exit(0);
	}, 30000);

	try {
		getImportService().stop();
		await getServiceManager().stopAll();
		clearTimeout(timeout);
		logger.info('All services stopped successfully');
	} catch (error) {
		clearTimeout(timeout);
		logger.error('Error stopping services during shutdown', error);
	}

	closeDb();
	process.exit(0);
}

function closeDb(): void {
	try {
		sqlite.pragma('wal_checkpoint(TRUNCATE)');
		sqlite.close();
	} catch (err) {
		logger.error({ err }, 'Error closing database during shutdown');
	}
}

// Guard registration with a globalThis flag, not a module-scoped variable:
// this module is imported purely for its side effect (hooks.server.ts imports
// it just to register these handlers), and under Vite's dev SSR every HMR
// reload re-evaluates it from scratch. process.on would then stack a brand
// new listener onto the real, HMR-independent process object every time,
// each with its own isShuttingDown closure, so the in-progress guard above
// does nothing to stop them piling up. Enough edits during a session and a
// single SIGTERM/SIGINT fires all of them at once: dozens of concurrent
// stopAll()/closeDb() passes stepping on each other, which is exactly what
// hung the dev server instead of exiting it. globalThis survives module
// reloads (it doesn't survive a real process restart, which is fine, since a
// fresh process has never registered these listeners either).
const registrationFlag = globalThis as typeof globalThis & {
	__cinephageShutdownHandlersRegistered?: boolean;
};
if (!registrationFlag.__cinephageShutdownHandlersRegistered) {
	registrationFlag.__cinephageShutdownHandlersRegistered = true;
	process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
	process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
