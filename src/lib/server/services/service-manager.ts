/**
 * Service Manager
 *
 * Coordinates background services, providing centralized
 * registration, startup, shutdown, and status reporting.
 */

import type { BackgroundService, ServiceStatusInfo } from './background-service.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'ServiceManager', logDomain: 'system' });

class ServiceManager {
	private services: Map<string, BackgroundService> = new Map();
	private started = false;

	/**
	 * Register a background service
	 */
	register(service: BackgroundService): void {
		if (this.services.has(service.name)) {
			logger.warn(`Service '${service.name}' is already registered, replacing`);
		}
		this.services.set(service.name, service);
		logger.debug(`Registered service: ${service.name}`);

		// If manager already started, start this service too
		if (this.started) {
			service.start();
		}
	}

	/**
	 * Start all registered services (non-blocking)
	 *
	 * This returns immediately. Services initialize in background.
	 */
	startAll(): void {
		if (this.started) {
			logger.warn('Service manager already started');
			return;
		}

		this.started = true;
		logger.info(`Starting ${this.services.size} background service(s)`);

		for (const service of this.services.values()) {
			try {
				service.start();
				logger.debug(`Started service: ${service.name}`);
			} catch (error) {
				logger.error(
					{ err: error, serviceName: service.name },
					`Failed to start service: ${service.name}`
				);
			}
		}
	}

	/**
	 * Stop all services gracefully
	 */
	async stopAll(): Promise<void> {
		logger.info(`Stopping ${this.services.size} background service(s)`);

		const stopPromises = Array.from(this.services.values()).map(async (service) => {
			try {
				await service.stop();
				logger.debug(`Stopped service: ${service.name}`);
			} catch (error) {
				logger.error(
					{ err: error, serviceName: service.name },
					`Error stopping service: ${service.name}`
				);
			}
		});

		await Promise.all(stopPromises);
		this.started = false;
	}

	/**
	 * Get status of all services
	 */
	getStatus(): ServiceStatusInfo[] {
		return Array.from(this.services.values()).map((service) => ({
			name: service.name,
			status: service.status,
			error: service.error?.message
		}));
	}

	/**
	 * Check if all services are ready
	 */
	allReady(): boolean {
		for (const service of this.services.values()) {
			if (service.status !== 'ready') {
				return false;
			}
		}
		return this.services.size > 0;
	}

	/**
	 * Get a specific service by name
	 */
	getService<T extends BackgroundService>(name: string): T | undefined {
		return this.services.get(name) as T | undefined;
	}

	/**
	 * Check if manager has been started
	 */
	isStarted(): boolean {
		return this.started;
	}
}

// Singleton management
let serviceManagerInstance: ServiceManager | null = null;

// Singleton getter - preferred way to access the service
export function getServiceManager(): ServiceManager {
	if (!serviceManagerInstance) {
		serviceManagerInstance = new ServiceManager();
	}
	return serviceManagerInstance;
}

// Reset singleton (for testing)
export async function resetServiceManager(): Promise<void> {
	if (serviceManagerInstance) {
		await serviceManagerInstance.stopAll();
		serviceManagerInstance = null;
	}
}

// Backward-compatible export (prefer getServiceManager())
export const serviceManager = getServiceManager();
