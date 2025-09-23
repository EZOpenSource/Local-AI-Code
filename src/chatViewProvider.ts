import * as vscode from 'vscode';

export type ChatRole = 'user' | 'assistant' | 'system' | 'notice';
export type ApprovalMode = 'requireApproval' | 'autoApprove';

export interface BusyProgress {
  readonly completed: number;
  readonly total: number;
}

export interface BusyOptions {
  readonly cancellable?: boolean;
  readonly progress?: BusyProgress | null;
}

export interface ChatEntry {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly subtitle?: string;
  readonly timestamp: number;
}

export interface ChatModelOption {
  readonly id: string;
  readonly label: string;
}

export type ChatPromptBuilderRole =
  | 'contextScout'
  | 'planner'
  | 'reviewer'
  | 'coder'
  | 'qa'
  | 'safety'
  | 'verifier';

export interface ChatPromptBuilderOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly role: ChatPromptBuilderRole;
}

export interface ChatPromptBuilderGroups {
  readonly contextScout: readonly ChatPromptBuilderOption[];
  readonly planner: readonly ChatPromptBuilderOption[];
  readonly reviewer: readonly ChatPromptBuilderOption[];
  readonly coder: readonly ChatPromptBuilderOption[];
  readonly qa: readonly ChatPromptBuilderOption[];
  readonly safety: readonly ChatPromptBuilderOption[];
  readonly verifier: readonly ChatPromptBuilderOption[];
}

export interface ChatControlsState {
  readonly approvalMode: ApprovalMode;
  readonly plannerModelId: string;
  readonly reviewerModelId: string;
  readonly reviewerFollowsPlanner: boolean;
  readonly coderModelId: string;
  readonly coderFollowsReviewer: boolean;
  readonly verifierModelId: string;
  readonly verifierFollowsCoder: boolean;
  readonly contextScoutPromptBuilderId: string;
  readonly contextScoutPromptFollowsPlanner: boolean;
  readonly plannerPromptBuilderId: string;
  readonly reviewerPromptBuilderId: string;
  readonly reviewerPromptFollowsPlanner: boolean;
  readonly coderPromptBuilderId: string;
  readonly coderPromptFollowsReviewer: boolean;
  readonly qaPromptBuilderId: string;
  readonly qaPromptFollowsCoder: boolean;
  readonly safetyPromptBuilderId: string;
  readonly safetyPromptFollowsQa: boolean;
  readonly verifierPromptBuilderId: string;
  readonly verifierPromptFollowsSafety: boolean;
  readonly models: readonly ChatModelOption[];
  readonly promptBuilders: ChatPromptBuilderGroups;
}

export const REVIEWER_INHERIT_MODEL_ID = '__planner__';
export const CODER_INHERIT_MODEL_ID = '__reviewer__';
export const CONTEXT_SCOUT_PROMPT_INHERIT_ID = '__planner_prompt__';
export const REVIEWER_PROMPT_INHERIT_ID = '__planner_prompt__';
export const CODER_PROMPT_INHERIT_ID = '__reviewer_prompt__';
export const QA_PROMPT_INHERIT_ID = '__coder_prompt__';
export const SAFETY_PROMPT_INHERIT_ID = '__qa_prompt__';
export const VERIFIER_INHERIT_MODEL_ID = '__coder__';
export const VERIFIER_PROMPT_INHERIT_ID = '__safety_prompt__';

export interface ChatState {
  readonly entries: ChatEntry[];
  readonly busy: boolean;
  readonly busyLabel?: string;
  readonly busyCancellable: boolean;
  readonly busyProgress: BusyProgress | null;
  readonly controls: ChatControlsState;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'ai-code.chatView';

  private view: vscode.WebviewView | undefined;
  private readonly entries: ChatEntry[] = [];
  private busy = false;
  private busyLabel: string | undefined;
  private busyCancellable = false;
  private busyProgress: BusyProgress | null = null;
  private controls: ChatControlsState = {
    approvalMode: 'requireApproval',
    plannerModelId: '',
    reviewerModelId: '',
    reviewerFollowsPlanner: true,
    coderModelId: '',
    coderFollowsReviewer: true,
    verifierModelId: '',
    verifierFollowsCoder: true,
    contextScoutPromptBuilderId: '',
    contextScoutPromptFollowsPlanner: true,
    plannerPromptBuilderId: '',
    reviewerPromptBuilderId: '',
    reviewerPromptFollowsPlanner: true,
    coderPromptBuilderId: '',
    coderPromptFollowsReviewer: true,
    qaPromptBuilderId: '',
    qaPromptFollowsCoder: true,
    safetyPromptBuilderId: '',
    safetyPromptFollowsQa: true,
    verifierPromptBuilderId: '',
    verifierPromptFollowsSafety: true,
    models: [],
    promptBuilders: {
      contextScout: [],
      planner: [],
      reviewer: [],
      coder: [],
      qa: [],
      safety: [],
      verifier: [],
    },
  };
  private readonly pendingMessages: unknown[] = [];
  private readonly allowedMenuCommands = new Set<string>([
    'ai-code.openSettings',
    'ai-code.addOllamaModel',
    'ai-code.removeModel',
    'ai-code.downloadModel',
    'ai-code.resetSettings',
    'ai-code.runDebugPrompt',
    'ai-code.resetConversation',
    'ai-code.showLastPlan',
    'workbench.action.openSettings',
    'workbench.action.openGlobalKeybindings',
  ]);
  private readonly submitEmitter = new vscode.EventEmitter<string>();
  private readonly resetEmitter = new vscode.EventEmitter<void>();
  private readonly approvalModeEmitter = new vscode.EventEmitter<ApprovalMode>();
  private readonly plannerModelEmitter = new vscode.EventEmitter<string>();
  private readonly reviewerModelEmitter = new vscode.EventEmitter<string>();
  private readonly coderModelEmitter = new vscode.EventEmitter<string>();
  private readonly verifierModelEmitter = new vscode.EventEmitter<string>();
  private readonly contextPromptBuilderEmitter = new vscode.EventEmitter<string>();
  private readonly plannerPromptBuilderEmitter = new vscode.EventEmitter<string>();
  private readonly reviewerPromptBuilderEmitter = new vscode.EventEmitter<string>();
  private readonly coderPromptBuilderEmitter = new vscode.EventEmitter<string>();
  private readonly qaPromptBuilderEmitter = new vscode.EventEmitter<string>();
  private readonly safetyPromptBuilderEmitter = new vscode.EventEmitter<string>();
  private readonly verifierPromptBuilderEmitter = new vscode.EventEmitter<string>();
  private readonly cancelEmitter = new vscode.EventEmitter<void>();

  public readonly onDidSubmitPrompt = this.submitEmitter.event;
  public readonly onDidReset = this.resetEmitter.event;
  public readonly onDidChangeApprovalMode = this.approvalModeEmitter.event;
  public readonly onDidChangePlannerModel = this.plannerModelEmitter.event;
  public readonly onDidChangeReviewerModel = this.reviewerModelEmitter.event;
  public readonly onDidChangeCoderModel = this.coderModelEmitter.event;
  public readonly onDidChangeVerifierModel = this.verifierModelEmitter.event;
  public readonly onDidChangeContextPromptBuilder = this.contextPromptBuilderEmitter.event;
  public readonly onDidChangePlannerPromptBuilder = this.plannerPromptBuilderEmitter.event;
  public readonly onDidChangeReviewerPromptBuilder = this.reviewerPromptBuilderEmitter.event;
  public readonly onDidChangeCoderPromptBuilder = this.coderPromptBuilderEmitter.event;
  public readonly onDidChangeQaPromptBuilder = this.qaPromptBuilderEmitter.event;
  public readonly onDidChangeSafetyPromptBuilder = this.safetyPromptBuilderEmitter.event;
  public readonly onDidChangeVerifierPromptBuilder = this.verifierPromptBuilderEmitter.event;
  public readonly onDidCancel = this.cancelEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(message => {
      if (!message || typeof message !== 'object') {
        return;
      }
      switch (message.type) {
        case 'submit': {
          const text = typeof message.text === 'string' ? message.text.trim() : '';
          if (text.length > 0) {
            this.submitEmitter.fire(text);
          }
          break;
        }
        case 'reset': {
          this.resetEmitter.fire();
          break;
        }
        case 'setApprovalMode': {
          if (typeof message.mode === 'string') {
            const normalized = message.mode === 'autoApprove' ? 'autoApprove' : 'requireApproval';
            this.controls = {
              ...this.controls,
              approvalMode: normalized,
            };
            this.approvalModeEmitter.fire(normalized);
          }
          break;
        }
        case 'setModel':
        case 'setPlannerModel': {
          if (typeof message.modelId === 'string' && message.modelId.trim().length > 0) {
            const plannerModelId = message.modelId;
            const reviewerModelId = this.controls.reviewerFollowsPlanner
              ? plannerModelId
              : this.controls.reviewerModelId;
            const coderModelId = this.controls.coderFollowsReviewer
              ? reviewerModelId
              : this.controls.coderModelId;
            const verifierModelId = this.controls.verifierFollowsCoder
              ? coderModelId
              : this.controls.verifierModelId;
            this.controls = {
              ...this.controls,
              plannerModelId,
              reviewerModelId,
              coderModelId,
              verifierModelId,
            };
            this.plannerModelEmitter.fire(message.modelId);
          }
          break;
        }
        case 'setReviewerModel': {
          if (typeof message.modelId === 'string') {
            const followPlanner = message.modelId === REVIEWER_INHERIT_MODEL_ID;
            const reviewerModelId = followPlanner ? this.controls.plannerModelId : message.modelId;
            const coderModelId = this.controls.coderFollowsReviewer
              ? reviewerModelId
              : this.controls.coderModelId;
            const verifierModelId = this.controls.verifierFollowsCoder
              ? coderModelId
              : this.controls.verifierModelId;
            this.controls = {
              ...this.controls,
              reviewerModelId,
              reviewerFollowsPlanner: followPlanner,
              coderModelId,
              verifierModelId,
            };
            this.reviewerModelEmitter.fire(message.modelId);
          }
          break;
        }
        case 'setCoderModel': {
          if (typeof message.modelId === 'string') {
            const followReviewer = message.modelId === CODER_INHERIT_MODEL_ID;
            this.controls = {
              ...this.controls,
              coderModelId: followReviewer ? this.controls.reviewerModelId : message.modelId,
              coderFollowsReviewer: followReviewer,
              verifierModelId: this.controls.verifierFollowsCoder
                ? followReviewer
                  ? this.controls.reviewerModelId
                  : message.modelId
                : this.controls.verifierModelId,
            };
            this.coderModelEmitter.fire(message.modelId);
          }
          break;
        }
        case 'setVerifierModel': {
          if (typeof message.modelId === 'string') {
            const followCoder = message.modelId === VERIFIER_INHERIT_MODEL_ID;
            this.controls = {
              ...this.controls,
              verifierModelId: followCoder ? this.controls.coderModelId : message.modelId,
              verifierFollowsCoder: followCoder,
            };
            this.verifierModelEmitter.fire(message.modelId);
          }
          break;
        }
        case 'setPlannerPromptBuilder': {
          if (typeof message.builderId === 'string' && message.builderId.trim().length > 0) {
            const contextBuilderId = this.controls.contextScoutPromptFollowsPlanner
              ? message.builderId
              : this.controls.contextScoutPromptBuilderId;
            const reviewerBuilderId = this.controls.reviewerPromptFollowsPlanner
              ? message.builderId
              : this.controls.reviewerPromptBuilderId;
            const coderBuilderId = this.controls.coderPromptFollowsReviewer
              ? reviewerBuilderId
              : this.controls.coderPromptBuilderId;
            const qaBuilderId = this.controls.qaPromptFollowsCoder
              ? coderBuilderId
              : this.controls.qaPromptBuilderId;
            const safetyBuilderId = this.controls.safetyPromptFollowsQa
              ? qaBuilderId
              : this.controls.safetyPromptBuilderId;
            const verifierBuilderId = this.controls.verifierPromptFollowsSafety
              ? safetyBuilderId
              : this.controls.verifierPromptBuilderId;
            this.controls = {
              ...this.controls,
              plannerPromptBuilderId: message.builderId,
              contextScoutPromptBuilderId: contextBuilderId,
              reviewerPromptBuilderId: reviewerBuilderId,
              coderPromptBuilderId: coderBuilderId,
              qaPromptBuilderId: qaBuilderId,
              safetyPromptBuilderId: safetyBuilderId,
              verifierPromptBuilderId: verifierBuilderId,
            };
            this.plannerPromptBuilderEmitter.fire(message.builderId);
          }
          break;
        }
        case 'setContextPromptBuilder': {
          if (typeof message.builderId === 'string') {
            const followPlanner = message.builderId === CONTEXT_SCOUT_PROMPT_INHERIT_ID;
            this.controls = {
              ...this.controls,
              contextScoutPromptBuilderId: followPlanner
                ? this.controls.plannerPromptBuilderId
                : message.builderId,
              contextScoutPromptFollowsPlanner: followPlanner,
            };
            this.contextPromptBuilderEmitter.fire(message.builderId);
          }
          break;
        }
        case 'setReviewerPromptBuilder': {
          if (typeof message.builderId === 'string') {
            const followPlanner = message.builderId === REVIEWER_PROMPT_INHERIT_ID;
            const reviewerBuilderId = followPlanner
              ? this.controls.plannerPromptBuilderId
              : message.builderId;
            const coderBuilderId = this.controls.coderPromptFollowsReviewer
              ? reviewerBuilderId
              : this.controls.coderPromptBuilderId;
            const qaBuilderId = this.controls.qaPromptFollowsCoder
              ? coderBuilderId
              : this.controls.qaPromptBuilderId;
            const safetyBuilderId = this.controls.safetyPromptFollowsQa
              ? qaBuilderId
              : this.controls.safetyPromptBuilderId;
            const verifierBuilderId = this.controls.verifierPromptFollowsSafety
              ? safetyBuilderId
              : this.controls.verifierPromptBuilderId;
            this.controls = {
              ...this.controls,
              reviewerPromptBuilderId: reviewerBuilderId,
              reviewerPromptFollowsPlanner: followPlanner,
              coderPromptBuilderId: coderBuilderId,
              qaPromptBuilderId: qaBuilderId,
              safetyPromptBuilderId: safetyBuilderId,
              verifierPromptBuilderId: verifierBuilderId,
            };
            this.reviewerPromptBuilderEmitter.fire(message.builderId);
          }
          break;
        }
        case 'setCoderPromptBuilder': {
          if (typeof message.builderId === 'string') {
            const followReviewer = message.builderId === CODER_PROMPT_INHERIT_ID;
            const coderBuilderId = followReviewer
              ? this.controls.reviewerPromptBuilderId
              : message.builderId;
            const qaBuilderId = this.controls.qaPromptFollowsCoder
              ? coderBuilderId
              : this.controls.qaPromptBuilderId;
            const safetyBuilderId = this.controls.safetyPromptFollowsQa
              ? qaBuilderId
              : this.controls.safetyPromptBuilderId;
            const verifierBuilderId = this.controls.verifierPromptFollowsSafety
              ? safetyBuilderId
              : this.controls.verifierPromptBuilderId;
            this.controls = {
              ...this.controls,
              coderPromptBuilderId: coderBuilderId,
              coderPromptFollowsReviewer: followReviewer,
              qaPromptBuilderId: qaBuilderId,
              safetyPromptBuilderId: safetyBuilderId,
              verifierPromptBuilderId: verifierBuilderId,
            };
            this.coderPromptBuilderEmitter.fire(message.builderId);
          }
          break;
        }
        case 'setQaPromptBuilder': {
          if (typeof message.builderId === 'string') {
            const followCoder = message.builderId === QA_PROMPT_INHERIT_ID;
            const qaBuilderId = followCoder
              ? this.controls.coderPromptBuilderId
              : message.builderId;
            const safetyBuilderId = this.controls.safetyPromptFollowsQa
              ? qaBuilderId
              : this.controls.safetyPromptBuilderId;
            const verifierBuilderId = this.controls.verifierPromptFollowsSafety
              ? safetyBuilderId
              : this.controls.verifierPromptBuilderId;
            this.controls = {
              ...this.controls,
              qaPromptBuilderId: qaBuilderId,
              qaPromptFollowsCoder: followCoder,
              safetyPromptBuilderId: safetyBuilderId,
              verifierPromptBuilderId: verifierBuilderId,
            };
            this.qaPromptBuilderEmitter.fire(message.builderId);
          }
          break;
        }
        case 'setSafetyPromptBuilder': {
          if (typeof message.builderId === 'string') {
            const followQa = message.builderId === SAFETY_PROMPT_INHERIT_ID;
            const safetyBuilderId = followQa
              ? this.controls.qaPromptBuilderId
              : message.builderId;
            const verifierBuilderId = this.controls.verifierPromptFollowsSafety
              ? safetyBuilderId
              : this.controls.verifierPromptBuilderId;
            this.controls = {
              ...this.controls,
              safetyPromptBuilderId: safetyBuilderId,
              safetyPromptFollowsQa: followQa,
              verifierPromptBuilderId: verifierBuilderId,
            };
            this.safetyPromptBuilderEmitter.fire(message.builderId);
          }
          break;
        }
        case 'setVerifierPromptBuilder': {
          if (typeof message.builderId === 'string') {
            const followSafety = message.builderId === VERIFIER_PROMPT_INHERIT_ID;
            this.controls = {
              ...this.controls,
              verifierPromptBuilderId: followSafety
                ? this.controls.safetyPromptBuilderId
                : message.builderId,
              verifierPromptFollowsSafety: followSafety,
            };
            this.verifierPromptBuilderEmitter.fire(message.builderId);
          }
          break;
        }
        case 'command': {
          if (typeof message.command === 'string' && this.allowedMenuCommands.has(message.command)) {
            const args = Array.isArray(message.arguments) ? message.arguments : [];
            void vscode.commands.executeCommand(message.command, ...args);
          }
          break;
        }
        case 'cancel': {
          this.cancelEmitter.fire();
          break;
        }
        default:
          break;
      }
    });
    this.flushPendingMessages();
    this.pushState(true);
  }

  dispose(): void {
    this.submitEmitter.dispose();
    this.resetEmitter.dispose();
    this.approvalModeEmitter.dispose();
    this.plannerModelEmitter.dispose();
    this.reviewerModelEmitter.dispose();
    this.coderModelEmitter.dispose();
    this.verifierModelEmitter.dispose();
    this.contextPromptBuilderEmitter.dispose();
    this.plannerPromptBuilderEmitter.dispose();
    this.reviewerPromptBuilderEmitter.dispose();
    this.coderPromptBuilderEmitter.dispose();
    this.qaPromptBuilderEmitter.dispose();
    this.safetyPromptBuilderEmitter.dispose();
    this.verifierPromptBuilderEmitter.dispose();
    this.cancelEmitter.dispose();
  }

  public show(): void {
    this.view?.show?.(true);
  }

  public load(entries: ChatEntry[]): void {
    this.entries.splice(0, this.entries.length, ...entries);
    this.pushState(true);
  }

  public append(entry: ChatEntry): void {
    this.entries.push(entry);
    this.queue({ type: 'append', entry });
  }

  public update(entry: ChatEntry): void {
    const index = this.entries.findIndex(item => item.id === entry.id);
    if (index === -1) {
      this.append(entry);
    } else {
      this.entries[index] = entry;
      this.queue({ type: 'replace', entry });
    }
  }

  public addNotice(text: string): void {
    const entry: ChatEntry = {
      id: `notice-${Date.now()}`,
      role: 'notice',
      text,
      timestamp: Date.now(),
    };
    this.append(entry);
  }

  public setBusy(busy: boolean, label?: string, options: BusyOptions = {}): void {
    this.busy = busy;
    this.busyLabel = label;
    this.busyCancellable = options.cancellable ?? false;
    this.busyProgress = options.progress ?? null;
    this.queue({ type: 'busy', busy, label, options: { ...options, progress: this.busyProgress } });
  }

  public setPreferences(preferences: ChatControlsState): void {
    this.controls = preferences;
    this.queue({ type: 'preferences', preferences });
  }

  public getState(): ChatState {
    return {
      entries: [...this.entries],
      busy: this.busy,
      busyLabel: this.busyLabel,
      busyCancellable: this.busyCancellable,
      busyProgress: this.busyProgress,
      controls: this.controls,
    };
  }

  private pushState(includeEntries: boolean): void {
    const state: ChatState = {
      entries: includeEntries ? [...this.entries] : this.entries,
      busy: this.busy,
      busyLabel: this.busyLabel,
      busyCancellable: this.busyCancellable,
      busyProgress: this.busyProgress,
      controls: this.controls,
    };
    this.queue({ type: 'init', state });
  }

  private queue(message: unknown): void {
    if (this.view) {
      this.view.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  private flushPendingMessages(): void {
    if (!this.view || this.pendingMessages.length === 0) {
      return;
    }
    for (const message of this.pendingMessages.splice(0)) {
      this.view.webview.postMessage(message);
    }
  }

  private getResourceUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...pathSegments));
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.createNonce();
    const cspSource = webview.cspSource;
    const sendIconUri = this.getResourceUri(webview, 'media', 'send-icon.svg').toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local Ai Coder</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .wrapper {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 0.75rem 0.75rem 0.5rem 0.75rem;
      box-sizing: border-box;
      gap: 0.75rem;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem;
    }
    header nav {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    header h1 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    header span {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8rem;
    }
    .recent-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .recent-item {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--vscode-descriptionForeground);
      font-size: 0.78rem;
      cursor: pointer;
      padding: 0.3rem 0.45rem;
      border-radius: 0.35rem;
    }
    .recent-item:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--vscode-foreground);
    }
    .control-group {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      min-width: 0;
    }
    .control-label {
      font-size: 0.75rem;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .control-select {
      appearance: none;
      border: 1px solid var(--vscode-dropdown-border, rgba(255, 255, 255, 0.08));
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border-radius: 0.5rem;
      padding: 0.35rem 0.65rem;
      font: inherit;
      min-width: 10rem;
      width: 100%;
      cursor: pointer;
    }
    .chat-scroll {
      flex: 1 1 auto;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding-right: 0.25rem;
    }
    .chat-entry {
      padding: 0.5rem 0.6rem;
      border-radius: 0.75rem;
      max-width: 100%;
      white-space: pre-wrap;
      word-break: break-word;
      animation: fade-in 120ms ease-in;
    }
    .chat-entry.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .chat-entry.assistant {
      align-self: flex-start;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.06));
      color: var(--vscode-foreground);
    }
    .chat-entry.notice {
      align-self: center;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 0.75rem;
    }
    .chat-entry .subtitle {
      display: block;
      font-size: 0.75rem;
      margin-bottom: 0.35rem;
      color: var(--vscode-descriptionForeground);
    }
    form {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 1.2rem;
      padding: 0.45rem 0.65rem;
    }
    textarea {
      flex: 1;
      border: none;
      background: transparent;
      color: inherit;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 1.5rem;
      max-height: 8rem;
      outline: none;
    }
    button.send {
      border: none;
      border-radius: 999px;
      width: 2rem;
      height: 2rem;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    button.send::before {
      content: '';
      width: 1.1rem;
      height: 1.1rem;
      display: block;
      background-color: currentColor;
      mask: url('${sendIconUri}') no-repeat center / contain;
      -webkit-mask: url('${sendIconUri}') no-repeat center / contain;
    }
    button.send:disabled {
      opacity: 0.5;
      cursor: default;
    }
    button.reset {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 0.75rem;
      cursor: pointer;
      padding: 0.15rem 0.4rem;
      border-radius: 0.35rem;
    }
    button.reset:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--vscode-foreground);
    }
    .settings-container {
      position: relative;
    }
    .icon-button {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      width: 2rem;
      height: 2rem;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 1rem;
      transition: background 120ms ease, color 120ms ease;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .icon-button:hover,
    .icon-button[aria-expanded="true"] {
      background: rgba(255, 255, 255, 0.08);
      color: var(--vscode-foreground);
    }
    .settings-menu {
      position: absolute;
      right: 0;
      top: calc(100% + 0.5rem);
      display: none;
      flex-direction: column;
      gap: 0.1rem;
      min-width: 15rem;
      padding: 0.4rem 0;
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
      border-radius: 0.6rem;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
      z-index: 20;
    }
    .settings-menu.open {
      display: flex;
    }
    .settings-header {
      display: flex;
      flex-direction: column;
      gap: 0.05rem;
      padding: 0.5rem 0.9rem 0.6rem 0.9rem;
    }
    .settings-header-title {
      font-size: 0.78rem;
      font-weight: 600;
    }
    .settings-header-subtitle {
      font-size: 0.7rem;
      color: var(--vscode-descriptionForeground);
    }
    .settings-divider {
      height: 1px;
      margin: 0.25rem 0.6rem;
      background: var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
    }
    .settings-section {
      display: flex;
      flex-direction: column;
      gap: 0.8rem;
      padding: 0.4rem 0.9rem 0.7rem 0.9rem;
    }
    .settings-item {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      width: 100%;
      border: none;
      background: transparent;
      color: inherit;
      padding: 0.55rem 0.9rem;
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .settings-item:hover,
    .settings-item:focus-visible {
      background: rgba(255, 255, 255, 0.08);
      color: var(--vscode-foreground);
      outline: none;
    }
    .settings-item-icon {
      font-size: 1rem;
      line-height: 1;
      margin-top: 0.1rem;
    }
    .settings-item-text {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .settings-item-title {
      font-size: 0.82rem;
      font-weight: 500;
    }
    .settings-item-subtitle {
      font-size: 0.7rem;
      color: var(--vscode-descriptionForeground);
    }
    .busy-indicator {
      font-size: 0.75rem;
      color: var(--vscode-descriptionForeground);
      display: none;
      align-items: center;
      gap: 0.4rem;
    }
    .busy-indicator.active {
      display: inline-flex;
    }
    .busy-progress {
      font-variant-numeric: tabular-nums;
    }
    button.cancel {
      border: none;
      background: transparent;
      color: inherit;
      width: 1.6rem;
      height: 1.6rem;
      border-radius: 999px;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 0.9rem;
    }
    button.cancel.visible {
      display: inline-flex;
    }
    button.cancel:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--vscode-foreground);
    }
    @keyframes fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <header>
      <div>
        <h1>Local Ai Coder</h1>
        <span>Recent tasks</span>
      </div>
      <nav>
        <div class="busy-indicator" id="busyIndicator" aria-live="polite">
          <span class="spinner" aria-hidden="true">?</span>
          <span id="busyLabel">Working...</span>
          <span id="busyProgress" class="busy-progress"></span>
          <button type="button" class="cancel" id="cancelButton" aria-label="Cancel assistant request" aria-hidden="true">✕</button>
        </div>
        <button type="button" class="reset" id="resetButton">Reset</button>
        <div class="settings-container" id="settingsContainer">
          <button
            type="button"
            class="icon-button settings-button"
            id="settingsButton"
            aria-haspopup="true"
            aria-expanded="false"
            aria-controls="settingsMenu"
            title="Open assistant settings"
          >
            <span aria-hidden="true">⚙</span>
            <span class="sr-only">Open assistant settings</span>
          </button>
          <div class="settings-menu" id="settingsMenu" role="menu" aria-label="Assistant settings" hidden>
            <div class="settings-header">
              <span class="settings-header-title">Local Ai Coder</span>
              <span class="settings-header-subtitle">Manage preferences</span>
            </div>
            <div class="settings-section" role="none">
              <div class="control-group">
                <label class="control-label" for="approvalSelect">Agent access</label>
                <select class="control-select" id="approvalSelect">
                  <option value="requireApproval">Requires approval</option>
                  <option value="autoApprove">Full access</option>
                </select>
              </div>
              <div class="control-group">
                <label class="control-label" for="plannerModelSelect">Planning model</label>
                <select class="control-select" id="plannerModelSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="reviewerModelSelect">Reviewer model</label>
                <select class="control-select" id="reviewerModelSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="coderModelSelect">Coding model</label>
                <select class="control-select" id="coderModelSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="verifierModelSelect">Verification model</label>
                <select class="control-select" id="verifierModelSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="contextPromptSelect">Context scout prompt style</label>
                <select class="control-select" id="contextPromptSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="plannerPromptSelect">Planner prompt style</label>
                <select class="control-select" id="plannerPromptSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="reviewerPromptSelect">Reviewer prompt style</label>
                <select class="control-select" id="reviewerPromptSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="coderPromptSelect">Coder prompt style</label>
                <select class="control-select" id="coderPromptSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="qaPromptSelect">QA prompt style</label>
                <select class="control-select" id="qaPromptSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="safetyPromptSelect">Safety prompt style</label>
                <select class="control-select" id="safetyPromptSelect"></select>
              </div>
              <div class="control-group">
                <label class="control-label" for="verifierPromptSelect">Verifier prompt style</label>
                <select class="control-select" id="verifierPromptSelect"></select>
              </div>
            </div>
            <div class="settings-divider" role="separator"></div>
            <button type="button" class="settings-item" data-command="ai-code.openSettings" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">🛠</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Local Ai Coder settings</span>
                <span class="settings-item-subtitle">Configure models and context</span>
              </div>
            </button>
            <button type="button" class="settings-item" data-command="ai-code.addOllamaModel" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">➕</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Add new Ollama model</span>
                <span class="settings-item-subtitle">Download an additional model by reference</span>
              </div>
            </button>
            <button type="button" class="settings-item" data-command="ai-code.removeModel" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">➖</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Remove saved model</span>
                <span class="settings-item-subtitle">Forget a stored Ollama model reference</span>
              </div>
            </button>
            <button type="button" class="settings-item" data-command="ai-code.downloadModel" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">⬇</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Download model assets</span>
                <span class="settings-item-subtitle">Prepare the configured model locally</span>
              </div>
            </button>
            <button type="button" class="settings-item" data-command="ai-code.resetSettings" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">🔄</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Reset extension settings</span>
                <span class="settings-item-subtitle">Restore Local Ai Coder defaults</span>
              </div>
            </button>
            <div class="settings-divider" role="separator"></div>
            <button type="button" class="settings-item" data-command="workbench.action.openSettings" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">🧰</span>
              <div class="settings-item-text">
                <span class="settings-item-title">IDE settings</span>
                <span class="settings-item-subtitle">Adjust Visual Studio Code preferences</span>
              </div>
            </button>
            <button type="button" class="settings-item" data-command="workbench.action.openGlobalKeybindings" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">⌨</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Keyboard shortcuts</span>
                <span class="settings-item-subtitle">Review or customize keybindings</span>
              </div>
            </button>
            <div class="settings-divider" role="separator"></div>
            <button type="button" class="settings-item" data-command="ai-code.showLastPlan" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">🗒</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Show last plan</span>
                <span class="settings-item-subtitle">Open the most recent assistant response</span>
              </div>
            </button>
            <button type="button" class="settings-item" data-command="ai-code.resetConversation" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">♻</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Reset conversation</span>
                <span class="settings-item-subtitle">Clear the current chat history</span>
              </div>
            </button>
            <button type="button" class="settings-item" data-command="ai-code.runDebugPrompt" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">🐞</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Run debug prompt</span>
                <span class="settings-item-subtitle">Have agents draft the Hello World sample</span>
              </div>
            </button>
          </div>
        </div>
      </nav>
    </header>
    <ul class="recent-list" id="recentList"></ul>
    <div class="chat-scroll" id="chatScroll"></div>
    <form id="promptForm">
      <div class="input-row">
        <textarea id="promptInput" rows="1" placeholder="Ask Local Ai Coder to do anything"></textarea>
        <button class="send" type="submit" id="sendButton" aria-label="Send message"></button>
      </div>
    </form>
  </div>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const state = {
        entries: [],
        busy: false,
        busyLabel: 'Working...',
        busyCancellable: false,
        busyProgress: null,
        controls: {
          approvalMode: 'requireApproval',
          plannerModelId: '',
          reviewerModelId: '',
          reviewerFollowsPlanner: true,
          coderModelId: '',
          coderFollowsReviewer: true,
          verifierModelId: '',
          verifierFollowsCoder: true,
          contextScoutPromptBuilderId: '',
          contextScoutPromptFollowsPlanner: true,
          plannerPromptBuilderId: '',
          reviewerPromptBuilderId: '',
          reviewerPromptFollowsPlanner: true,
          coderPromptBuilderId: '',
          coderPromptFollowsReviewer: true,
          qaPromptBuilderId: '',
          qaPromptFollowsCoder: true,
          safetyPromptBuilderId: '',
          safetyPromptFollowsQa: true,
          verifierPromptBuilderId: '',
          verifierPromptFollowsSafety: true,
          models: [],
          promptBuilders: {
            contextScout: [],
            planner: [],
            reviewer: [],
            coder: [],
            qa: [],
            safety: [],
            verifier: [],
          },
        }
      };
      const entryElements = new Map();
      const chatScroll = document.getElementById('chatScroll');
      const promptInput = document.getElementById('promptInput');
      const promptForm = document.getElementById('promptForm');
      const sendButton = document.getElementById('sendButton');
      const busyIndicator = document.getElementById('busyIndicator');
      const busyLabelEl = document.getElementById('busyLabel');
      const busyProgressEl = document.getElementById('busyProgress');
      const cancelButton = document.getElementById('cancelButton');
      const resetButton = document.getElementById('resetButton');
      const recentList = document.getElementById('recentList');
      const approvalSelect = document.getElementById('approvalSelect');
      const plannerModelSelect = document.getElementById('plannerModelSelect');
      const reviewerModelSelect = document.getElementById('reviewerModelSelect');
      const coderModelSelect = document.getElementById('coderModelSelect');
      const verifierModelSelect = document.getElementById('verifierModelSelect');
      const contextPromptSelect = document.getElementById('contextPromptSelect');
      const plannerPromptSelect = document.getElementById('plannerPromptSelect');
      const reviewerPromptSelect = document.getElementById('reviewerPromptSelect');
      const coderPromptSelect = document.getElementById('coderPromptSelect');
      const qaPromptSelect = document.getElementById('qaPromptSelect');
      const safetyPromptSelect = document.getElementById('safetyPromptSelect');
      const verifierPromptSelect = document.getElementById('verifierPromptSelect');
      const settingsContainer = document.getElementById('settingsContainer');
      const settingsButton = document.getElementById('settingsButton');
      const settingsMenu = document.getElementById('settingsMenu');

      if (settingsButton && settingsMenu && settingsContainer) {
        const menuItems = Array.from(settingsMenu.querySelectorAll('.settings-item'));

        const isMenuOpen = () => settingsMenu.classList.contains('open');

        const focusMenuItem = (index) => {
          if (menuItems.length === 0) {
            return;
          }
          const normalized = ((index % menuItems.length) + menuItems.length) % menuItems.length;
          const element = menuItems[normalized];
          if (element && element instanceof HTMLElement) {
            element.focus();
          }
        };

        const focusFirstMenuItem = () => {
          focusMenuItem(0);
        };

        const openMenu = (focusFirst) => {
          settingsMenu.classList.add('open');
          settingsMenu.removeAttribute('hidden');
          settingsButton.setAttribute('aria-expanded', 'true');
          if (focusFirst) {
            focusFirstMenuItem();
          }
        };

        const closeMenu = () => {
          if (!isMenuOpen()) {
            return;
          }
          settingsMenu.classList.remove('open');
          settingsMenu.setAttribute('hidden', 'true');
          settingsButton.setAttribute('aria-expanded', 'false');
        };

        const toggleMenu = () => {
          if (isMenuOpen()) {
            closeMenu();
          } else {
            openMenu(false);
          }
        };

        settingsButton.addEventListener('click', event => {
          event.stopPropagation();
          toggleMenu();
        });

        settingsButton.addEventListener('keydown', event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!isMenuOpen()) {
              openMenu(true);
            } else {
              focusFirstMenuItem();
            }
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (isMenuOpen()) {
              closeMenu();
            } else {
              openMenu(true);
            }
          } else if (event.key === 'Escape' && isMenuOpen()) {
            event.preventDefault();
            closeMenu();
          }
        });

        settingsMenu.addEventListener('click', event => {
          event.stopPropagation();
        });

        document.addEventListener('click', event => {
          const target = event.target;
          if (!target || !(target instanceof Node) || !settingsContainer.contains(target)) {
            closeMenu();
          }
        });

        settingsContainer.addEventListener('focusout', event => {
          const nextTarget = event.relatedTarget;
          if (!nextTarget || !(nextTarget instanceof Node) || !settingsContainer.contains(nextTarget)) {
            closeMenu();
          }
        });

        document.addEventListener('keydown', event => {
          if (event.key === 'Escape' && isMenuOpen()) {
            closeMenu();
            settingsButton.focus();
          }
        });

        menuItems.forEach((item, index) => {
          if (!(item instanceof HTMLElement)) {
            return;
          }

          item.addEventListener('click', event => {
            event.stopPropagation();
            const command = item.getAttribute('data-command');
            if (command) {
              const args = [];
              if (command === 'ai-code.downloadModel' && state.controls.plannerModelId) {
                args.push(state.controls.plannerModelId);
              }
              vscode.postMessage({ type: 'command', command, arguments: args });
            }
            closeMenu();
            settingsButton.focus();
          });

          item.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusMenuItem(index + 1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              focusMenuItem(index - 1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              focusMenuItem(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              focusMenuItem(menuItems.length - 1);
            }
          });
        });
      }

      function renderEntries() {
        entryElements.clear();
        chatScroll.innerHTML = '';
        state.entries.forEach(entry => appendEntryElement(entry));
        scrollToBottom();
        renderRecent();
      }

      function appendEntryElement(entry) {
        if (entryElements.has(entry.id)) {
          updateEntryElement(entry);
          return;
        }
        const element = createEntryElement(entry);
        entryElements.set(entry.id, element);
        chatScroll.appendChild(element.root);
      }

      function createEntryElement(entry) {
        const root = document.createElement('div');
        root.classList.add('chat-entry', entry.role);
        root.dataset.entryId = entry.id;

        let subtitleEl = null;
        if (entry.subtitle) {
          subtitleEl = document.createElement('span');
          subtitleEl.classList.add('subtitle');
          subtitleEl.textContent = entry.subtitle;
          root.appendChild(subtitleEl);
        }

        const contentEl = renderMarkdown(entry.text);
        root.appendChild(contentEl);

        return { root, subtitleEl, contentEl };
      }

      function updateEntryElement(entry) {
        let element = entryElements.get(entry.id);
        if (!element) {
          element = createEntryElement(entry);
          entryElements.set(entry.id, element);
          chatScroll.appendChild(element.root);
          return;
        }

        element.root.className = 'chat-entry ' + entry.role;

        if (entry.subtitle) {
          if (!element.subtitleEl) {
            element.subtitleEl = document.createElement('span');
            element.subtitleEl.classList.add('subtitle');
            element.root.insertBefore(element.subtitleEl, element.root.firstChild);
          }
          element.subtitleEl.textContent = entry.subtitle;
        } else if (element.subtitleEl) {
          element.root.removeChild(element.subtitleEl);
          element.subtitleEl = null;
        }

        renderMarkdown(entry.text, element.contentEl);
      }

      function renderMarkdown(text, existing) {
        const container = existing || document.createElement('div');
        container.classList.add('chat-entry-content');
        while (container.firstChild) {
          container.removeChild(container.firstChild);
        }
        const lines = text.split(/\\n/);
        lines.forEach(line => {
          const p = document.createElement('p');
          p.textContent = line || ' ';
          if (!line.trim()) {
            p.style.height = '0.4rem';
          }
          container.appendChild(p);
        });
        return container;
      }

      const REVIEWER_INHERIT_VALUE = ${JSON.stringify(REVIEWER_INHERIT_MODEL_ID)};
      const CODER_INHERIT_VALUE = ${JSON.stringify(CODER_INHERIT_MODEL_ID)};
      const CONTEXT_PROMPT_INHERIT_VALUE = ${JSON.stringify(CONTEXT_SCOUT_PROMPT_INHERIT_ID)};
      const REVIEWER_PROMPT_INHERIT_VALUE = ${JSON.stringify(REVIEWER_PROMPT_INHERIT_ID)};
      const CODER_PROMPT_INHERIT_VALUE = ${JSON.stringify(CODER_PROMPT_INHERIT_ID)};
      const QA_PROMPT_INHERIT_VALUE = ${JSON.stringify(QA_PROMPT_INHERIT_ID)};
      const SAFETY_PROMPT_INHERIT_VALUE = ${JSON.stringify(SAFETY_PROMPT_INHERIT_ID)};
      const VERIFIER_INHERIT_VALUE = ${JSON.stringify(VERIFIER_INHERIT_MODEL_ID)};
      const VERIFIER_PROMPT_INHERIT_VALUE = ${JSON.stringify(VERIFIER_PROMPT_INHERIT_ID)};

      function ensureModelOption(select, option, seen) {
        if (!option || !option.id || seen.has(option.id)) {
          return;
        }
        seen.add(option.id);
        const opt = document.createElement('option');
        opt.value = option.id;
        opt.textContent = option.label || option.id;
        select.appendChild(opt);
      }

      function ensurePromptBuilderOption(select, option, seen) {
        if (!option || !option.id || seen.has(option.id)) {
          return;
        }
        seen.add(option.id);
        const opt = document.createElement('option');
        opt.value = option.id;
        opt.textContent = option.label || option.id;
        if (option.description) {
          opt.title = option.description;
        }
        select.appendChild(opt);
      }

      function populatePlannerSelect() {
        if (!plannerModelSelect) {
          return;
        }
        while (plannerModelSelect.firstChild) {
          plannerModelSelect.removeChild(plannerModelSelect.firstChild);
        }
        const seen = new Set();
        state.controls.models.forEach(option => ensureModelOption(plannerModelSelect, option, seen));
        if (state.controls.plannerModelId && !seen.has(state.controls.plannerModelId)) {
          ensureModelOption(
            plannerModelSelect,
            { id: state.controls.plannerModelId, label: state.controls.plannerModelId },
            seen
          );
        }
        plannerModelSelect.value = state.controls.plannerModelId || '';
      }

      function populateReviewerSelect() {
        if (!reviewerModelSelect) {
          return;
        }
        while (reviewerModelSelect.firstChild) {
          reviewerModelSelect.removeChild(reviewerModelSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = REVIEWER_INHERIT_VALUE;
        inheritOption.textContent = 'Match planner model';
        reviewerModelSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.models.forEach(option => ensureModelOption(reviewerModelSelect, option, seen));
        if (state.controls.reviewerModelId && !seen.has(state.controls.reviewerModelId)) {
          ensureModelOption(
            reviewerModelSelect,
            { id: state.controls.reviewerModelId, label: state.controls.reviewerModelId },
            seen
          );
        }

        const selectedValue = state.controls.reviewerFollowsPlanner
          ? REVIEWER_INHERIT_VALUE
          : state.controls.reviewerModelId || '';
        reviewerModelSelect.value = selectedValue;
      }

      function populateCoderSelect() {
        if (!coderModelSelect) {
          return;
        }
        while (coderModelSelect.firstChild) {
          coderModelSelect.removeChild(coderModelSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = CODER_INHERIT_VALUE;
        inheritOption.textContent = 'Match reviewer model';
        coderModelSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.models.forEach(option => ensureModelOption(coderModelSelect, option, seen));
        if (state.controls.coderModelId && !seen.has(state.controls.coderModelId)) {
          ensureModelOption(
            coderModelSelect,
            { id: state.controls.coderModelId, label: state.controls.coderModelId },
            seen
          );
        }

        const selectedValue = state.controls.coderFollowsReviewer
          ? CODER_INHERIT_VALUE
          : state.controls.coderModelId || '';
        coderModelSelect.value = selectedValue;
      }

      function populateVerifierSelect() {
        if (!verifierModelSelect) {
          return;
        }
        while (verifierModelSelect.firstChild) {
          verifierModelSelect.removeChild(verifierModelSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = VERIFIER_INHERIT_VALUE;
        inheritOption.textContent = 'Match coding model';
        verifierModelSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.models.forEach(option => ensureModelOption(verifierModelSelect, option, seen));
        if (state.controls.verifierModelId && !seen.has(state.controls.verifierModelId)) {
          ensureModelOption(
            verifierModelSelect,
            { id: state.controls.verifierModelId, label: state.controls.verifierModelId },
            seen
          );
        }

        const selectedValue = state.controls.verifierFollowsCoder
          ? VERIFIER_INHERIT_VALUE
          : state.controls.verifierModelId || '';
        verifierModelSelect.value = selectedValue;
      }

      function populateContextPromptSelect() {
        if (!contextPromptSelect) {
          return;
        }
        while (contextPromptSelect.firstChild) {
          contextPromptSelect.removeChild(contextPromptSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = CONTEXT_PROMPT_INHERIT_VALUE;
        inheritOption.textContent = 'Match planner prompt';
        contextPromptSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.promptBuilders.contextScout.forEach(option =>
          ensurePromptBuilderOption(contextPromptSelect, option, seen)
        );
        if (state.controls.contextScoutPromptBuilderId && !seen.has(state.controls.contextScoutPromptBuilderId)) {
          ensurePromptBuilderOption(
            contextPromptSelect,
            {
              id: state.controls.contextScoutPromptBuilderId,
              label: state.controls.contextScoutPromptBuilderId,
              description: '',
            },
            seen
          );
        }

        const selectedPromptValue = state.controls.contextScoutPromptFollowsPlanner
          ? CONTEXT_PROMPT_INHERIT_VALUE
          : state.controls.contextScoutPromptBuilderId || '';
        contextPromptSelect.value = selectedPromptValue;
      }

      function populatePlannerPromptSelect() {
        if (!plannerPromptSelect) {
          return;
        }
        while (plannerPromptSelect.firstChild) {
          plannerPromptSelect.removeChild(plannerPromptSelect.firstChild);
        }
        const seen = new Set();
        state.controls.promptBuilders.planner.forEach(option =>
          ensurePromptBuilderOption(plannerPromptSelect, option, seen)
        );
        if (state.controls.plannerPromptBuilderId && !seen.has(state.controls.plannerPromptBuilderId)) {
          ensurePromptBuilderOption(
            plannerPromptSelect,
            {
              id: state.controls.plannerPromptBuilderId,
              label: state.controls.plannerPromptBuilderId,
              description: '',
            },
            seen
          );
        }
        plannerPromptSelect.value = state.controls.plannerPromptBuilderId || '';
      }

      function populateReviewerPromptSelect() {
        if (!reviewerPromptSelect) {
          return;
        }
        while (reviewerPromptSelect.firstChild) {
          reviewerPromptSelect.removeChild(reviewerPromptSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = REVIEWER_PROMPT_INHERIT_VALUE;
        inheritOption.textContent = 'Match planner prompt';
        reviewerPromptSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.promptBuilders.reviewer.forEach(option =>
          ensurePromptBuilderOption(reviewerPromptSelect, option, seen)
        );
        if (state.controls.reviewerPromptBuilderId && !seen.has(state.controls.reviewerPromptBuilderId)) {
          ensurePromptBuilderOption(
            reviewerPromptSelect,
            {
              id: state.controls.reviewerPromptBuilderId,
              label: state.controls.reviewerPromptBuilderId,
              description: '',
            },
            seen
          );
        }

        const selectedPromptValue = state.controls.reviewerPromptFollowsPlanner
          ? REVIEWER_PROMPT_INHERIT_VALUE
          : state.controls.reviewerPromptBuilderId || '';
        reviewerPromptSelect.value = selectedPromptValue;
      }

      function populateCoderPromptSelect() {
        if (!coderPromptSelect) {
          return;
        }
        while (coderPromptSelect.firstChild) {
          coderPromptSelect.removeChild(coderPromptSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = CODER_PROMPT_INHERIT_VALUE;
        inheritOption.textContent = 'Match reviewer prompt';
        coderPromptSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.promptBuilders.coder.forEach(option =>
          ensurePromptBuilderOption(coderPromptSelect, option, seen)
        );
        if (state.controls.coderPromptBuilderId && !seen.has(state.controls.coderPromptBuilderId)) {
          ensurePromptBuilderOption(
            coderPromptSelect,
            {
              id: state.controls.coderPromptBuilderId,
              label: state.controls.coderPromptBuilderId,
              description: '',
            },
            seen
          );
        }

        const selectedPromptValue = state.controls.coderPromptFollowsReviewer
          ? CODER_PROMPT_INHERIT_VALUE
          : state.controls.coderPromptBuilderId || '';
        coderPromptSelect.value = selectedPromptValue;
      }

      function populateQaPromptSelect() {
        if (!qaPromptSelect) {
          return;
        }
        while (qaPromptSelect.firstChild) {
          qaPromptSelect.removeChild(qaPromptSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = QA_PROMPT_INHERIT_VALUE;
        inheritOption.textContent = 'Match coder prompt';
        qaPromptSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.promptBuilders.qa.forEach(option =>
          ensurePromptBuilderOption(qaPromptSelect, option, seen)
        );
        if (state.controls.qaPromptBuilderId && !seen.has(state.controls.qaPromptBuilderId)) {
          ensurePromptBuilderOption(
            qaPromptSelect,
            {
              id: state.controls.qaPromptBuilderId,
              label: state.controls.qaPromptBuilderId,
              description: '',
            },
            seen
          );
        }

        const selectedPromptValue = state.controls.qaPromptFollowsCoder
          ? QA_PROMPT_INHERIT_VALUE
          : state.controls.qaPromptBuilderId || '';
        qaPromptSelect.value = selectedPromptValue;
      }

      function populateSafetyPromptSelect() {
        if (!safetyPromptSelect) {
          return;
        }
        while (safetyPromptSelect.firstChild) {
          safetyPromptSelect.removeChild(safetyPromptSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = SAFETY_PROMPT_INHERIT_VALUE;
        inheritOption.textContent = 'Match QA prompt';
        safetyPromptSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.promptBuilders.safety.forEach(option =>
          ensurePromptBuilderOption(safetyPromptSelect, option, seen)
        );
        if (state.controls.safetyPromptBuilderId && !seen.has(state.controls.safetyPromptBuilderId)) {
          ensurePromptBuilderOption(
            safetyPromptSelect,
            {
              id: state.controls.safetyPromptBuilderId,
              label: state.controls.safetyPromptBuilderId,
              description: '',
            },
            seen
          );
        }

        const selectedPromptValue = state.controls.safetyPromptFollowsQa
          ? SAFETY_PROMPT_INHERIT_VALUE
          : state.controls.safetyPromptBuilderId || '';
        safetyPromptSelect.value = selectedPromptValue;
      }

      function populateVerifierPromptSelect() {
        if (!verifierPromptSelect) {
          return;
        }
        while (verifierPromptSelect.firstChild) {
          verifierPromptSelect.removeChild(verifierPromptSelect.firstChild);
        }
        const inheritOption = document.createElement('option');
        inheritOption.value = VERIFIER_PROMPT_INHERIT_VALUE;
        inheritOption.textContent = 'Match safety prompt';
        verifierPromptSelect.appendChild(inheritOption);

        const seen = new Set();
        state.controls.promptBuilders.verifier.forEach(option =>
          ensurePromptBuilderOption(verifierPromptSelect, option, seen)
        );
        if (state.controls.verifierPromptBuilderId && !seen.has(state.controls.verifierPromptBuilderId)) {
          ensurePromptBuilderOption(
            verifierPromptSelect,
            {
              id: state.controls.verifierPromptBuilderId,
              label: state.controls.verifierPromptBuilderId,
              description: '',
            },
            seen
          );
        }

        const selectedPromptValue = state.controls.verifierPromptFollowsSafety
          ? VERIFIER_PROMPT_INHERIT_VALUE
          : state.controls.verifierPromptBuilderId || '';
        verifierPromptSelect.value = selectedPromptValue;
      }

      function normalizeControls(preferences) {
        const models = Array.isArray(preferences?.models)
          ? preferences.models
              .filter(option => option && typeof option.id === 'string')
              .map(option => ({
                id: option.id,
                label: typeof option.label === 'string' && option.label.length > 0
                  ? option.label
                  : option.id,
              }))
          : [];
        const plannerModelId = typeof preferences?.plannerModelId === 'string'
          ? preferences.plannerModelId
          : '';
        let reviewerModelId = typeof preferences?.reviewerModelId === 'string'
          ? preferences.reviewerModelId
          : '';
        let reviewerFollowsPlanner = typeof preferences?.reviewerFollowsPlanner === 'boolean'
          ? preferences.reviewerFollowsPlanner
          : false;
        if (typeof preferences?.reviewerFollowsPlanner !== 'boolean') {
          reviewerFollowsPlanner = !reviewerModelId || reviewerModelId === plannerModelId;
        }
        if (reviewerFollowsPlanner) {
          reviewerModelId = plannerModelId;
        }

        let coderModelId = typeof preferences?.coderModelId === 'string'
          ? preferences.coderModelId
          : '';
        let coderFollowsReviewer = typeof preferences?.coderFollowsReviewer === 'boolean'
          ? preferences.coderFollowsReviewer
          : typeof preferences?.coderFollowsPlanner === 'boolean'
            ? preferences.coderFollowsPlanner
            : false;
        if (typeof preferences?.coderFollowsReviewer !== 'boolean') {
          coderFollowsReviewer = !coderModelId || coderModelId === reviewerModelId;
        }
        if (coderFollowsReviewer) {
          coderModelId = reviewerModelId;
        }

        let verifierModelId = typeof preferences?.verifierModelId === 'string'
          ? preferences.verifierModelId
          : '';
        let verifierFollowsCoder = typeof preferences?.verifierFollowsCoder === 'boolean'
          ? preferences.verifierFollowsCoder
          : false;
        if (typeof preferences?.verifierFollowsCoder !== 'boolean') {
          verifierFollowsCoder = !verifierModelId || verifierModelId === coderModelId;
        }
        if (verifierFollowsCoder) {
          verifierModelId = coderModelId;
        }

        function sanitizePromptBuilderList(list, role) {
          return Array.isArray(list)
            ? list
                .filter(option => option && typeof option.id === 'string')
                .map(option => ({
                  id: option.id,
                  label: typeof option.label === 'string' && option.label.length > 0
                    ? option.label
                    : option.id,
                  description: typeof option.description === 'string' ? option.description : '',
                  role,
                }))
            : [];
        }

        const promptBuilders = {
          contextScout: sanitizePromptBuilderList(preferences?.promptBuilders?.contextScout, 'contextScout'),
          planner: sanitizePromptBuilderList(preferences?.promptBuilders?.planner, 'planner'),
          reviewer: sanitizePromptBuilderList(preferences?.promptBuilders?.reviewer, 'reviewer'),
          coder: sanitizePromptBuilderList(preferences?.promptBuilders?.coder, 'coder'),
          qa: sanitizePromptBuilderList(preferences?.promptBuilders?.qa, 'qa'),
          safety: sanitizePromptBuilderList(preferences?.promptBuilders?.safety, 'safety'),
          verifier: sanitizePromptBuilderList(preferences?.promptBuilders?.verifier, 'verifier'),
        };
        const plannerPromptBuilderId = typeof preferences?.plannerPromptBuilderId === 'string'
          ? preferences.plannerPromptBuilderId
          : '';
        let contextScoutPromptBuilderId = typeof preferences?.contextScoutPromptBuilderId === 'string'
          ? preferences.contextScoutPromptBuilderId
          : '';
        let contextScoutPromptFollowsPlanner = typeof preferences?.contextScoutPromptFollowsPlanner === 'boolean'
          ? preferences.contextScoutPromptFollowsPlanner
          : false;
        if (typeof preferences?.contextScoutPromptFollowsPlanner !== 'boolean') {
          contextScoutPromptFollowsPlanner =
            !contextScoutPromptBuilderId || contextScoutPromptBuilderId === plannerPromptBuilderId;
        }
        if (contextScoutPromptFollowsPlanner) {
          contextScoutPromptBuilderId = plannerPromptBuilderId;
        }

        let reviewerPromptBuilderId = typeof preferences?.reviewerPromptBuilderId === 'string'
          ? preferences.reviewerPromptBuilderId
          : '';
        let reviewerPromptFollowsPlanner = typeof preferences?.reviewerPromptFollowsPlanner === 'boolean'
          ? preferences.reviewerPromptFollowsPlanner
          : false;
        if (typeof preferences?.reviewerPromptFollowsPlanner !== 'boolean') {
          reviewerPromptFollowsPlanner =
            !reviewerPromptBuilderId || reviewerPromptBuilderId === plannerPromptBuilderId;
        }
        if (reviewerPromptFollowsPlanner) {
          reviewerPromptBuilderId = plannerPromptBuilderId;
        }

        let coderPromptBuilderId = typeof preferences?.coderPromptBuilderId === 'string'
          ? preferences.coderPromptBuilderId
          : '';
        let coderPromptFollowsReviewer = typeof preferences?.coderPromptFollowsReviewer === 'boolean'
          ? preferences.coderPromptFollowsReviewer
          : false;
        if (typeof preferences?.coderPromptFollowsReviewer !== 'boolean') {
          coderPromptFollowsReviewer =
            !coderPromptBuilderId || coderPromptBuilderId === reviewerPromptBuilderId;
        }
        if (coderPromptFollowsReviewer) {
          coderPromptBuilderId = reviewerPromptBuilderId;
        }

        let qaPromptBuilderId = typeof preferences?.qaPromptBuilderId === 'string'
          ? preferences.qaPromptBuilderId
          : '';
        let qaPromptFollowsCoder = typeof preferences?.qaPromptFollowsCoder === 'boolean'
          ? preferences.qaPromptFollowsCoder
          : false;
        if (typeof preferences?.qaPromptFollowsCoder !== 'boolean') {
          qaPromptFollowsCoder =
            !qaPromptBuilderId || qaPromptBuilderId === coderPromptBuilderId;
        }
        if (qaPromptFollowsCoder) {
          qaPromptBuilderId = coderPromptBuilderId;
        }

        let safetyPromptBuilderId = typeof preferences?.safetyPromptBuilderId === 'string'
          ? preferences.safetyPromptBuilderId
          : '';
        let safetyPromptFollowsQa = typeof preferences?.safetyPromptFollowsQa === 'boolean'
          ? preferences.safetyPromptFollowsQa
          : false;
        if (typeof preferences?.safetyPromptFollowsQa !== 'boolean') {
          safetyPromptFollowsQa =
            !safetyPromptBuilderId || safetyPromptBuilderId === qaPromptBuilderId;
        }
        if (safetyPromptFollowsQa) {
          safetyPromptBuilderId = qaPromptBuilderId;
        }

        let verifierPromptBuilderId = typeof preferences?.verifierPromptBuilderId === 'string'
          ? preferences.verifierPromptBuilderId
          : '';
        let verifierPromptFollowsSafety = typeof preferences?.verifierPromptFollowsSafety === 'boolean'
          ? preferences.verifierPromptFollowsSafety
          : false;
        if (typeof preferences?.verifierPromptFollowsSafety !== 'boolean') {
          verifierPromptFollowsSafety =
            !verifierPromptBuilderId || verifierPromptBuilderId === safetyPromptBuilderId;
        }
        if (verifierPromptFollowsSafety) {
          verifierPromptBuilderId = safetyPromptBuilderId;
        }

        return {
          approvalMode: preferences?.approvalMode === 'autoApprove' ? 'autoApprove' : 'requireApproval',
          plannerModelId,
          reviewerModelId,
          reviewerFollowsPlanner,
          coderModelId,
          coderFollowsReviewer,
          verifierModelId,
          verifierFollowsCoder,
          contextScoutPromptBuilderId,
          contextScoutPromptFollowsPlanner,
          plannerPromptBuilderId,
          reviewerPromptBuilderId,
          reviewerPromptFollowsPlanner,
          coderPromptBuilderId,
          coderPromptFollowsReviewer,
          qaPromptBuilderId,
          qaPromptFollowsCoder,
          safetyPromptBuilderId,
          safetyPromptFollowsQa,
          verifierPromptBuilderId,
          verifierPromptFollowsSafety,
          models,
          promptBuilders,
        };
      }

      function renderControls() {
        approvalSelect.value = state.controls.approvalMode;
        populatePlannerSelect();
        populateReviewerSelect();
        populateCoderSelect();
        populateVerifierSelect();
        populateContextPromptSelect();
        populatePlannerPromptSelect();
        populateReviewerPromptSelect();
        populateCoderPromptSelect();
        populateQaPromptSelect();
        populateSafetyPromptSelect();
        populateVerifierPromptSelect();
      }

      function scrollToBottom() {
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }

      function setBusy(busy, label, options = {}) {
        state.busy = Boolean(busy);
        if (typeof label === 'string') {
          state.busyLabel = label;
        }
        state.busyCancellable = Boolean(options.cancellable);
        state.busyProgress = options.progress ?? null;
        busyIndicator.classList.toggle('active', state.busy);
        busyLabelEl.textContent = state.busyLabel;
        if (busyProgressEl) {
          if (state.busy && state.busyProgress && typeof state.busyProgress.total === 'number' && state.busyProgress.total > 0) {
            const current = Math.min(state.busyProgress.total, Math.max(0, state.busyProgress.completed));
            busyProgressEl.textContent = '(' + current + '/' + state.busyProgress.total + ')';
          } else {
            busyProgressEl.textContent = '';
          }
        }
        if (cancelButton) {
          const showCancel = state.busy && state.busyCancellable;
          cancelButton.classList.toggle('visible', showCancel);
          cancelButton.disabled = !showCancel;
          cancelButton.setAttribute('aria-hidden', showCancel ? 'false' : 'true');
        }
        promptInput.disabled = state.busy;
        sendButton.disabled = state.busy || promptInput.value.trim().length === 0;
        approvalSelect.disabled = state.busy;
        if (plannerModelSelect) {
          plannerModelSelect.disabled = state.busy;
        }
        if (reviewerModelSelect) {
          reviewerModelSelect.disabled = state.busy;
        }
        if (coderModelSelect) {
          coderModelSelect.disabled = state.busy;
        }
        if (verifierModelSelect) {
          verifierModelSelect.disabled = state.busy;
        }
        if (contextPromptSelect) {
          contextPromptSelect.disabled = state.busy;
        }
        if (plannerPromptSelect) {
          plannerPromptSelect.disabled = state.busy;
        }
        if (reviewerPromptSelect) {
          reviewerPromptSelect.disabled = state.busy;
        }
        if (coderPromptSelect) {
          coderPromptSelect.disabled = state.busy;
        }
        if (qaPromptSelect) {
          qaPromptSelect.disabled = state.busy;
        }
        if (safetyPromptSelect) {
          safetyPromptSelect.disabled = state.busy;
        }
        if (verifierPromptSelect) {
          verifierPromptSelect.disabled = state.busy;
        }
      }

      function renderRecent() {
        const recent = state.entries.filter(entry => entry.role === 'user').slice(-5).reverse();
        recentList.innerHTML = '';
        recent.forEach(entry => {
          const item = document.createElement('li');
          item.classList.add('recent-item');
          item.textContent = entry.text.length > 64 ? entry.text.slice(0, 61) + '...' : entry.text;
          item.title = entry.text;
          item.addEventListener('click', () => {
            promptInput.value = entry.text;
            promptInput.dispatchEvent(new Event('input'));
            promptInput.focus();
          });
          recentList.appendChild(item);
        });
      }

      promptInput.addEventListener('input', () => {
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 144) + 'px';
        sendButton.disabled = state.busy || promptInput.value.trim().length === 0;
      });

      promptForm.addEventListener('submit', event => {
        event.preventDefault();
        const text = promptInput.value.trim();
        if (!text || state.busy) {
          return;
        }
        vscode.postMessage({ type: 'submit', text });
        promptInput.value = '';
        promptInput.dispatchEvent(new Event('input'));
      });

      resetButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'reset' });
      });

      if (cancelButton) {
        cancelButton.addEventListener('click', () => {
          if (!state.busy || !state.busyCancellable) {
            return;
          }
          cancelButton.disabled = true;
          vscode.postMessage({ type: 'cancel' });
        });
      }

      approvalSelect.addEventListener('change', () => {
        const mode = approvalSelect.value === 'autoApprove' ? 'autoApprove' : 'requireApproval';
        state.controls.approvalMode = mode;
        vscode.postMessage({ type: 'setApprovalMode', mode });
      });

      if (plannerModelSelect) {
        plannerModelSelect.addEventListener('change', () => {
          const modelId = plannerModelSelect.value;
          state.controls.plannerModelId = modelId;
          if (state.controls.reviewerFollowsPlanner) {
            state.controls.reviewerModelId = modelId;
          }
          if (state.controls.coderFollowsReviewer) {
            state.controls.coderModelId = state.controls.reviewerModelId;
          }
          if (state.controls.verifierFollowsCoder) {
            state.controls.verifierModelId = state.controls.coderModelId;
          }
          vscode.postMessage({ type: 'setPlannerModel', modelId });
        });
      }

      if (reviewerModelSelect) {
        reviewerModelSelect.addEventListener('change', () => {
          const modelId = reviewerModelSelect.value;
          const followPlanner = modelId === REVIEWER_INHERIT_VALUE;
          state.controls.reviewerFollowsPlanner = followPlanner;
          state.controls.reviewerModelId = followPlanner ? state.controls.plannerModelId : modelId;
          if (state.controls.coderFollowsReviewer) {
            state.controls.coderModelId = state.controls.reviewerModelId;
          }
          if (state.controls.verifierFollowsCoder) {
            state.controls.verifierModelId = state.controls.coderModelId;
          }
          vscode.postMessage({ type: 'setReviewerModel', modelId });
        });
      }

      if (coderModelSelect) {
        coderModelSelect.addEventListener('change', () => {
          const modelId = coderModelSelect.value;
          const followReviewer = modelId === CODER_INHERIT_VALUE;
          state.controls.coderFollowsReviewer = followReviewer;
          state.controls.coderModelId = followReviewer ? state.controls.reviewerModelId : modelId;
          if (state.controls.verifierFollowsCoder) {
            state.controls.verifierModelId = state.controls.coderModelId;
          }
          vscode.postMessage({ type: 'setCoderModel', modelId });
        });
      }

      if (verifierModelSelect) {
        verifierModelSelect.addEventListener('change', () => {
          const modelId = verifierModelSelect.value;
          const followCoder = modelId === VERIFIER_INHERIT_VALUE;
          state.controls.verifierFollowsCoder = followCoder;
          state.controls.verifierModelId = followCoder
            ? state.controls.coderModelId
            : modelId;
          vscode.postMessage({ type: 'setVerifierModel', modelId });
        });
      }

      if (contextPromptSelect) {
        contextPromptSelect.addEventListener('change', () => {
          const builderId = contextPromptSelect.value;
          const followPlanner = builderId === CONTEXT_PROMPT_INHERIT_VALUE;
          state.controls.contextScoutPromptFollowsPlanner = followPlanner;
          state.controls.contextScoutPromptBuilderId = followPlanner
            ? state.controls.plannerPromptBuilderId
            : builderId;
          vscode.postMessage({ type: 'setContextPromptBuilder', builderId });
        });
      }

      if (plannerPromptSelect) {
        plannerPromptSelect.addEventListener('change', () => {
          const builderId = plannerPromptSelect.value;
          state.controls.plannerPromptBuilderId = builderId;
          if (state.controls.contextScoutPromptFollowsPlanner) {
            state.controls.contextScoutPromptBuilderId = builderId;
          }
          if (state.controls.reviewerPromptFollowsPlanner) {
            state.controls.reviewerPromptBuilderId = builderId;
          }
          if (state.controls.coderPromptFollowsReviewer) {
            state.controls.coderPromptBuilderId = state.controls.reviewerPromptBuilderId;
          }
          if (state.controls.qaPromptFollowsCoder) {
            state.controls.qaPromptBuilderId = state.controls.coderPromptBuilderId;
          }
          if (state.controls.safetyPromptFollowsQa) {
            state.controls.safetyPromptBuilderId = state.controls.qaPromptBuilderId;
          }
          if (state.controls.verifierPromptFollowsSafety) {
            state.controls.verifierPromptBuilderId = state.controls.safetyPromptBuilderId;
          }
          if (builderId) {
            vscode.postMessage({ type: 'setPlannerPromptBuilder', builderId });
          }
        });
      }

      if (reviewerPromptSelect) {
        reviewerPromptSelect.addEventListener('change', () => {
          const builderId = reviewerPromptSelect.value;
          const followPlanner = builderId === REVIEWER_PROMPT_INHERIT_VALUE;
          state.controls.reviewerPromptFollowsPlanner = followPlanner;
          state.controls.reviewerPromptBuilderId = followPlanner
            ? state.controls.plannerPromptBuilderId
            : builderId;
          if (state.controls.coderPromptFollowsReviewer) {
            state.controls.coderPromptBuilderId = state.controls.reviewerPromptBuilderId;
          }
          if (state.controls.qaPromptFollowsCoder) {
            state.controls.qaPromptBuilderId = state.controls.coderPromptBuilderId;
          }
          if (state.controls.safetyPromptFollowsQa) {
            state.controls.safetyPromptBuilderId = state.controls.qaPromptBuilderId;
          }
          if (state.controls.verifierPromptFollowsSafety) {
            state.controls.verifierPromptBuilderId = state.controls.safetyPromptBuilderId;
          }
          vscode.postMessage({ type: 'setReviewerPromptBuilder', builderId });
        });
      }

      if (coderPromptSelect) {
        coderPromptSelect.addEventListener('change', () => {
          const builderId = coderPromptSelect.value;
          const followReviewer = builderId === CODER_PROMPT_INHERIT_VALUE;
          state.controls.coderPromptFollowsReviewer = followReviewer;
          state.controls.coderPromptBuilderId = followReviewer
            ? state.controls.reviewerPromptBuilderId
            : builderId;
          if (state.controls.qaPromptFollowsCoder) {
            state.controls.qaPromptBuilderId = state.controls.coderPromptBuilderId;
          }
          if (state.controls.safetyPromptFollowsQa) {
            state.controls.safetyPromptBuilderId = state.controls.qaPromptBuilderId;
          }
          if (state.controls.verifierPromptFollowsSafety) {
            state.controls.verifierPromptBuilderId = state.controls.safetyPromptBuilderId;
          }
          vscode.postMessage({ type: 'setCoderPromptBuilder', builderId });
        });
      }

      if (qaPromptSelect) {
        qaPromptSelect.addEventListener('change', () => {
          const builderId = qaPromptSelect.value;
          const followCoder = builderId === QA_PROMPT_INHERIT_VALUE;
          state.controls.qaPromptFollowsCoder = followCoder;
          state.controls.qaPromptBuilderId = followCoder
            ? state.controls.coderPromptBuilderId
            : builderId;
          if (state.controls.safetyPromptFollowsQa) {
            state.controls.safetyPromptBuilderId = state.controls.qaPromptBuilderId;
            if (state.controls.verifierPromptFollowsSafety) {
              state.controls.verifierPromptBuilderId = state.controls.safetyPromptBuilderId;
            }
          }
          vscode.postMessage({ type: 'setQaPromptBuilder', builderId });
        });
      }

      if (safetyPromptSelect) {
        safetyPromptSelect.addEventListener('change', () => {
          const builderId = safetyPromptSelect.value;
          const followQa = builderId === SAFETY_PROMPT_INHERIT_VALUE;
          state.controls.safetyPromptFollowsQa = followQa;
          state.controls.safetyPromptBuilderId = followQa
            ? state.controls.qaPromptBuilderId
            : builderId;
          if (state.controls.verifierPromptFollowsSafety) {
            state.controls.verifierPromptBuilderId = state.controls.safetyPromptBuilderId;
          }
          vscode.postMessage({ type: 'setSafetyPromptBuilder', builderId });
        });
      }

      if (verifierPromptSelect) {
        verifierPromptSelect.addEventListener('change', () => {
          const builderId = verifierPromptSelect.value;
          const followSafety = builderId === VERIFIER_PROMPT_INHERIT_VALUE;
          state.controls.verifierPromptFollowsSafety = followSafety;
          state.controls.verifierPromptBuilderId = followSafety
            ? state.controls.safetyPromptBuilderId
            : builderId;
          vscode.postMessage({ type: 'setVerifierPromptBuilder', builderId });
        });
      }

      window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message !== 'object') {
          return;
        }
        switch (message.type) {
          case 'init':
            if (message.state) {
              if (Array.isArray(message.state.entries)) {
                state.entries = message.state.entries;
              }
              if (message.state.controls) {
                state.controls = normalizeControls(message.state.controls);
              }
              state.busyCancellable = Boolean(message.state.busyCancellable);
              state.busyProgress = message.state.busyProgress && typeof message.state.busyProgress === 'object'
                ? message.state.busyProgress
                : null;
              setBusy(message.state.busy, message.state.busyLabel, {
                cancellable: state.busyCancellable,
                progress: state.busyProgress,
              });
            } else {
              setBusy(false, undefined, { cancellable: false });
            }
            renderEntries();
            renderControls();
            vscode.setState(state);
            break;
          case 'append':
            if (message.entry) {
              state.entries.push(message.entry);
              appendEntryElement(message.entry);
              scrollToBottom();
              renderRecent();
              vscode.setState(state);
            }
            break;
          case 'replace':
            if (message.entry) {
              const index = state.entries.findIndex(item => item.id === message.entry.id);
              if (index >= 0) {
                state.entries[index] = message.entry;
                updateEntryElement(message.entry);
                scrollToBottom();
                renderRecent();
                vscode.setState(state);
              } else {
                state.entries.push(message.entry);
                appendEntryElement(message.entry);
                scrollToBottom();
                renderRecent();
                vscode.setState(state);
              }
            }
            break;
          case 'busy':
            setBusy(message.busy, message.label, message.options || {});
            vscode.setState(state);
            break;
          case 'error':
            if (message.message) {
              const entry = {
                id: 'notice-' + Date.now(),
                role: 'notice',
                text: message.message + (message.detail ? '\\n' + message.detail : ''),
                timestamp: Date.now()
              };
              state.entries.push(entry);
              appendEntryElement(entry);
              scrollToBottom();
              renderRecent();
              vscode.setState(state);
            }
            break;
          case 'preferences':
            if (message.preferences) {
              state.controls = normalizeControls(message.preferences);
              renderControls();
              vscode.setState(state);
            }
            break;
          default:
            break;
        }
      });

      const saved = vscode.getState();
      if (saved && Array.isArray(saved.entries)) {
        state.entries = saved.entries;
        if (saved.controls) {
          state.controls = normalizeControls(saved.controls);
        }
        state.busyCancellable = Boolean(saved.busyCancellable);
        state.busyProgress = saved.busyProgress ?? null;
        setBusy(saved.busy, saved.busyLabel, {
          cancellable: state.busyCancellable,
          progress: state.busyProgress,
        });
        renderEntries();
        renderControls();
      } else {
        setBusy(false, undefined, { cancellable: false });
        renderControls();
      }
      promptInput.dispatchEvent(new Event('input'));
    })();
  </script>
</body>
</html>`;
  }

  private createNonce(): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 24; i += 1) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }
}