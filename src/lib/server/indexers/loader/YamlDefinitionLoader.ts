/**
 * YAML Definition Loader
 * Loads and caches YAML indexer definitions from the filesystem.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { type YamlDefinition, safeValidateYamlDefinition } from '../schema/yamlDefinition';
import { createChildLogger } from '#lib/logging/index.js';
import { yamlToUnifiedDefinition, type IndexerDefinition } from './types';

const log = createChildLogger({ module: 'YamlDefinitionLoader' });

/**
 * Default definitions directory path.
 * Can be overridden via INDEXER_DEFINITIONS_PATH environment variable.
 */
const DEFAULT_DEFINITIONS_PATH =
	process.env.INDEXER_DEFINITIONS_PATH ?? 'data/indexers/definitions';
const CUSTOM_DEFINITIONS_PATH = process.env.INDEXER_CUSTOM_DEFINITIONS_PATH;

const DEFAULT_DIRECTORIES = [DEFAULT_DEFINITIONS_PATH, CUSTOM_DEFINITIONS_PATH].filter(
	Boolean
) as string[];

const normalizeDirectories = (input: string[] = DEFAULT_DIRECTORIES): string[] => {
	const unique = new Set<string>();
	for (const dir of input) {
		if (!dir) continue;
		if (!unique.has(dir)) unique.add(dir);
	}
	return [...unique];
};

/**
 * Result of loading a single definition file.
 */
export interface DefinitionLoadResult {
	definition: YamlDefinition;
	filePath: string;
	loadedAt: Date;
}

/**
 * Error information for a failed definition load.
 */
export interface DefinitionLoadError {
	filePath: string;
	error: string;
}

/**
 * Loads and caches YAML indexer definitions from the filesystem.
 */
export class YamlDefinitionLoader {
	private cache: Map<string, DefinitionLoadResult> = new Map();
	private errors: DefinitionLoadError[] = [];
	private directories: string[] = [];

	constructor(definitionsPath?: string | string[]) {
		if (definitionsPath) {
			const dirs = Array.isArray(definitionsPath) ? definitionsPath : [definitionsPath];
			this.directories = normalizeDirectories(dirs);
		} else {
			this.directories = normalizeDirectories();
		}
	}

	/**
	 * Loads all YAML definitions from the configured directories.
	 * Files must have .yaml or .yml extension.
	 */
	async loadAll(directories?: string[]): Promise<DefinitionLoadResult[]> {
		if (directories) {
			this.directories = normalizeDirectories(directories);
		}
		this.cache.clear();
		this.errors = [];

		const results: DefinitionLoadResult[] = [];

		for (const dir of this.directories) {
			const dirResults = await this.loadDirectory(dir);
			results.push(...dirResults);
		}

		log.info(
			{
				count: results.length,
				errors: this.errors.length
			},
			'Loaded definitions'
		);

		return results;
	}

	/**
	 * Loads all definitions from a single directory (recursively).
	 */
	private async loadDirectory(directory: string): Promise<DefinitionLoadResult[]> {
		const results: DefinitionLoadResult[] = [];

		if (!fs.existsSync(directory)) {
			log.warn({ directory }, 'Definitions directory not found');
			return results;
		}

		const entries = fs.readdirSync(directory, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);

			if (entry.isDirectory()) {
				// Recursively load subdirectories
				const subResults = await this.loadDirectory(fullPath);
				results.push(...subResults);
			} else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
				const result = await this.loadOne(fullPath);
				if (result) {
					results.push(result);
				}
			}
		}

		return results;
	}

	/**
	 * Loads a single definition file.
	 */
	async loadOne(filePath: string): Promise<DefinitionLoadResult | null> {
		try {
			const content = fs.readFileSync(filePath, 'utf-8');
			const parsed = yaml.load(content);

			// Normalize Prowlarr field names to Cinephage conventions
			if (parsed && typeof parsed === 'object') {
				const obj = parsed as Record<string, unknown>;
				// requestDelay -> requestdelay (case normalization for Prowlarr compatibility)
				if ('requestDelay' in obj && !('requestdelay' in obj)) {
					obj.requestdelay = obj.requestDelay;
					delete obj.requestDelay;
				}
			}

			const validationResult = safeValidateYamlDefinition(parsed);

			if (!validationResult.success) {
				const errorMessage = validationResult.error.issues
					.map((e) => `${e.path.join('.')}: ${e.message}`)
					.join('; ');

				this.errors.push({
					filePath,
					error: `Validation failed: ${errorMessage}`
				});

				log.warn({ filePath, error: errorMessage }, 'Definition validation failed');
				return null;
			}

			const result: DefinitionLoadResult = {
				definition: validationResult.data,
				filePath,
				loadedAt: new Date()
			};

			this.cache.set(validationResult.data.id, result);
			log.debug({ id: validationResult.data.id, filePath }, 'Loaded definition');
			return result;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.errors.push({
				filePath,
				error: errorMsg
			});
			log.warn({ filePath, error: errorMsg }, 'Failed to load definition');
			return null;
		}
	}

	/**
	 * Reloads a specific definition by ID.
	 */
	async reloadById(id: string): Promise<DefinitionLoadResult | null> {
		const existing = this.cache.get(id);
		if (!existing) {
			return null;
		}

		this.cache.delete(id);
		return this.loadOne(existing.filePath);
	}

	/**
	 * Reloads all definitions from the configured directories.
	 */
	async reloadAll(): Promise<DefinitionLoadResult[]> {
		return this.loadAll(this.directories);
	}

	/**
	 * Alias for reloadAll - reloads all definitions.
	 */
	async reload(): Promise<DefinitionLoadResult[]> {
		return this.reloadAll();
	}

	/**
	 * Gets a definition by ID.
	 */
	getDefinition(id: string): YamlDefinition | undefined {
		return this.cache.get(id)?.definition;
	}

	/**
	 * Alias for getDefinition - gets a definition by ID.
	 */
	get(id: string): YamlDefinition | undefined {
		return this.getDefinition(id);
	}

	/**
	 * Gets all loaded definitions.
	 */
	getAllDefinitions(): YamlDefinition[] {
		return Array.from(this.cache.values()).map((r) => r.definition);
	}

	/**
	 * Alias for getAllDefinitions - gets all loaded definitions.
	 */
	getAll(): YamlDefinition[] {
		return this.getAllDefinitions();
	}

	/**
	 * Gets all definition IDs.
	 */
	getAllIds(): string[] {
		return Array.from(this.cache.keys());
	}

	/**
	 * Gets all load results including file paths and timestamps.
	 */
	getAllResults(): DefinitionLoadResult[] {
		return Array.from(this.cache.values());
	}

	/**
	 * Gets all errors from the last load operation.
	 */
	getErrors(): DefinitionLoadError[] {
		return [...this.errors];
	}

	/**
	 * Checks if a definition exists.
	 */
	hasDefinition(id: string): boolean {
		return this.cache.has(id);
	}

	/**
	 * Gets the count of loaded definitions.
	 */
	get count(): number {
		return this.cache.size;
	}

	/**
	 * Search definitions by name.
	 */
	searchByName(query: string): YamlDefinition[] {
		const queryLower = query.toLowerCase();
		return this.getAllDefinitions().filter(
			(def) =>
				def.name.toLowerCase().includes(queryLower) || def.id.toLowerCase().includes(queryLower)
		);
	}

	/**
	 * Get definitions by type (public, private, semi-private).
	 */
	getByType(type: 'public' | 'private' | 'semi-private'): YamlDefinition[] {
		return this.getAllDefinitions().filter((def) => def.type === type);
	}

	/**
	 * Get definitions that support a specific search mode.
	 */
	getBySearchMode(
		mode: 'search' | 'tv-search' | 'movie-search' | 'music-search' | 'book-search'
	): YamlDefinition[] {
		return this.getAllDefinitions().filter((def) => def.caps.modes && mode in def.caps.modes);
	}

	// =========================================================================
	// Unified Definition API
	// =========================================================================

	/**
	 * Check if definitions have been loaded.
	 */
	isLoaded(): boolean {
		return this.cache.size > 0 || this.errors.length > 0;
	}

	/**
	 * Get all definitions converted to unified IndexerDefinition format.
	 */
	getAllUnified(): IndexerDefinition[] {
		return this.getAllResults().map((result) =>
			yamlToUnifiedDefinition(result.definition, result.filePath)
		);
	}

	/**
	 * Get a single definition converted to unified IndexerDefinition format.
	 */
	getUnified(id: string): IndexerDefinition | undefined {
		const result = this.cache.get(id);
		if (!result) return undefined;
		return yamlToUnifiedDefinition(result.definition, result.filePath);
	}
}

/**
 * Singleton instance of the loader.
 */
let loaderInstance: YamlDefinitionLoader | null = null;

/**
 * Gets the singleton loader instance, initializing if necessary.
 */
export async function getYamlDefinitionLoader(
	directories?: string[]
): Promise<YamlDefinitionLoader> {
	if (!loaderInstance) {
		loaderInstance = new YamlDefinitionLoader();
		await loaderInstance.loadAll(directories);
	}

	return loaderInstance;
}

/**
 * Resets the singleton loader (useful for testing).
 */
export function resetYamlDefinitionLoader(): void {
	loaderInstance = null;
}
