import { AssistantRequest } from '../../types';

export type PromptBuilderRole =
  | 'contextScout'
  | 'planner'
  | 'reviewer'
  | 'coder'
  | 'qa'
  | 'safety'
  | 'verifier';

export const PROMPT_BUILDER_ROLE_LABELS: Record<PromptBuilderRole, string> = {
  contextScout: 'Context scout',
  planner: 'Planner',
  reviewer: 'Reviewer',
  coder: 'Coder',
  qa: 'QA analyst',
  safety: 'Safety auditor',
  verifier: 'Verifier',
};

interface PromptBuilderMetadata {
  readonly id: string;
  readonly role: PromptBuilderRole;
  readonly label: string;
  readonly description: string;
}

export interface ContextScoutPromptBuilder extends PromptBuilderMetadata {
  buildPrompt(request: AssistantRequest): string;
}

export interface PlannerPromptBuilder extends PromptBuilderMetadata {
  buildPrompt(request: AssistantRequest): string;
}

export interface ReviewerPromptBuilder extends PromptBuilderMetadata {
  buildPrompt(request: AssistantRequest, coderPlan: string): string;
}

export interface CoderPromptBuilder extends PromptBuilderMetadata {
  buildPrompt(request: AssistantRequest, plannerDraft: string): string;
}

export interface QaPromptBuilder extends PromptBuilderMetadata {
  buildPrompt(request: AssistantRequest, reviewerPlan: string): string;
}

export interface SafetyPromptBuilder extends PromptBuilderMetadata {
  buildPrompt(request: AssistantRequest, qaPlan: string): string;
}

export interface VerifierPromptBuilder extends PromptBuilderMetadata {
  buildPrompt(request: AssistantRequest, safetyCheckedPlan: string): string;
}

export interface PromptBuilderOption {
  readonly id: string;
  readonly role: PromptBuilderRole;
  readonly label: string;
  readonly description: string;
}

export interface PromptBuilderOptionsByRole {
  readonly contextScout: readonly PromptBuilderOption[];
  readonly planner: readonly PromptBuilderOption[];
  readonly reviewer: readonly PromptBuilderOption[];
  readonly coder: readonly PromptBuilderOption[];
  readonly qa: readonly PromptBuilderOption[];
  readonly safety: readonly PromptBuilderOption[];
  readonly verifier: readonly PromptBuilderOption[];
}
