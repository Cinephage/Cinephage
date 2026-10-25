import { normalizeLiveTvChannelName } from '#lib/livetv/channel-name-normalizer.js';
import type {
	ChannelLineupItemWithDetails,
	EpgProgram,
	LiveTvProviderType
} from '#lib/types/livetv.js';

export interface ResolvedEpgChannelPlan {
	requestedChannelIds: string[];
	sourceChannelIds: string[];
	sourceByRequestedChannelId: Map<string, string>;
}

interface ResolvableLineupItem {
	channelId: string;
	epgSourceChannelId: string | null;
}

export interface AutoAttachTarget {
	lineupItemId: string;
	channelId: string;
	providerType: LiveTvProviderType;
	name: string;
	categoryId: string | null;
}

export interface AutoAttachCandidate {
	channelId: string;
	providerType: LiveTvProviderType;
	name: string;
	categoryId: string | null;
	programCount: number;
}

interface RankedCandidate {
	candidate: AutoAttachCandidate;
	sameCategory: boolean;
	exactName: boolean;
}

function getNormalizedChannelKey(name: string, providerType: LiveTvProviderType): string {
	return normalizeLiveTvChannelName(name, providerType).trim().toLocaleLowerCase();
}

export function buildResolvedEpgChannelPlan(
	requestedChannelIds: string[],
	lineup: ResolvableLineupItem[]
): ResolvedEpgChannelPlan {
	const requestedIds = [...new Set(requestedChannelIds.filter(Boolean))];
	const requestedIdSet = new Set(requestedIds);
	const sourceByRequestedChannelId = new Map<string, string>();

	for (const requestedChannelId of requestedIds) {
		sourceByRequestedChannelId.set(requestedChannelId, requestedChannelId);
	}

	for (const item of lineup) {
		if (!requestedIdSet.has(item.channelId)) {
			continue;
		}

		sourceByRequestedChannelId.set(item.channelId, item.epgSourceChannelId ?? item.channelId);
	}

	return {
		requestedChannelIds: requestedIds,
		sourceChannelIds: [...new Set(sourceByRequestedChannelId.values())],
		sourceByRequestedChannelId
	};
}

export function mapGuideDataToRequestedChannels(
	plan: ResolvedEpgChannelPlan,
	guideData: Map<string, EpgProgram[]>
): Map<string, EpgProgram[]> {
	const resolvedGuideData = new Map<string, EpgProgram[]>();

	for (const requestedChannelId of plan.requestedChannelIds) {
		const sourceChannelId =
			plan.sourceByRequestedChannelId.get(requestedChannelId) ?? requestedChannelId;
		resolvedGuideData.set(requestedChannelId, guideData.get(sourceChannelId) ?? []);
	}

	return resolvedGuideData;
}

function rankAutoAttachCandidate(
	target: AutoAttachTarget,
	candidate: AutoAttachCandidate
): RankedCandidate | null {
	if (target.channelId === candidate.channelId) {
		return null;
	}

	const targetKey = getNormalizedChannelKey(target.name, target.providerType);
	const candidateKey = getNormalizedChannelKey(candidate.name, candidate.providerType);

	if (!targetKey || targetKey !== candidateKey) {
		return null;
	}

	return {
		candidate,
		sameCategory: Boolean(target.categoryId && candidate.categoryId === target.categoryId),
		exactName: target.name.trim().toLocaleLowerCase() === candidate.name.trim().toLocaleLowerCase()
	};
}

function compareRankedCandidates(a: RankedCandidate, b: RankedCandidate): number {
	if (a.sameCategory !== b.sameCategory) {
		return a.sameCategory ? -1 : 1;
	}

	if (a.exactName !== b.exactName) {
		return a.exactName ? -1 : 1;
	}

	if (a.candidate.programCount !== b.candidate.programCount) {
		return b.candidate.programCount - a.candidate.programCount;
	}

	return a.candidate.channelId.localeCompare(b.candidate.channelId);
}

function hasSameRank(a: RankedCandidate, b: RankedCandidate): boolean {
	return (
		a.sameCategory === b.sameCategory &&
		a.exactName === b.exactName &&
		a.candidate.programCount === b.candidate.programCount
	);
}

export function selectAutoAttachEpgSource(
	target: AutoAttachTarget,
	candidates: AutoAttachCandidate[]
): AutoAttachCandidate | null {
	const rankedCandidates = candidates
		.map((candidate) => rankAutoAttachCandidate(target, candidate))
		.filter((candidate): candidate is RankedCandidate => Boolean(candidate))
		.sort(compareRankedCandidates);

	if (rankedCandidates.length === 0) {
		return null;
	}

	if (rankedCandidates.length > 1 && hasSameRank(rankedCandidates[0], rankedCandidates[1])) {
		return null;
	}

	return rankedCandidates[0].candidate;
}

export function buildResolvedPlanForLineup(
	lineup: Pick<ChannelLineupItemWithDetails, 'channelId' | 'epgSourceChannelId'>[]
): ResolvedEpgChannelPlan {
	return buildResolvedEpgChannelPlan(
		lineup.map((item) => item.channelId),
		lineup
	);
}
