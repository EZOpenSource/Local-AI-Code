import {
  conciseContextScoutPromptBuilder,
  concisePlannerPromptBuilder,
  conciseQaPromptBuilder,
  conciseReviewerPromptBuilder,
  conciseSafetyPromptBuilder,
  conciseVerifierPromptBuilder,
  conciseCoderPromptBuilder,
} from './concisePromptBuilder';
import {
  defaultContextScoutPromptBuilder,
  defaultPlannerPromptBuilder,
  defaultQaPromptBuilder,
  defaultReviewerPromptBuilder,
  defaultSafetyPromptBuilder,
  defaultVerifierPromptBuilder,
  defaultCoderPromptBuilder,
} from './defaultPromptBuilder';
import {
  ContextScoutPromptBuilder,
  PlannerPromptBuilder,
  PromptBuilderOption,
  PromptBuilderOptionsByRole,
  PromptBuilderRole,
  QaPromptBuilder,
  ReviewerPromptBuilder,
  SafetyPromptBuilder,
  VerifierPromptBuilder,
  CoderPromptBuilder,
} from './types';

const contextScoutBuilders = new Map<string, ContextScoutPromptBuilder>();
const plannerBuilders = new Map<string, PlannerPromptBuilder>();
const reviewerBuilders = new Map<string, ReviewerPromptBuilder>();
const coderBuilders = new Map<string, CoderPromptBuilder>();
const qaBuilders = new Map<string, QaPromptBuilder>();
const safetyBuilders = new Map<string, SafetyPromptBuilder>();
const verifierBuilders = new Map<string, VerifierPromptBuilder>();

const ALL_BUILDERS = new Map<string, PromptBuilderOption>();

function registerOption(builder: {
  readonly id: string;
  readonly role: PromptBuilderRole;
  readonly label: string;
  readonly description: string;
}): void {
  if (ALL_BUILDERS.has(builder.id)) {
    return;
  }
  const option: PromptBuilderOption = {
    id: builder.id,
    role: builder.role,
    label: builder.label,
    description: builder.description,
  };
  ALL_BUILDERS.set(builder.id, option);
}

function registerContextScout(builder: ContextScoutPromptBuilder): void {
  contextScoutBuilders.set(builder.id, builder);
  registerOption(builder);
}

function registerPlanner(builder: PlannerPromptBuilder): void {
  plannerBuilders.set(builder.id, builder);
  registerOption(builder);
}

function registerReviewer(builder: ReviewerPromptBuilder): void {
  reviewerBuilders.set(builder.id, builder);
  registerOption(builder);
}

function registerCoder(builder: CoderPromptBuilder): void {
  coderBuilders.set(builder.id, builder);
  registerOption(builder);
}

function registerQa(builder: QaPromptBuilder): void {
  qaBuilders.set(builder.id, builder);
  registerOption(builder);
}

function registerSafety(builder: SafetyPromptBuilder): void {
  safetyBuilders.set(builder.id, builder);
  registerOption(builder);
}

function registerVerifier(builder: VerifierPromptBuilder): void {
  verifierBuilders.set(builder.id, builder);
  registerOption(builder);
}

registerContextScout(defaultContextScoutPromptBuilder);
registerContextScout(conciseContextScoutPromptBuilder);
registerPlanner(defaultPlannerPromptBuilder);
registerPlanner(concisePlannerPromptBuilder);
registerReviewer(defaultReviewerPromptBuilder);
registerReviewer(conciseReviewerPromptBuilder);
registerCoder(defaultCoderPromptBuilder);
registerCoder(conciseCoderPromptBuilder);
registerQa(defaultQaPromptBuilder);
registerQa(conciseQaPromptBuilder);
registerSafety(defaultSafetyPromptBuilder);
registerSafety(conciseSafetyPromptBuilder);
registerVerifier(defaultVerifierPromptBuilder);
registerVerifier(conciseVerifierPromptBuilder);

export const DEFAULT_CONTEXT_SCOUT_PROMPT_BUILDER_ID = defaultContextScoutPromptBuilder.id;
export const DEFAULT_PLANNER_PROMPT_BUILDER_ID = defaultPlannerPromptBuilder.id;
export const DEFAULT_REVIEWER_PROMPT_BUILDER_ID = defaultReviewerPromptBuilder.id;
export const DEFAULT_CODER_PROMPT_BUILDER_ID = defaultCoderPromptBuilder.id;
export const DEFAULT_QA_PROMPT_BUILDER_ID = defaultQaPromptBuilder.id;
export const DEFAULT_SAFETY_PROMPT_BUILDER_ID = defaultSafetyPromptBuilder.id;
export const DEFAULT_VERIFIER_PROMPT_BUILDER_ID = defaultVerifierPromptBuilder.id;

const LEGACY_STYLE_ALIASES = new Map<
  string,
  Partial<Record<PromptBuilderRole, string>>
>([
  [
    'structured-default',
    {
      contextScout: defaultContextScoutPromptBuilder.id,
      planner: defaultPlannerPromptBuilder.id,
      reviewer: defaultReviewerPromptBuilder.id,
      coder: defaultCoderPromptBuilder.id,
      qa: defaultQaPromptBuilder.id,
      safety: defaultSafetyPromptBuilder.id,
      verifier: defaultVerifierPromptBuilder.id,
    },
  ],
  [
    'concise-strategist',
    {
      contextScout: conciseContextScoutPromptBuilder.id,
      planner: concisePlannerPromptBuilder.id,
      reviewer: conciseReviewerPromptBuilder.id,
      coder: conciseCoderPromptBuilder.id,
      qa: conciseQaPromptBuilder.id,
      safety: conciseSafetyPromptBuilder.id,
      verifier: conciseVerifierPromptBuilder.id,
    },
  ],
]);

function listOptions<T extends { id: string }>(map: Map<string, T>): PromptBuilderOption[] {
  const options: PromptBuilderOption[] = [];
  for (const builder of map.values()) {
    const option = ALL_BUILDERS.get(builder.id);
    if (option) {
      options.push(option);
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

function resolveBuilderId(
  role: PromptBuilderRole,
  requestedId: string | undefined | null
): string | null {
  if (!requestedId) {
    return null;
  }
  const trimmed = requestedId.trim();
  if (!trimmed) {
    return null;
  }
  const direct = ALL_BUILDERS.get(trimmed);
  if (direct) {
    if (direct.role === role) {
      return direct.id;
    }
    const directStyle = extractStyleId(direct.id);
    if (directStyle) {
      const candidate = `${directStyle}/${role}`;
      const candidateOption = ALL_BUILDERS.get(candidate);
      if (candidateOption) {
        return candidateOption.id;
      }
    }
  }
  const inferredStyle = extractStyleId(trimmed);
  if (inferredStyle) {
    const candidate = `${inferredStyle}/${role}`;
    if (ALL_BUILDERS.has(candidate)) {
      return candidate;
    }
  }
  const alias = LEGACY_STYLE_ALIASES.get(trimmed)?.[role];
  if (alias && ALL_BUILDERS.has(alias)) {
    return alias;
  }
  return null;
}

function extractStyleId(builderId: string): string | null {
  const separator = builderId.indexOf('/');
  if (separator <= 0) {
    return null;
  }
  return builderId.slice(0, separator);
}

function resolveBuilder<T extends { id: string }>(
  role: PromptBuilderRole,
  map: Map<string, T>,
  fallbackId: string,
  requestedId?: string | null
): T {
  const normalized = resolveBuilderId(role, requestedId);
  if (normalized && map.has(normalized)) {
    return map.get(normalized)!;
  }
  return map.get(fallbackId)!;
}

export function getContextScoutPromptBuilderById(
  id: string | undefined | null
): ContextScoutPromptBuilder {
  return resolveBuilder('contextScout', contextScoutBuilders, DEFAULT_CONTEXT_SCOUT_PROMPT_BUILDER_ID, id);
}

export function getPlannerPromptBuilderById(
  id: string | undefined | null
): PlannerPromptBuilder {
  return resolveBuilder('planner', plannerBuilders, DEFAULT_PLANNER_PROMPT_BUILDER_ID, id);
}

export function getReviewerPromptBuilderById(
  id: string | undefined | null
): ReviewerPromptBuilder {
  return resolveBuilder('reviewer', reviewerBuilders, DEFAULT_REVIEWER_PROMPT_BUILDER_ID, id);
}

export function getCoderPromptBuilderById(id: string | undefined | null): CoderPromptBuilder {
  return resolveBuilder('coder', coderBuilders, DEFAULT_CODER_PROMPT_BUILDER_ID, id);
}

export function getQaPromptBuilderById(id: string | undefined | null): QaPromptBuilder {
  return resolveBuilder('qa', qaBuilders, DEFAULT_QA_PROMPT_BUILDER_ID, id);
}

export function getSafetyPromptBuilderById(
  id: string | undefined | null
): SafetyPromptBuilder {
  return resolveBuilder('safety', safetyBuilders, DEFAULT_SAFETY_PROMPT_BUILDER_ID, id);
}

export function getVerifierPromptBuilderById(
  id: string | undefined | null
): VerifierPromptBuilder {
  return resolveBuilder('verifier', verifierBuilders, DEFAULT_VERIFIER_PROMPT_BUILDER_ID, id);
}

export function listPromptBuilderOptionsByRole(): PromptBuilderOptionsByRole {
  return {
    contextScout: listOptions(contextScoutBuilders),
    planner: listOptions(plannerBuilders),
    reviewer: listOptions(reviewerBuilders),
    coder: listOptions(coderBuilders),
    qa: listOptions(qaBuilders),
    safety: listOptions(safetyBuilders),
    verifier: listOptions(verifierBuilders),
  };
}

export function describePromptBuilder(id: string | undefined | null): string {
  if (!id) {
    return (
      ALL_BUILDERS.get(DEFAULT_PLANNER_PROMPT_BUILDER_ID)?.label ?? DEFAULT_PLANNER_PROMPT_BUILDER_ID
    );
  }
  const trimmed = id.trim();
  if (!trimmed) {
    return (
      ALL_BUILDERS.get(DEFAULT_PLANNER_PROMPT_BUILDER_ID)?.label ?? DEFAULT_PLANNER_PROMPT_BUILDER_ID
    );
  }
  return ALL_BUILDERS.get(trimmed)?.label ?? trimmed;
}

export function isValidPromptBuilderId(id: unknown): id is string {
  if (typeof id !== 'string') {
    return false;
  }
  const trimmed = id.trim();
  if (!trimmed) {
    return false;
  }
  return ALL_BUILDERS.has(trimmed);
}

export function normalizePromptBuilderIdForRole(
  builderId: string | undefined | null,
  role: PromptBuilderRole
): string | null {
  return resolveBuilderId(role, builderId);
}
