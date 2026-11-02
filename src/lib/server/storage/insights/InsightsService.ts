import type { EventEmitter } from 'node:events';
import type { ServiceStatus, BackgroundService } from '#lib/server/services/background-service.js';
import { createChildLogger } from '#lib/logging/index.js';
import { upsertInsights } from './upsert.js';
import { storageEvents } from '../StorageEvents.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from './types.js';
import { ALL_RULES } from './rules/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

class InsightsService implements BackgroundService {
	readonly name = 'InsightsService';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private insightsLock = false;
	private listenersAttached = false;
	private attachPromise: Promise<void> | null = null;
	// Captured on attach and reused on detach instead of re-importing: see the
	// equivalent comment in ReconciliationService.detachListeners for why.
	private attachedReconciliation: EventEmitter | null = null;
	private readonly rules: StorageInsightRule[];

	constructor() {
		this.rules = ALL_RULES;
	}

	get status() {
		return this._status;
	}
	get error() {
		return this._error;
	}

	start(): void {
		if (this._status !== 'pending') return;
		this._status = 'starting';
		setImmediate(() => {
			try {
				this.attachListeners();
				this._status = 'ready';
				logger.info(
					`[InsightsService] ready with ${this.rules.length} rules; will run after each reconcile`
				);
			} catch (e) {
				this._error = e instanceof Error ? e : new Error(String(e));
				this._status = 'error';
				logger.error('[InsightsService] startup failed', this._error);
			}
		});
	}

	async stop(): Promise<void> {
		if (this.attachPromise) {
			await this.attachPromise;
			this.attachPromise = null;
		}
		this.detachListeners();
		this._status = 'pending';
	}

	private attachListeners(): void {
		if (this.listenersAttached) return;
		this.listenersAttached = true;
		this.attachPromise = import('#lib/server/storage/reconciliation/ReconciliationService.js')
			.then(({ getReconciliationService }) => {
				const reconciliation = getReconciliationService();
				reconciliation.on('reconcileComplete', this.handleTrigger);
				this.attachedReconciliation = reconciliation;
			})
			.catch((e) => {
				logger.error('[InsightsService] failed to subscribe to reconcileComplete', e);
			});
	}

	private detachListeners(): void {
		if (!this.listenersAttached) return;
		this.listenersAttached = false;
		this.attachedReconciliation?.off('reconcileComplete', this.handleTrigger);
		this.attachedReconciliation = null;
	}

	private handleTrigger = (): void => {
		this.runAllRules().catch((err) => {
			logger.error('[InsightsService] runAllRules failed after trigger', err);
		});
	};

	/**
	 * Run all registered rules and upsert findings.
	 * Lock-protected; concurrent triggers coalesce.
	 */
	async runAllRules(): Promise<{ findingsCount: number; skipped: boolean }> {
		if (this.insightsLock) {
			logger.debug('[InsightsService] already running; skipping');
			return { findingsCount: 0, skipped: true };
		}
		this.insightsLock = true;
		try {
			const now = new Date().toISOString();
			const ctx: RuleContext = {
				db: await import('#lib/server/db/index.js').then((m) => m.db),
				now
			};

			const allFindings: InsightFinding[] = [];
			for (const rule of this.rules) {
				try {
					const findings = await rule.evaluate(ctx);
					allFindings.push(...findings);
				} catch (ruleError) {
					logger.warn(`[InsightsService] rule ${rule.type} threw`, {
						error: ruleError instanceof Error ? ruleError : new Error(String(ruleError))
					});
				}
			}

			upsertInsights(allFindings, now);

			storageEvents.emitInsightsUpdated({
				triggeredBy: 'reconciliation',
				timestamp: now
			});

			logger.info(
				`[InsightsService] ran ${this.rules.length} rules -> ${allFindings.length} findings`
			);
			return { findingsCount: allFindings.length, skipped: false };
		} catch (e) {
			this._error = e instanceof Error ? e : new Error(String(e));
			logger.error('[InsightsService] runAllRules threw', this._error);
			throw e;
		} finally {
			this.insightsLock = false;
		}
	}
}

let instance: InsightsService | null = null;

export function getInsightsService(): InsightsService {
	if (!instance) instance = new InsightsService();
	return instance;
}

export function __resetInsightsServiceForTests(): void {
	instance = null;
}
