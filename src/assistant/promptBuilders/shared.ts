import { AssistantRequest, ConversationMessage } from '../../types';

export const RESPONSE_REQUIREMENTS = [
  'Return a single JSON object that follows the schema below.',
  'Include every top-level property even when there is nothing to report—use empty strings or arrays as appropriate.',
  'Escape newline characters inside JSON strings as \\n.',
  'Describe every required file creation or modification inside fileActions with the exact path and full file contents for create/edit operations. Only leave fileActions empty when no changes are needed and note that in the steps or liveLog.',
  'Do not claim an action has already happened—these plans run after user approval.',
  'Do not wrap the JSON in Markdown fences or surround it with additional commentary.',
]
  .map(rule => `- ${rule}`)
  .join('\n');

export const RESPONSE_SCHEMA = [
  '{',
  '  "summary": string, // summary of your plan or answer',
  '  "message": string, // markdown formatted response for the user',
  '  "steps": [',
  '    { "title": string, "detail"?: string, "result"?: string }',
  '  ],',
  '  "liveLog": string[], // ordered notes of relevant facts you gathered',
  '  "qaFindings": string[], // results of your final bug-hunt or quality checks',
  '  "testResults": string[], // automated tests you ran and what they reported',
  '  "commandRequests": [',
  '    { "command": string, "description"?: string }',
  '  ],',
  '  "fileActions": [',
  '    { "type": "create"|"edit"|"delete", "path": string, "content"?: string, "description"?: string }',
  '  ]',
  '}',
].join('\n');

export const RESPONSE_EXAMPLE = [
  'Example JSON response:',
  '{',
  '  "summary": "Create hello_world.py",',
  '  "message": "Ready to add hello_world.py and explain how the file will be written.",',
  '  "steps": [',
  '    {',
  '      "title": "Create hello_world.py",',
  '      "detail": "Use FileActionExecutor.apply -> vscode.workspace.fs.writeFile to add the script.",',
  '      "result": "hello_world.py staged for creation"',
  '    }',
  '  ],',
  '  "liveLog": [',
  '    "Documented that FileActionExecutor.apply -> vscode.workspace.fs.writeFile will persist hello_world.py when approved."',
  '  ],',
  '  "qaFindings": [],',
  '  "testResults": [],',
  '  "commandRequests": [',
  '    { "command": "python hello_world.py", "description": "Run the Hello World script" }',
  '  ],',
  '  "fileActions": [',
  '    { "type": "create", "path": "hello_world.py", "content": "print(\"Hello, World!\")\\n" }',
  '  ]',
  '}',
].join('\n');

export function composePrompt(
  systemPrompt: string,
  request: AssistantRequest,
  options: { extraSections?: string[]; closingReminder?: string } = {}
): string {
  const sections: string[] = [
    systemPrompt,
    `Project context:\n${formatContext(request.context)}`,
    `Conversation so far:\n${renderHistory(request.history)}`,
  ];

  if (options.extraSections?.length) {
    sections.push(...options.extraSections);
  }

  sections.push(`User request: ${request.prompt}`);

  if (options.closingReminder) {
    sections.push(options.closingReminder);
  }

  return sections.join('\n\n');
}

function formatContext(context: string): string {
  const trimmed = context.trim();
  return trimmed.length > 0 ? trimmed : '(no additional context provided)';
}

function renderHistory(history: ConversationMessage[]): string {
  if (history.length === 0) {
    return '(no prior messages)';
  }

  return history
    .map(entry => `${entry.role.toUpperCase()}:\n${entry.content}`)
    .join('\n\n');
}
