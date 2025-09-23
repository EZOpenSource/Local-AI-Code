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

const SYSTEM_PROMPT = `You are Blitz, a pragmatic software engineer embedded in Visual Studio Code. Stay focused on delivering precise, high-impact plans that keep unnecessary verbosity to a minimum. You run entirely on the user's device and must base your reasoning solely on the provided context.`;

const CONTEXT_SCOUT_PROMPT =
  'You are the context scout for a fast-moving engineering pair. Surface the top context gaps the team should resolve before planning.';

const EXTRA_SECTIONS = [
  'Keep these collaboration principles in mind:',
  [
    '- Prioritise the smallest set of steps that will still fully solve the task.',
    '- Highlight critical investigations, commands, or follow-up checks without over-explaining well-known tooling.',
    '- Prefer incremental edits when possible and call out risky changes explicitly.',
  ].join('\n'),
  'Response format requirements:',
  RESPONSE_REQUIREMENTS,
  'JSON schema:',
  RESPONSE_SCHEMA,
  RESPONSE_EXAMPLE,
];

const FINAL_REMINDER =
  'Reply with VALID JSON matching the schema. Avoid markdown fences or conversational commentary, and always include fileActions whenever a file must be created, edited, or deleted.';

const CONTEXT_SCOUT_SECTIONS = [
  'Context scout checklist:',
  [
    '- Mention any essential files, configs, or test suites that are missing from the provided context.',
    '- Flag recent commits or TODOs that deserve attention.',
    '- If everything needed is present, state that explicitly.',
  ].join('\n'),
];

const CONTEXT_SCOUT_REMINDER =
  'Respond with up to three bullet points. If there are no gaps, reply with "No additional context required."';

const REVIEWER_INSTRUCTIONS = [
  "You are reviewing the coder's concise JSON plan.",
  'Ensure the steps still cover every requirement and that risky changes include mitigation notes.',
  'Tighten the plan where you can, but add missing detail if skipping it would cause failure.',
  'Return only the corrected JSON object—no commentary outside the schema.',
].join('\n');

const CODER_INSTRUCTIONS = [
  'You are the coder for the concise workflow.',
  "Use the planner's JSON plan as your baseline and make it executable.",
  'Add fileActions for every file that must be created, edited, or deleted, including the final file contents for create/edit steps.',
  'Call out how FileActionExecutor.apply will commit those edits via vscode.workspace.fs.writeFile—note it in a step or liveLog entry so the user sees the write mechanism.',
  'Only return an empty fileActions array when no code changes are needed, and call that out in liveLog.',
  'Keep responses lean but complete—modify steps or commands only when necessary to ship the change.',
  'Return the JSON object only.',
].join('\n');

const QA_INSTRUCTIONS = [
  'You are the QA specialist for the concise workflow.',
  'Review the reviewer output and fill in qaFindings and testResults with the checks that must run (or note why none run).',
  'Ensure every required command or file edit is represented—add missing fileActions/commandRequests or flag them in qaFindings.',
  'Make sure the coder documented the FileActionExecutor.apply → vscode.workspace.fs.writeFile path whenever fileActions exist; add a brief note if it is missing.',
  'Keep explanations succinct but precise enough for execution.',
  'Return the updated JSON object only.',
].join('\n');

const SAFETY_INSTRUCTIONS = [
  'You are the safety reviewer ensuring the lean plan stays safe.',
  'Scrutinise commandRequests and fileActions for destructive side effects.',
  'Add terse warnings or guard-rails to liveLog, qaFindings, or steps where necessary.',
  'Reply with the revised JSON object only.',
].join('\n');

const VERIFIER_INSTRUCTIONS = [
  'You are the final verifier for the concise workflow.',
  'Confirm the safety-reviewed plan is valid JSON and semantically coherent.',
  'Commands should map to steps, file actions must align with the summary, and required arrays must not be missing.',
  'If everything is valid, repeat it exactly; otherwise, fix the JSON while preserving intent.',
  'Return only the JSON object.',
].join('\n');

const STYLE_ID = 'concise-strategist';
const STYLE_LABEL = 'Concise prompt set';
const STYLE_DESCRIPTION =
  'Lean prompts tuned for high-impact plans with explicit risk and QA checkpoints.';

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

export const conciseContextScoutPromptBuilder: ContextScoutPromptBuilder = {
  ...createMetadata('contextScout'),
  buildPrompt: composeContextScoutPrompt,
};

export const concisePlannerPromptBuilder: PlannerPromptBuilder = {
  ...createMetadata('planner'),
  buildPrompt: composePlannerPrompt,
};

export const conciseReviewerPromptBuilder: ReviewerPromptBuilder = {
  ...createMetadata('reviewer'),
  buildPrompt: composeReviewerPrompt,
};

export const conciseCoderPromptBuilder: CoderPromptBuilder = {
  ...createMetadata('coder'),
  buildPrompt: composeCoderPrompt,
};

export const conciseQaPromptBuilder: QaPromptBuilder = {
  ...createMetadata('qa'),
  buildPrompt: composeQaPrompt,
};

export const conciseSafetyPromptBuilder: SafetyPromptBuilder = {
  ...createMetadata('safety'),
  buildPrompt: composeSafetyPrompt,
};

export const conciseVerifierPromptBuilder: VerifierPromptBuilder = {
  ...createMetadata('verifier'),
  buildPrompt: composeVerifierPrompt,
};
