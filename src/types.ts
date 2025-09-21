export type ConversationRole = 'system' | 'user' | 'assistant';

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

export interface AssistantRequest {
  prompt: string;
  context: string;
  history: ConversationMessage[];
}

export interface AssistantResponse {
  message: string;
  commandRequests?: ShellCommandRequest[];
  fileActions?: FileAction[];
}

export interface ShellCommandRequest {
  command: string;
  description?: string;
}

export type FileActionType = 'create' | 'edit' | 'delete';

export interface FileAction {
  type: FileActionType;
  path: string;
  content?: string;
  description?: string;
}

export interface PlanStep {
  title: string;
  detail?: string;
  result?: string;
}

export interface AssistantPlan {
  summary: string;
  message: string;
  steps: PlanStep[];
  liveLog: string[];
  qaFindings: string[];
  testResults: string[];
  commandRequests: ShellCommandRequest[];
  fileActions: FileAction[];
}
