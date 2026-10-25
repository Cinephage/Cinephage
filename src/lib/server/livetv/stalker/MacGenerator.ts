/**
 * MAC Address Generator for Stalker Portal Scanning
 *
 * Provides utilities for generating, validating, and parsing MAC addresses
 * used in Stalker portal account discovery.
 */

import { randomInt } from 'node:crypto';

/**
 * Known STB (Set-Top Box) MAC prefixes commonly used with Stalker portals.
 * These are manufacturer prefixes (OUI) for devices like MAG boxes.
 */
export const MAC_PREFIXES = [
	'00:1A:79', // Magnum Semiconductors Ltd (MAG box manufacturer) - Most common
	'00:2A:01',
	'00:1B:79',
	'00:2A:79',
	'00:A1:79',
	'D4:CF:F9',
	'33:44:CF',
	'10:27:BE',
	'A0:BB:3E',
	'55:93:EA',
	'04:D6:AA',
	'11:33:01',
	'00:1C:19',
	'1A:00:6A',
	'1A:00:FB'
] as const;

export type MacPrefix = (typeof MAC_PREFIXES)[number];

/**
 * Regular expression for validating MAC addresses.
 * Accepts formats: XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX
 */
const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;

/**
 * Regular expression for extracting MAC from various formats.
 * Handles: "MAC: XX:XX:XX:XX:XX:XX", "MAC Addr: XX:XX:XX:XX:XX:XX", plain MAC, etc.
 */
const MAC_EXTRACT_REGEX = /([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/;

export class MacGenerator {
	/**
	 * Generate a single random MAC address with the given prefix.
	 * @param prefix - 3-octet prefix (e.g., "00:1A:79")
	 * @returns Full MAC address (e.g., "00:1A:79:AB:CD:EF")
	 */
	static generateRandomMac(prefix: string = '00:1A:79'): string {
		const normalizedPrefix = this.normalizePrefix(prefix);
		// Portals key device identity to the MAC — use the CSPRNG so one
		// account's MAC is not predictable from another's.
		const suffix = Array.from({ length: 3 }, () =>
			randomInt(256).toString(16).padStart(2, '0').toUpperCase()
		).join(':');

		return `${normalizedPrefix}:${suffix}`;
	}

	/**
	 * Generator function for random MAC addresses with a given prefix.
	 * @param prefix - 3-octet prefix
	 * @param count - Number of MACs to generate
	 * @yields MAC addresses
	 */
	static *generateRandom(prefix: string = '00:1A:79', count: number): Generator<string> {
		const normalizedPrefix = this.normalizePrefix(prefix);
		const generated = new Set<string>();

		let attempts = 0;
		const maxAttempts = count * 10; // Prevent infinite loops

		while (generated.size < count && attempts < maxAttempts) {
			attempts++;
			const mac = this.generateRandomMac(normalizedPrefix);

			if (!generated.has(mac)) {
				generated.add(mac);
				yield mac;
			}
		}
	}

	/**
	 * Generator function for sequential MAC addresses in a range.
	 * @param start - Starting MAC address
	 * @param end - Ending MAC address
	 * @yields MAC addresses in sequence
	 */
	static *generateSequential(start: string, end: string): Generator<string> {
		const startNum = this.macToNumber(start);
		const endNum = this.macToNumber(end);

		if (startNum > endNum) {
			throw new Error('Start MAC must be less than or equal to end MAC');
		}

		// Limit to prevent excessive generation
		const maxRange = 1000000; // 1 million MACs max
		const range = endNum - startNum + 1;

		if (range > maxRange) {
			throw new Error(`Range too large: ${range} MACs. Maximum allowed: ${maxRange}`);
		}

		for (let i = startNum; i <= endNum; i++) {
			yield this.numberToMac(i);
		}
	}

	/**
	 * Generator function for MACs within a prefix range.
	 * Generates all possible MACs for a given prefix.
	 * @param prefix - 3-octet prefix
	 * @param limit - Maximum number to generate (default: all 16.7M)
	 * @yields MAC addresses
	 */
	static *generateFromPrefix(prefix: string, limit: number = 16777216): Generator<string> {
		const normalizedPrefix = this.normalizePrefix(prefix);
		const baseNum = this.macToNumber(`${normalizedPrefix}:00:00:00`);

		let count = 0;
		const maxSuffix = Math.min(16777215, limit - 1); // 0xFFFFFF = 16777215

		for (let suffix = 0; suffix <= maxSuffix && count < limit; suffix++) {
			count++;
			yield this.numberToMac(baseNum + suffix);
		}
	}

	/**
	 * Parse MAC addresses from a string input.
	 * Handles various formats: plain MACs, labeled MACs, one per line, comma-separated, etc.
	 * @param input - Raw input string
	 * @returns Array of normalized, valid MAC addresses (deduplicated)
	 */
	static parseImportedMacs(input: string): string[] {
		const macs = new Set<string>();

		// Split by common delimiters: newlines, commas, semicolons
		const lines = input.split(/[\n,;]+/);

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			// Try to extract MAC from the line
			const match = trimmed.match(MAC_EXTRACT_REGEX);
			if (match) {
				const mac = match[0];
				if (this.isValidMac(mac)) {
					macs.add(this.normalizeMac(mac));
				}
			}
		}

		return Array.from(macs);
	}

	/**
	 * Validate a MAC address format.
	 * @param mac - MAC address to validate
	 * @returns True if valid
	 */
	static isValidMac(mac: string): boolean {
		return MAC_REGEX.test(mac);
	}

	/**
	 * Normalize a MAC address to uppercase with colons.
	 * @param mac - MAC address to normalize
	 * @returns Normalized MAC (e.g., "00:1A:79:AB:CD:EF")
	 */
	static normalizeMac(mac: string): string {
		return mac
			.toUpperCase()
			.replace(/-/g, ':')
			.replace(/[^0-9A-F:]/g, '');
	}

	/**
	 * Normalize a MAC prefix to uppercase with colons.
	 * @param prefix - Prefix to normalize (e.g., "00:1a:79" or "00-1A-79")
	 * @returns Normalized prefix (e.g., "00:1A:79")
	 */
	static normalizePrefix(prefix: string): string {
		const normalized = prefix.toUpperCase().replace(/-/g, ':');

		// Validate prefix format (3 octets)
		const parts = normalized.split(':');
		if (parts.length !== 3 || !parts.every((p) => /^[0-9A-F]{2}$/.test(p))) {
			throw new Error(`Invalid MAC prefix: ${prefix}. Expected format: XX:XX:XX`);
		}

		return normalized;
	}

	/**
	 * Convert a MAC address to a numeric value.
	 * @param mac - MAC address
	 * @returns Numeric representation
	 */
	static macToNumber(mac: string): number {
		const normalized = this.normalizeMac(mac);
		const parts = normalized.split(':');

		if (parts.length !== 6) {
			throw new Error(`Invalid MAC address: ${mac}`);
		}

		let result = 0;
		for (const part of parts) {
			result = result * 256 + parseInt(part, 16);
		}

		return result;
	}

	/**
	 * Convert a numeric value to a MAC address.
	 * @param num - Numeric value
	 * @returns MAC address
	 */
	static numberToMac(num: number): string {
		const parts: string[] = [];

		for (let i = 5; i >= 0; i--) {
			const byte = (num >> (i * 8)) & 0xff;
			parts.push(byte.toString(16).padStart(2, '0').toUpperCase());
		}

		return parts.join(':');
	}

	/**
	 * Get the prefix (first 3 octets) from a MAC address.
	 * @param mac - Full MAC address
	 * @returns Prefix (e.g., "00:1A:79")
	 */
	static getPrefix(mac: string): string {
		const normalized = this.normalizeMac(mac);
		return normalized.split(':').slice(0, 3).join(':');
	}

	/**
	 * Check if a MAC address uses a known STB prefix.
	 * @param mac - MAC address to check
	 * @returns True if prefix is in known list
	 */
	static isKnownPrefix(mac: string): boolean {
		const prefix = this.getPrefix(mac);
		return (MAC_PREFIXES as readonly string[]).includes(prefix);
	}

	/**
	 * Get human-readable info about a MAC prefix.
	 * @param prefix - MAC prefix
	 * @returns Description or undefined
	 */
	static getPrefixInfo(prefix: string): string | undefined {
		const normalized = this.normalizePrefix(prefix);

		// Known manufacturer info
		const prefixInfo: Record<string, string> = {
			'00:1A:79': 'Magnum Semiconductors Ltd (MAG boxes)',
			'00:2A:01': 'STB Device',
			'00:1B:79': 'Magnum Semiconductors Ltd',
			'00:2A:79': 'STB Device',
			'00:A1:79': 'STB Device',
			'D4:CF:F9': 'STB Device',
			'10:27:BE': 'STB Device',
			'A0:BB:3E': 'STB Device',
			'04:D6:AA': 'STB Device',
			'00:1C:19': 'STB Device'
		};

		return prefixInfo[normalized];
	}

	/**
	 * Calculate the number of MACs in a sequential range.
	 * @param start - Starting MAC
	 * @param end - Ending MAC
	 * @returns Number of MACs in range (inclusive)
	 */
	static getRangeSize(start: string, end: string): number {
		const startNum = this.macToNumber(start);
		const endNum = this.macToNumber(end);
		return Math.abs(endNum - startNum) + 1;
	}

	/**
	 * Get default MAC prefixes for scanning.
	 * @returns Array of prefix objects with name and value
	 */
	static getDefaultPrefixes(): Array<{ prefix: string; name: string }> {
		return MAC_PREFIXES.map((prefix) => ({
			prefix,
			name: this.getPrefixInfo(prefix) || 'STB Device'
		}));
	}
}
