export interface AutoSearchIssue {
	code:
		| 'NO_DOWNLOAD_CLIENT'
		| 'NO_INDEXER_AVAILABLE'
		| 'INDEXER_TIMEOUT'
		| 'INDEXER_RATE_LIMITED'
		| 'GENERIC_ERROR';
	message: string;
	suggestion?: string;
	count?: number;
}

function normalizeError(value: string): string {
	return value.trim().replace(/\s+/g, ' ');
}

function classifyError(error: string): Omit<AutoSearchIssue, 'count'> | null {
	const normalized = normalizeError(error);
	const lower = normalized.toLowerCase();

	if (lower.includes('no enabled torrent download client configured')) {
		return {
			code: 'NO_DOWNLOAD_CLIENT',
			message: 'No torrent download client is enabled',
			suggestion: 'Enable a torrent client in Settings > Integrations > Download Clients.'
		};
	}

	if (lower.includes('no enabled usenet download client configured')) {
		return {
			code: 'NO_DOWNLOAD_CLIENT',
			message: 'No usenet download client is enabled',
			suggestion: 'Enable a usenet client in Settings > Integrations > Download Clients.'
		};
	}

	if (
		lower.includes('no indexers are available') ||
		lower.includes('no eligible indexers') ||
		lower.includes('indexer availability') ||
		lower.includes('selected in quality profile')
	) {
		return {
			code: 'NO_INDEXER_AVAILABLE',
			message: 'No eligible indexers are available for this search',
			suggestion:
				'Enable at least one indexer that supports this media type, or adjust the quality profile indexer selection.'
		};
	}

	if (lower.includes('timeout')) {
		return {
			code: 'INDEXER_TIMEOUT',
			message: 'Indexer search timed out',
			suggestion: 'Try again in a moment or reduce enabled indexers/query variants.'
		};
	}

	if (
		lower.includes('rate limit') ||
		lower.includes('too many requests') ||
		lower.includes('429')
	) {
		return {
			code: 'INDEXER_RATE_LIMITED',
			message: 'Indexer rate limit reached',
			suggestion: 'Wait briefly before retrying to avoid temporary blocking.'
		};
	}

	// "No suitable releases found" is expected and not actionable on infra/config.
	if (
		lower.includes('no suitable releases found') ||
		lower.includes('no upgrades found') ||
		lower.includes('no releases found that')
	) {
		return null;
	}

	return {
		code: 'GENERIC_ERROR',
		message: normalized
	};
}

export function collectAutoSearchIssues(
	errors: Array<string | null | undefined>
): AutoSearchIssue[] {
	const tally = new Map<string, AutoSearchIssue>();

	for (const raw of errors) {
		if (!raw) continue;
		const classified = classifyError(raw);
		if (!classified) continue;

		const key = `${classified.code}:${classified.message}:${classified.suggestion ?? ''}`;
		const existing = tally.get(key);
		if (existing) {
			existing.count = (existing.count ?? 1) + 1;
			continue;
		}

		tally.set(key, {
			...classified,
			count: 1
		});
	}

	return [...tally.values()].sort((a, b) => {
		const order: Record<AutoSearchIssue['code'], number> = {
			NO_DOWNLOAD_CLIENT: 0,
			NO_INDEXER_AVAILABLE: 1,
			INDEXER_TIMEOUT: 2,
			INDEXER_RATE_LIMITED: 3,
			GENERIC_ERROR: 4
		};
		return order[a.code] - order[b.code];
	});
}
