/**
 * Built-in Cinephage modules - static registration.
 *
 * Mirrors the subtitles ProviderRegistry pattern (`registerBuiltinProviders`
 * in SubtitleProviderFactory.ts). Called by CinephageApiService.initialize()
 * before the registry's initializeAll() pass. New modules are added here
 * when they're ready to ship.
 */

import type { CinephageModuleRegistry } from '../registry/CinephageModuleRegistry.js';
import { LibraryStreamingModule } from './library-streaming/LibraryStreamingModule.js';

export function registerBuiltinModules(registry: CinephageModuleRegistry): void {
	if (!registry.getById('library-streaming')) {
		registry.register(new LibraryStreamingModule());
	}
}
