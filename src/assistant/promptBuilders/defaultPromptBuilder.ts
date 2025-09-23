import { AssistantRequest } from '../../types';
import {
  ContextScoutPromptBuilder,
  PlannerPromptBuilder,
  PromptBuilderRole,
  QaPromptBuilder,
  ReviewerPromptBuilder,
  SafetyPromptBuilder,
  VerifierPromptBuilder,
  PROMPT_BUILDER_ROLE_LABELS,
  CoderPromptBuilder,
} from './types';
import { composePrompt, RESPONSE_EXAMPLE, RESPONSE_REQUIREMENTS, RESPONSE_SCHEMA } from './shared';

const SYSTEM_PROMPT = `You are Aster, a senior software engineer embedded inside Visual Studio Code. You run entirely on the user's
device without any network access. You always produce actionable plans using ONLY the information available in the prompt.
You can suggest running shell or PowerShell commands, as well as creating, editing, or deleting files, but each action must be
expressed in structured JSON so the user can approve it before it happens.`;

const CONTEXT_SCOUT_PROMPT =
  'You are the context scout partnering with the engineering team. Identify any missing project context, risky blind spots, or follow-up questions the downstream agents should consider before drafting a plan.';

const EXTRA_SECTIONS = [
  'Response format requirements:',
  RESPONSE_REQUIREMENTS,
  'JSON schema:',
  RESPONSE_SCHEMA,
  RESPONSE_EXAMPLE,
];

const FINAL_REMINDER =
  'Remember: respond with VALID JSON only. Do not wrap it in markdown fences or add any extra text before or after the JSON object. Always include fileActions whenever a file needs to be created, edited, or deleted.';

const CONTEXT_SCOUT_SECTIONS = [
  'Focus areas for the context scout:',
  [
    '- Call out missing files, configs, or dependencies that future roles might need.',
    '- Highlight recent changes that deserve extra scrutiny.',
    '- Suggest follow-up questions if the available context seems insufficient.',
  ].join('\n'),
];

const CONTEXT_SCOUT_REMINDER =
  'Respond with a concise bullet list. If there are no gaps to highlight, reply with "No additional context required."';

const REVIEWER_INSTRUCTIONS = [
  'You are the reviewer model collaborating with another local assistant.',
  "The assistant message above is the coder's JSON implementation.",
  'Audit it for correctness, completeness, and adherence to the required schema.',
  'Fix any issues you discover, fill in missing details, and respond with the improved JSON object that still matches the schema exactly.',
  'If the draft is already strong, you may keep its structure but double-check the formatting and polish the content before replying.',
  'Record the collaboration insights or fixes you applied inside the liveLog array so the user can see what changed.',
  'Do not include commentary outside of the JSON object in your reply.',
].join('\n');

const CODER_INSTRUCTIONS = [
  "You are the coder responsible for turning the planner's draft into concrete changes.",
  "Use the planner's JSON plan as your starting point.",
  'Translate the steps into executable changes by adding fileActions for every file that must be created, edited, or deleted.',
  'When creating or editing files, include the final file contents exactly as they should appear.',
  'State explicitly how FileActionExecutor.apply will persist those changes (it wraps vscode.workspace.fs.writeFile) inside your steps or liveLog so the user can trace the write path.',
  'If no file changes are required, note why in liveLog before returning an empty fileActions array.',
  'Expand or adjust commandRequests and steps if the implementation requires it.',
  'Return only the updated JSON object matching the schema—no extra commentary.',
].join('\n');

const QA_INSTRUCTIONS = [
  'You are the QA analyst ensuring the JSON plan is test-ready.',
  "Review the reviewer's reply, decide what automated or manual checks should run, and record them in qaFindings and testResults.",
  'If no tests are applicable, state why. If tests are needed, describe them explicitly and mark whether they were run.',
  'Verify every required command or file change is represented—add missing fileActions/commandRequests or flag the gap in qaFindings.',
  'Confirm the coder documented the FileActionExecutor.apply → vscode.workspace.fs.writeFile flow whenever fileActions are present; add the note if it is missing.',
  'Tighten step descriptions or add mitigations when gaps would block validation.',
  'Respond with the corrected JSON object only—no commentary outside the schema.',
].join('\n');

const SAFETY_INSTRUCTIONS = [
  'You are the safety auditor examining the QA-adjusted JSON plan.',
  'Inspect commandRequests and fileActions for destructive or high-risk work.',
  'Add warnings and required safeguards to liveLog, qaFindings, or steps so the user can make an informed decision.',
  'Ensure risky actions include confirmations or backups when appropriate.',
  'Return only the revised JSON object that still matches the schema.',
].join('\n');

const VERIFIER_INSTRUCTIONS = [
  'You are the verification model collaborating with the planner and reviewer.',
  "The assistant message above is the safety-audited JSON plan that will be delivered to the user.",
  'Ensure the reply is valid JSON that strictly follows the required schema with no extra commentary or markdown.',
  'Double-check semantic consistency: every command should have a matching step, file actions must align with the summary, and required arrays should never be missing.',
  "If the payload is already valid, return it verbatim. Otherwise, rewrite it as valid JSON while preserving the team's intent.",
  'Never add explanations outside of the JSON object.',
].join('\n');

const STYLE_ID = 'structured-default';
const STYLE_LABEL = 'Comprehensive prompt set';
const STYLE_DESCRIPTION =
  'Detailed prompts that emphasise thorough planning, QA, and safety collaboration.';

function createMetadata(role: PromptBuilderRole) {
  return {
    id: `${STYLE_ID}/${role}`,
    role,
    label: `${STYLE_LABEL} · ${PROMPT_BUILDER_ROLE_LABELS[role]}`,
    description: STYLE_DESCRIPTION,
  };
}

function composeContextScoutPrompt(request: AssistantRequest): string {
  return composePrompt(CONTEXT_SCOUT_PROMPT, request, {
    extraSections: CONTEXT_SCOUT_SECTIONS,
    closingReminder: CONTEXT_SCOUT_REMINDER,
  });
}

function composePlannerPrompt(request: AssistantRequest): string {
  return composePrompt(SYSTEM_PROMPT, request, {
    extraSections: EXTRA_SECTIONS,
    closingReminder: FINAL_REMINDER,
  });
}

function composeReviewerPrompt(request: AssistantRequest, coderPlan: string): string {
  const reviewerRequest: AssistantRequest = {
    prompt: request.prompt,
    context: request.context,
    history: [
      ...request.history,
      { role: 'assistant', content: coderPlan },
      { role: 'user', content: REVIEWER_INSTRUCTIONS },
    ],
  };
  return composePlannerPrompt(reviewerRequest);
}

function composeCoderPrompt(request: AssistantRequest, plannerDraft: string): string {
  const coderRequest: AssistantRequest = {
    prompt: request.prompt,
    context: request.context,
    history: [
      ...request.history,
      { role: 'assistant', content: plannerDraft },
      { role: 'user', content: CODER_INSTRUCTIONS },
    ],
  };
  return composePlannerPrompt(coderRequest);
}

function composeQaPrompt(request: AssistantRequest, reviewerPlan: string): string {
  const qaRequest: AssistantRequest = {
    prompt: request.prompt,
    context: request.context,
    history: [
      ...request.history,
      { role: 'assistant', content: reviewerPlan },
      { role: 'user', content: QA_INSTRUCTIONS },
    ],
  };
  return composePlannerPrompt(qaRequest);
}

function composeSafetyPrompt(request: AssistantRequest, qaPlan: string): string {
  const safetyRequest: AssistantRequest = {
    prompt: request.prompt,
    context: request.context,
    history: [
      ...request.history,
      { role: 'assistant', content: qaPlan },
      { role: 'user', content: SAFETY_INSTRUCTIONS },
    ],
  };
  return composePlannerPrompt(safetyRequest);
}

function composeVerifierPrompt(request: AssistantRequest, safetyCheckedPlan: string): string {
  const verifierRequest: AssistantRequest = {
    prompt: request.prompt,
    context: request.context,
    history: [
      ...request.history,
      { role: 'assistant', content: safetyCheckedPlan },
      { role: 'user', content: VERIFIER_INSTRUCTIONS },
    ],
  };
  return composePlannerPrompt(verifierRequest);
}

export const defaultContextScoutPromptBuilder: ContextScoutPromptBuilder = {
  ...createMetadata('contextScout'),
  buildPrompt: composeContextScoutPrompt,
};

export const defaultPlannerPromptBuilder: PlannerPromptBuilder = {
  ...createMetadata('planner'),
  buildPrompt: composePlannerPrompt,
};

export const defaultReviewerPromptBuilder: ReviewerPromptBuilder = {
  ...createMetadata('reviewer'),
  buildPrompt: composeReviewerPrompt,
};

export const defaultCoderPromptBuilder: CoderPromptBuilder = {
  ...createMetadata('coder'),
  buildPrompt: composeCoderPrompt,
};

export const defaultQaPromptBuilder: QaPromptBuilder = {
  ...createMetadata('qa'),
  buildPrompt: composeQaPrompt,
};

export const defaultSafetyPromptBuilder: SafetyPromptBuilder = {
  ...createMetadata('safety'),
  buildPrompt: composeSafetyPrompt,
};

export const defaultVerifierPromptBuilder: VerifierPromptBuilder = {
  ...createMetadata('verifier'),
  buildPrompt: composeVerifierPrompt,
};
