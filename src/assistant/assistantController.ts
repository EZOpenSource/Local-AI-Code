import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { AssistantPlan, AssistantRequest, ShellCommandRequest, ConversationMessage } from '../types';
import { ContextCollector, ContextCollectorOptions } from './contextCollector';
import { ConversationManager } from './conversationManager';
import { FileActionExecutor } from './fileActionExecutor';
import { LocalModel, GenerationConfig } from './localModel';
import { buildPrompt } from './promptBuilder';
import { ResponseParser } from './responseParser';
import { ShellExecutor } from './shellExecutor';
import {
  ChatViewProvider,
  ChatEntry,
  ApprovalMode,
  ChatControlsState,
  ChatModelOption,
  BusyOptions,
} from '../chatViewProvider';

const DEFAULT_MODEL_ID = 'ollama:qwen3:4b';

interface AssistantConfiguration extends GenerationConfig {
  context: ContextCollectorOptions;
  allowCommandExecution: boolean;
  shell: string;
}

export class AssistantController {
  private readonly output: vscode.OutputChannel;
  private readonly conversation = new ConversationManager();
  private readonly parser = new ResponseParser();
  private readonly model = new LocalModel();
  private readonly shellExecutor: ShellExecutor;
  private readonly fileActionExecutor: FileActionExecutor;
  private chatView: ChatViewProvider | null = null;
  private chatDisposables: vscode.Disposable[] = [];
  private lastPlan: AssistantPlan | null = null;
  private lastUserPrompt: string | null = null;
  private lastRawResponse: string | null = null;
  private isBusy = false;
  private messageCounter = 0;
  private approvalMode: ApprovalMode = 'requireApproval';
  private readonly approvalModeStorageKey = 'ai-code.approvalMode';
  private readonly knownModelsStorageKey = 'ai-code.knownModels';
  private knownModels = new Set<string>();
  private readonly conversationStorageKey = 'ai-code.conversationHistory';
  private chatBusyState: { busy: boolean; label?: string; options?: BusyOptions } = { busy: false };
  private currentRun: { tokenSource: vscode.CancellationTokenSource; origin: 'command' | 'chat' } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Local Ai Coder');
    this.shellExecutor = new ShellExecutor(this.output);
    this.fileActionExecutor = new FileActionExecutor(this.output);
    const storedMode = this.context.globalState.get<ApprovalMode>(this.approvalModeStorageKey);
    if (storedMode === 'autoApprove') {
      this.approvalMode = storedMode;
    }
    const storedModels = this.context.globalState.get<string[]>(this.knownModelsStorageKey, []);
    for (const modelId of storedModels) {
      if (typeof modelId === 'string') {
        const trimmed = modelId.trim();
        if (trimmed && this.isOllamaModelId(trimmed)) {
          this.knownModels.add(trimmed);
        }
      }
    }

    const storedConversation = this.context.globalState.get<ConversationMessage[]>(
      this.conversationStorageKey,
      []
    );
    if (Array.isArray(storedConversation) && storedConversation.length > 0) {
      this.conversation.load(storedConversation);
    }
  }

  public register(): void {
    this.context.subscriptions.push(
      this.output,
      vscode.commands.registerCommand('ai-code.askAssistant', () => this.handleAskAssistant()),
      vscode.commands.registerCommand('ai-code.resetConversation', () => this.handleResetConversation()),
      vscode.commands.registerCommand('ai-code.showLastPlan', () => this.handleShowLastPlan()),
      vscode.commands.registerCommand('ai-code.addOllamaModel', () => this.handleAddOllamaModel()),
      vscode.commands.registerCommand('ai-code.downloadModel', (modelId?: unknown) =>
        this.handleDownloadModel(typeof modelId === 'string' ? modelId : undefined)
      )
    );
  }

  public registerChatView(provider: ChatViewProvider): void {
    this.chatDisposables.forEach(disposable => disposable.dispose());
    this.chatDisposables = [];
    this.chatView = provider;

    const disposables = [
      provider.onDidSubmitPrompt(prompt => {
        void this.handleChatPrompt(prompt);
      }),
      provider.onDidReset(() => {
        this.resetConversation(false);
      }),
      provider.onDidChangeApprovalMode(mode => {
        void this.handleApprovalModeChange(mode);
      }),
      provider.onDidChangeModel(modelId => {
        void this.handleModelSelection(modelId);
      }),
      provider.onDidCancel(() => {
        void this.handleCancelRequest();
      }),
    ];

    this.chatDisposables.push(...disposables);
    this.context.subscriptions.push(...disposables);

    provider.load(this.buildChatEntriesFromHistory());
    void this.refreshChatPreferences();
    this.messageCounter = this.conversation.getHistory().length;
    if (this.chatBusyState.busy) {
      provider.setBusy(true, this.chatBusyState.label, this.chatBusyState.options);
    } else {
      provider.setBusy(false);
    }
  }

  private setChatBusy(busy: boolean, label?: string, options?: BusyOptions): void {
    this.chatBusyState = { busy, label, options };
    if (this.chatView) {
      this.chatView.setBusy(busy, label, options);
    }
  }

  private updateChatBusy(label: string, options?: BusyOptions): void {
    if (this.currentRun?.origin !== 'chat') {
      return;
    }
    const token = this.currentRun.tokenSource.token;
    const combined: BusyOptions = {
      cancellable: options?.cancellable ?? !token.isCancellationRequested,
      progress: options?.progress ?? null,
    };
    this.setChatBusy(true, label, combined);
  }

  private clearChatBusy(): void {
    this.setChatBusy(false);
  }

  private async handleAskAssistant(): Promise<void> {
    if (this.isBusy) {
      void vscode.window.showInformationMessage('The assistant is already processing a request.');
      return;
    }
    const prompt = await vscode.window.showInputBox({
      prompt: 'What can Local Ai Coder help you with?',
      placeHolder: 'Describe a task or ask a question',
      ignoreFocusOut: true,
    });
    if (!prompt || prompt.trim().length === 0) {
      return;
    }
    await this.runAssistant(prompt.trim(), 'command');
  }

  private async handleChatPrompt(prompt: string): Promise<void> {
    if (this.isBusy) {
      this.chatView?.addNotice('The assistant is already processing a request. Please wait.');
      return;
    }
    const entry: ChatEntry = {
      id: this.nextMessageId('user'),
      role: 'user',
      text: prompt,
      timestamp: Date.now(),
    };
    this.chatView?.append(entry);
    await this.runAssistant(prompt, 'chat');
  }

  private handleCancelRequest(): void {
    if (!this.currentRun) {
      this.chatView?.addNotice('No active assistant request to cancel.');
      return;
    }
    const { tokenSource, origin } = this.currentRun;
    if (origin !== 'chat') {
      this.chatView?.addNotice('Only chat requests can be cancelled.');
      return;
    }
    if (tokenSource.token.isCancellationRequested) {
      return;
    }
    this.log('Cancellation requested by user.');
    this.updateChatBusy('Cancelling...', { cancellable: false });
    tokenSource.cancel();
  }

  private async runAssistant(prompt: string, origin: 'command' | 'chat'): Promise<void> {
    this.isBusy = true;
    const tokenSource = new vscode.CancellationTokenSource();
    this.currentRun = { tokenSource, origin };
    if (origin === 'command') {
      this.output.show(true);
    }
    this.log(`User prompt: ${prompt}`);
    if (origin === 'chat') {
      this.chatView?.show();
      this.updateChatBusy('Collecting workspace context...', { cancellable: true });
    }
    try {
      const config = await this.getConfiguration();
      void this.refreshChatPreferences(config);
      this.log('Collecting workspace context...');
      const collector = new ContextCollector(config.context);
      const context = await collector.collect(tokenSource.token);
      if (origin === 'chat') {
        this.updateChatBusy('Loading model...', { cancellable: true });
      }
      await this.prepareModel(config, tokenSource.token, origin !== 'chat');
      if (origin === 'chat') {
        this.updateChatBusy('Generating response...', { cancellable: true });
      }
      const request: AssistantRequest = {
        prompt,
        context,
        history: this.conversation.getHistory(),
      };
      const rawResponse = await this.invokeModel(request, config, tokenSource.token);
      const plan = this.parser.parse(rawResponse);
      this.lastPlan = plan;
      this.lastUserPrompt = prompt;
      this.lastRawResponse = rawResponse;
      this.conversation.push('user', prompt);
      this.conversation.push('assistant', plan.message);
      await this.saveConversation();
      this.logPlan(plan);
      if (origin === 'chat') {
        const assistantEntry: ChatEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: this.renderPlanForChat(plan),
          subtitle: plan.summary,
          timestamp: Date.now(),
        };
        this.chatView?.append(assistantEntry);
      } else {
        const summaryForUi = this.formatSummary(plan.summary);
        void vscode.window.showInformationMessage(`Assistant: ${summaryForUi}`, 'Show details').then(choice => {
          if (choice === 'Show details') {
            this.output.show(true);
          }
        });
      }
      if (origin === 'chat' && (plan.commandRequests.length > 0 || plan.fileActions.length > 0)) {
        this.updateChatBusy('Applying plan actions...', { cancellable: true });
      }
      await this.processPlan(plan, config, tokenSource.token, origin);
    } catch (error) {
      if (this.isCancellationError(error)) {
        this.log('Assistant request cancelled.');
        if (origin === 'chat') {
          this.chatView?.addNotice('Assistant request cancelled.');
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Assistant error: ${message}`);
        void vscode.window.showErrorMessage(`Local Ai Coder failed: ${message}`);
        if (origin === 'chat') {
          this.chatView?.addNotice(`Assistant error: ${message}`);
        }
      }
    } finally {
      tokenSource.dispose();
      this.currentRun = null;
      this.isBusy = false;
      if (origin === 'chat') {
        this.clearChatBusy();
      }
    }
  }

  private async prepareModel(
    config: AssistantConfiguration,
    token?: vscode.CancellationToken,
    showNotification = true
  ): Promise<void> {
    if (this.model.isLoaded(config.modelId)) {
      return;
    }
    if (showNotification) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading model ${config.modelId}`,
          cancellable: true,
        },
        async (progress, progressToken) => {
          const combinedSource = new vscode.CancellationTokenSource();
          const disposables: vscode.Disposable[] = [];
          if (token) {
            disposables.push(token.onCancellationRequested(() => combinedSource.cancel()));
          }
          disposables.push(progressToken.onCancellationRequested(() => combinedSource.cancel()));
          try {
            await this.model.ensureLoaded(
              config,
              status => {
                progress.report({ message: status });
                this.log(status);
              },
              combinedSource.token
            );
          } finally {
            disposables.forEach(disposable => disposable.dispose());
            combinedSource.dispose();
          }
        }
      );
    } else {
      await this.model.ensureLoaded(
        config,
        status => {
          this.log(status);
        },
        token
      );
    }
    this.log(`Model ready: ${config.modelId}`);
  }

  private async invokeModel(
    request: AssistantRequest,
    config: AssistantConfiguration,
    token: vscode.CancellationToken
  ): Promise<string> {
    const prompt = buildPrompt(request);
    let streamed = '';
    const generated = await this.model.generate(
      prompt,
      config,
      chunk => {
        streamed += chunk;
      },
      token
    );
    const response = streamed || generated;
    const trimmed = response.trim();
    if (!trimmed) {
      throw new Error('Assistant returned an empty response.');
    }
    return trimmed;
  }

  private async processPlan(
    plan: AssistantPlan,
    config: AssistantConfiguration,
    token: vscode.CancellationToken,
    origin: 'command' | 'chat'
  ): Promise<void> {
    await this.processCommandRequests(plan.commandRequests, config, token, origin);
    if (plan.fileActions.length === 0) {
      return;
    }
    this.log(`Processing ${plan.fileActions.length} proposed file action(s).`);
    await this.fileActionExecutor.apply(plan.fileActions, {
      requireApproval: this.approvalMode !== 'autoApprove',
      token,
      onProgress: progress => {
        if (origin !== 'chat') {
          return;
        }
        const label =
          progress.stage === 'start'
            ? `Applying file action ${progress.index + 1} of ${progress.total}: ${progress.action.type.toUpperCase()} ${progress.action.path}`
            : `Applied file action ${progress.index + 1} of ${progress.total}`;
        const completed = progress.stage === 'complete' ? progress.index + 1 : progress.index;
        this.updateChatBusy(label, {
          progress: { completed, total: progress.total },
        });
      },
    });
    if (origin === 'chat') {
      this.updateChatBusy('Plan actions complete', {
        progress: { completed: plan.fileActions.length, total: plan.fileActions.length },
      });
    }
  }

  private async processCommandRequests(
    requests: ShellCommandRequest[],
    config: AssistantConfiguration,
    token: vscode.CancellationToken,
    origin: 'command' | 'chat'
  ): Promise<void> {
    if (requests.length === 0) {
      return;
    }
    if (!config.allowCommandExecution) {
      for (const request of requests) {
        this.log(`Command execution disabled - skipping: ${request.command}`);
      }
      return;
    }
    const autoApprove = this.approvalMode === 'autoApprove';
    for (let index = 0; index < requests.length; index += 1) {
      this.throwIfCancelled(token);
      const request = requests[index];
      if (origin === 'chat') {
        this.updateChatBusy(`Running command ${index + 1} of ${requests.length}: ${request.command}`, {
          progress: { completed: index, total: requests.length },
        });
      }
      try {
        const result = autoApprove
          ? await this.shellExecutor.runWithoutApproval(request, config.shell, token)
          : await this.shellExecutor.runWithApproval(request, config.shell, token);
        if (result) {
          this.log(`Command completed: ${request.command}`);
        } else if (!autoApprove) {
          this.log(`Command was not approved: ${request.command}`);
        }
      } catch (error) {
        if (this.isCancellationError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Command failed: ${request.command} (${message})`);
        void vscode.window.showErrorMessage(`Command failed: ${request.command}`);
      }
      if (origin === 'chat') {
        this.updateChatBusy(`Finished command ${index + 1} of ${requests.length}`, {
          progress: { completed: index + 1, total: requests.length },
        });
      }
    }
  }

  private handleResetConversation(): void {
    this.resetConversation(true);
  }

  private handleShowLastPlan(): void {
    if (!this.lastPlan) {
      void vscode.window.showInformationMessage('No assistant response available yet.');
      return;
    }
    this.output.show(true);
    this.log('--- Last assistant interaction ---');
    if (this.lastUserPrompt) {
      this.log(`Prompt: ${this.lastUserPrompt}`);
    }
    this.log(`Summary: ${this.lastPlan.summary}`);
    this.log('Message:');
    this.output.appendLine(this.lastPlan.message);
    if (this.lastPlan.commandRequests.length > 0) {
      this.log('Command requests:');
      for (const command of this.lastPlan.commandRequests) {
        this.log(`- ${command.command}${command.description ? ` (${command.description})` : ''}`);
      }
    }
    if (this.lastPlan.fileActions.length > 0) {
      this.log('File actions:');
      for (const action of this.lastPlan.fileActions) {
        this.log(`- ${action.type} ${action.path}`);
      }
    }
    if (this.lastRawResponse) {
      this.log('Raw assistant payload preserved in memory.');
    }
  }

  private async handleAddOllamaModel(): Promise<void> {
    const reference = await vscode.window.showInputBox({
      prompt: 'Enter the Ollama model reference to download (e.g. codellama:7b)',
      placeHolder: 'codellama:7b',
      ignoreFocusOut: true,
      validateInput: value => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Provide an Ollama model reference.';
        }
        if (/\s/.test(trimmed)) {
          return 'Model references cannot contain spaces.';
        }
        return null;
      },
    });

    if (!reference) {
      return;
    }

    const normalizedId = this.resolveModelId(reference);
    const modelName = normalizedId.slice('ollama:'.length);

    try {
      const modelReference = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${modelName} via Ollama`,
          cancellable: false,
        },
        async progress =>
          this.ensureOllamaModel(modelName, message => {
            progress.report({ message });
            this.log(message);
          })
      );

      this.recordKnownModel(modelReference);
      void this.refreshChatPreferences();
      void vscode.window.showInformationMessage(
        `Model ${modelName} downloaded. Select it from the model picker to use it.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to add Ollama model: ${message}`);
      void vscode.window.showErrorMessage(`Failed to add Ollama model: ${message}`);
    }
  }

  private async handleDownloadModel(requestedModelId?: string): Promise<void> {
    try {
      const config = await this.getConfiguration();
      const trimmedRequest = typeof requestedModelId === 'string' ? requestedModelId.trim() : '';
      const targetModelId = trimmedRequest ? this.resolveModelId(trimmedRequest) : config.modelId;
      const modelName = targetModelId.replace(/^ollama:/i, '').replace(/^\/\//, '');
      if (!modelName) {
        throw new Error('No Ollama model selected. Choose a model in the assistant settings first.');
      }

      const modelReference = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing ${modelName} model via Ollama`,
          cancellable: false,
        },
        async progress =>
          this.ensureOllamaModel(modelName, message => {
            progress.report({ message });
            this.log(message);
          })
      );

      this.recordKnownModel(modelReference);
      if (config.modelId !== modelReference) {
        try {
          await vscode.workspace
            .getConfiguration('ai-code')
            .update('modelId', modelReference, vscode.ConfigurationTarget.Global);
          this.log(`Updated ai-code.modelId setting to ${modelReference}`);
        } catch (updateError) {
          const reason = updateError instanceof Error ? updateError.message : String(updateError);
          this.log(`Failed to update ai-code.modelId setting: ${reason}`);
        }
      }

      const updatedConfig: AssistantConfiguration = { ...config, modelId: modelReference };
      await this.prepareModel(updatedConfig);
      void this.refreshChatPreferences(updatedConfig);
      const label = this.describeModel(modelReference);
      void vscode.window.showInformationMessage(`Model ${label} is ready.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to prepare model: ${message}`);
      void vscode.window.showErrorMessage(`Failed to prepare model: ${message}`);
    }
  }

  private async getConfiguration(): Promise<AssistantConfiguration> {
    const config = vscode.workspace.getConfiguration('ai-code');
    const excludeGlobsSetting = config.get<unknown>('context.excludeGlobs');
    const excludeGlobs = Array.isArray(excludeGlobsSetting)
      ? (excludeGlobsSetting.filter(item => typeof item === 'string') as string[])
      : [];
    const overrideExcludes = config.get('context.overrideDefaultExcludes', false);
    const contextOptions: ContextCollectorOptions = {
      maxFiles: config.get('context.maxFiles', 40),
      maxFileSize: config.get('context.maxFileSize', 200000),
      maxTotalSize: config.get('context.maxTotalSize', 1500000),
      includeBinary: config.get('context.includeBinary', false),
      excludeGlobs,
      useDefaultExcludes: !overrideExcludes,
      prioritizeChangedFiles: config.get('context.prioritizeChangedFiles', true),
    };
    const configuredModelId = config.get('modelId', DEFAULT_MODEL_ID);
    const resolvedModelId = this.resolveModelId(configuredModelId);
    this.recordKnownModel(resolvedModelId);

    return {
      modelId: resolvedModelId,
      maxNewTokens: config.get('maxNewTokens', 512),
      temperature: config.get('temperature', 0.2),
      topP: config.get('sampling.topP', 0.95),
      repetitionPenalty: config.get('sampling.repetitionPenalty', 1.05),
      requestTimeoutMs: config.get('ollama.requestTimeoutMs', 30000),
      generationTimeoutMs: config.get('ollama.generationTimeoutMs', 120000),
      context: contextOptions,
      allowCommandExecution: config.get('allowCommandExecution', true),
      shell: config.get('shell', 'default'),
    };
  }

  private resolveModelId(modelId: unknown): string {
    if (typeof modelId !== 'string') {
      return DEFAULT_MODEL_ID;
    }
    const trimmed = modelId.trim();
    if (!trimmed) {
      return DEFAULT_MODEL_ID;
    }
    if (this.isOllamaModelId(trimmed)) {
      return trimmed;
    }
    return `ollama:${trimmed}`;
  }

  private isOllamaModelId(value: string): boolean {
    return /^ollama:/i.test(value.trim());
  }

  private async ensureOllamaModel(modelName: string, report?: (message: string) => void): Promise<string> {
    const update = (message: string) => {
      if (report) {
        report(message);
      } else {
        this.log(message);
      }
    };

    update('Checking for Ollama CLI...');
    await this.runCommand('ollama', ['--version']).catch(error => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to locate Ollama CLI. Ensure Ollama is installed and on your PATH. (${reason})`);
    });

    update(`Pulling ${modelName} via Ollama ...`);
    await this.runCommand('ollama', ['pull', modelName]);

    update('Ollama model ready.');
    return `ollama:${modelName}`;
  }

  private async runCommand(
    command: string,
    args: readonly string[],
    options: { cwd?: string } = {}
  ): Promise<void> {
    const rendered = `$ ${command} ${args.join(' ')}`.trim();
    this.log(rendered);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: process.env,
        shell: false,
      });

      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', data => this.output.append(data));
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', data => this.output.append(data));
      }
      child.on('error', error => {
        reject(error);
      });
      child.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });
    });
  }

  private async handleApprovalModeChange(mode: ApprovalMode): Promise<void> {
    const normalized: ApprovalMode = mode === 'autoApprove' ? 'autoApprove' : 'requireApproval';
    if (normalized === this.approvalMode) {
      return;
    }
    this.approvalMode = normalized;
    await this.context.globalState.update(this.approvalModeStorageKey, this.approvalMode);
    const notice = normalized === 'autoApprove'
      ? 'Agent approval set to full access. Commands will execute automatically.'
      : 'Agent approval set to manual confirmation.';
    this.log(notice);
    this.chatView?.addNotice(notice);
    await this.refreshChatPreferences();
  }

  private async handleModelSelection(modelId: string): Promise<void> {
    const trimmed = modelId.trim();
    if (!trimmed) {
      return;
    }
    const normalized = this.resolveModelId(trimmed);
    const config = vscode.workspace.getConfiguration('ai-code');
    const current = config.get('modelId');
    if (typeof current === 'string' && this.resolveModelId(current) === normalized) {
      await this.refreshChatPreferences();
      return;
    }
    await config.update('modelId', normalized, vscode.ConfigurationTarget.Workspace);
    this.recordKnownModel(normalized);
    const updatedConfig = await this.getConfiguration();
    const label = this.describeModel(updatedConfig.modelId);
    this.log(`Model updated to ${updatedConfig.modelId}.`);
    this.chatView?.addNotice(`Using model ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async refreshChatPreferences(config?: AssistantConfiguration): Promise<void> {
    if (!this.chatView) {
      return;
    }
    const effectiveConfig = config ?? (await this.getConfiguration());
    const models = await this.discoverModelOptions(effectiveConfig.modelId);
    const controls: ChatControlsState = {
      approvalMode: this.approvalMode,
      modelId: effectiveConfig.modelId,
      models,
    };
    this.chatView.setPreferences(controls);
  }

  private async discoverModelOptions(currentModelId: string): Promise<ChatModelOption[]> {
    const candidates = new Set<string>();
    const addCandidate = (value: string | undefined | null) => {
      if (typeof value !== 'string') {
        return;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      const normalized = this.resolveModelId(trimmed);
      candidates.add(normalized);
    };
    addCandidate(currentModelId);
    addCandidate(DEFAULT_MODEL_ID);
    for (const model of this.knownModels) {
      addCandidate(model);
    }
    const options: ChatModelOption[] = Array.from(candidates).map(id => ({
      id,
      label: this.describeModel(id),
    }));
    options.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return options;
  }

  private describeModel(modelId: string): string {
    const normalized = this.resolveModelId(modelId);
    return `Ollama: ${normalized.slice('ollama:'.length)}`;
  }

  private recordKnownModel(modelId: string): void {
    const normalized = this.resolveModelId(modelId);
    if (!this.knownModels.has(normalized)) {
      this.knownModels.add(normalized);
      const snapshot = Array.from(this.knownModels).slice(-20);
      this.knownModels = new Set(snapshot);
      void this.context.globalState.update(this.knownModelsStorageKey, snapshot);
    }
  }

  private resetConversation(showNotification: boolean): void {
    if (this.isBusy) {
      const message = 'Cannot reset while a request is running.';
      void vscode.window.showInformationMessage(message);
      this.chatView?.addNotice(message);
      return;
    }
    this.conversation.reset();
    void this.saveConversation();
    this.lastPlan = null;
    this.lastUserPrompt = null;
    this.lastRawResponse = null;
    this.messageCounter = 0;
    this.log('Conversation history cleared.');
    if (this.chatView) {
      this.clearChatBusy();
      this.chatView.load([]);
      this.chatView.addNotice('Conversation cleared.');
    }
    if (showNotification) {
      void vscode.window.showInformationMessage('Local Ai Coder conversation reset.');
    }
  }

  private nextMessageId(prefix: string): string {
    this.messageCounter += 1;
    return `${prefix}-${Date.now()}-${this.messageCounter}`;
  }

  private buildChatEntriesFromHistory(): ChatEntry[] {
    const now = Date.now();
    return this.conversation.getHistory().map((message, index) => ({
      id: `${message.role}-${now}-${index}`,
      role: message.role === 'system' ? 'notice' : message.role,
      text: message.content,
      timestamp: now + index,
    }));
  }

  private async saveConversation(): Promise<void> {
    try {
      await this.context.globalState.update(this.conversationStorageKey, this.conversation.getHistory());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`Failed to persist conversation history: ${reason}`);
    }
  }

  private renderPlanForChat(plan: AssistantPlan): string {
    const sections: string[] = [];
    const trimmed = plan.message.trim();
    if (trimmed.length > 0) {
      sections.push(trimmed);
    }
    if (plan.steps.length > 0) {
      const steps = plan.steps
        .map((step, index) => {
          const prefix = `${index + 1}. ${step.title}`;
          const segments = [prefix];
          if (step.detail) {
            segments.push(step.detail);
          }
          if (step.result) {
            segments.push(`Result: ${step.result}`);
          }
          return segments.join(' — ');
        })
        .join('\n');
      sections.push(`Plan steps:\n${steps}`);
    }
    if (plan.commandRequests.length > 0) {
      const commands = plan.commandRequests
        .map(command => `- ${command.command}${command.description ? ` - ${command.description}` : ''}`)
        .join('\n');
      sections.push(`Commands:\n${commands}`);
    }
    if (plan.fileActions.length > 0) {
      const actions = plan.fileActions
        .map(action => `- ${action.type.toUpperCase()} ${action.path}${action.description ? ` - ${action.description}` : ''}`)
        .join('\n');
      sections.push(`File actions:\n${actions}`);
    }
    if (plan.liveLog.length > 0) {
      const logEntries = plan.liveLog.map(entry => `- ${entry}`).join('\n');
      sections.push(`Live log:\n${logEntries}`);
    }
    if (plan.qaFindings.length > 0) {
      const qaEntries = plan.qaFindings.map(entry => `- ${entry}`).join('\n');
      sections.push(`QA findings:\n${qaEntries}`);
    }
    if (plan.testResults.length > 0) {
      const testEntries = plan.testResults.map(entry => `- ${entry}`).join('\n');
      sections.push(`Test results:\n${testEntries}`);
    }
    return sections.join('\n\n');
  }
  private formatSummary(summary: string): string {
    const trimmed = summary.trim();
    if (trimmed.length <= 80) {
      return trimmed;
    }
    return `${trimmed.slice(0, 77)}...`;
  }

  private throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }

  private isCancellationError(error: unknown): boolean {
    if (error instanceof vscode.CancellationError) {
      return true;
    }
    return error instanceof Error && (error.name === 'Canceled' || error.message === 'Canceled');
  }

  private log(message: string): void {
    if (!message) {
      this.output.appendLine('');
      return;
    }
    const timestamp = new Date().toISOString();
    this.output.appendLine(`[${timestamp}] ${message}`);
  }

  private logPlan(plan: AssistantPlan): void {
    this.log('--- Assistant plan ---');
    this.log(`Summary: ${plan.summary}`);
    this.log('Message:');
    this.output.appendLine(plan.message);
    if (plan.steps.length > 0) {
      this.log('Plan steps:');
      plan.steps.forEach((step, index) => {
        const prefix = `${index + 1}. ${step.title}`;
        const segments = [prefix];
        if (step.detail) {
          segments.push(step.detail);
        }
        if (step.result) {
          segments.push(`Result: ${step.result}`);
        }
        this.log(`- ${segments.join(' — ')}`);
      });
    } else {
      this.log('Plan steps: none');
    }
    if (plan.liveLog.length > 0) {
      this.log('Live log entries:');
      plan.liveLog.forEach(entry => {
        this.log(`- ${entry}`);
      });
    } else {
      this.log('Live log entries: none');
    }
    if (plan.qaFindings.length > 0) {
      this.log('QA findings:');
      plan.qaFindings.forEach(entry => {
        this.log(`- ${entry}`);
      });
    } else {
      this.log('QA findings: none');
    }
    if (plan.testResults.length > 0) {
      this.log('Test results:');
      plan.testResults.forEach(entry => {
        this.log(`- ${entry}`);
      });
    } else {
      this.log('Test results: none');
    }
    if (plan.commandRequests.length > 0) {
      this.log('Command requests:');
      for (const command of plan.commandRequests) {
        this.log(`- ${command.command}${command.description ? ` (${command.description})` : ''}`);
      }
    } else {
      this.log('Command requests: none');
    }
    if (plan.fileActions.length > 0) {
      this.log('File actions:');
      for (const action of plan.fileActions) {
        this.log(`- ${action.type} ${action.path}`);
      }
    } else {
      this.log('File actions: none');
    }
  }
}

































