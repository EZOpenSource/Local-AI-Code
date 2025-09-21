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

export interface ChatControlsState {
  readonly approvalMode: ApprovalMode;
  readonly modelId: string;
  readonly models: readonly ChatModelOption[];
}

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
    modelId: '',
    models: [],
  };
  private readonly pendingMessages: unknown[] = [];
  private readonly allowedMenuCommands = new Set<string>([
    'ai-code.openSettings',
    'ai-code.addOllamaModel',
    'ai-code.downloadModel',
    'ai-code.resetConversation',
    'ai-code.showLastPlan',
    'workbench.action.openSettings',
    'workbench.action.openGlobalKeybindings',
  ]);
  private readonly submitEmitter = new vscode.EventEmitter<string>();
  private readonly resetEmitter = new vscode.EventEmitter<void>();
  private readonly approvalModeEmitter = new vscode.EventEmitter<ApprovalMode>();
  private readonly modelEmitter = new vscode.EventEmitter<string>();
  private readonly cancelEmitter = new vscode.EventEmitter<void>();

  public readonly onDidSubmitPrompt = this.submitEmitter.event;
  public readonly onDidReset = this.resetEmitter.event;
  public readonly onDidChangeApprovalMode = this.approvalModeEmitter.event;
  public readonly onDidChangeModel = this.modelEmitter.event;
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
        case 'setModel': {
          if (typeof message.modelId === 'string' && message.modelId.trim().length > 0) {
            this.controls = {
              ...this.controls,
              modelId: message.modelId,
            };
            this.modelEmitter.fire(message.modelId);
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
    this.modelEmitter.dispose();
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
                <label class="control-label" for="modelSelect">Model</label>
                <select class="control-select" id="modelSelect"></select>
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
            <button type="button" class="settings-item" data-command="ai-code.downloadModel" role="menuitem">
              <span class="settings-item-icon" aria-hidden="true">⬇</span>
              <div class="settings-item-text">
                <span class="settings-item-title">Download model assets</span>
                <span class="settings-item-subtitle">Prepare the configured model locally</span>
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
          modelId: '',
          models: [],
        }
      };
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
      const modelSelect = document.getElementById('modelSelect');
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
              if (command === 'ai-code.downloadModel' && state.controls.modelId) {
                args.push(state.controls.modelId);
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
        chatScroll.innerHTML = '';
        state.entries.forEach(entry => appendEntryElement(entry));
        scrollToBottom();
        renderRecent();
      }

      function appendEntryElement(entry) {
        const el = document.createElement('div');
        el.classList.add('chat-entry', entry.role);
        if (entry.subtitle) {
          const subtitle = document.createElement('span');
          subtitle.classList.add('subtitle');
          subtitle.textContent = entry.subtitle;
          el.appendChild(subtitle);
        }
        el.appendChild(renderMarkdown(entry.text));
        chatScroll.appendChild(el);
      }

      function renderMarkdown(text) {
        const container = document.createElement('div');
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

      function renderControls() {
        approvalSelect.value = state.controls.approvalMode;
        while (modelSelect.firstChild) {
          modelSelect.removeChild(modelSelect.firstChild);
        }
        const seen = new Set();
        state.controls.models.forEach(option => {
          if (seen.has(option.id)) {
            return;
          }
          seen.add(option.id);
          const opt = document.createElement('option');
          opt.value = option.id;
          opt.textContent = option.label || option.id;
          modelSelect.appendChild(opt);
        });
        if (state.controls.modelId && !seen.has(state.controls.modelId)) {
          const opt = document.createElement('option');
          opt.value = state.controls.modelId;
          opt.textContent = state.controls.modelId;
          modelSelect.appendChild(opt);
          seen.add(state.controls.modelId);
        }
        modelSelect.value = state.controls.modelId;
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
        modelSelect.disabled = state.busy;
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

      modelSelect.addEventListener('change', () => {
        const modelId = modelSelect.value;
        state.controls.modelId = modelId;
        vscode.postMessage({ type: 'setModel', modelId });
      });

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
                state.controls = message.state.controls;
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
                renderEntries();
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
              state.controls = message.preferences;
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
          state.controls = saved.controls;
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