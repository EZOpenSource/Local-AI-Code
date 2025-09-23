import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { AssistantPlan, AssistantRequest, ShellCommandRequest, ConversationMessage } from '../types';
import { ContextCollector, ContextCollectorOptions } from './contextCollector';
import { ConversationManager } from './conversationManager';
import { FileActionExecutor } from './fileActionExecutor';
import { LocalModel, GenerationConfig } from './localModel';
import {
  DEFAULT_CONTEXT_SCOUT_PROMPT_BUILDER_ID,
  DEFAULT_CODER_PROMPT_BUILDER_ID,
  DEFAULT_PLANNER_PROMPT_BUILDER_ID,
  DEFAULT_QA_PROMPT_BUILDER_ID,
  DEFAULT_REVIEWER_PROMPT_BUILDER_ID,
  DEFAULT_SAFETY_PROMPT_BUILDER_ID,
  DEFAULT_VERIFIER_PROMPT_BUILDER_ID,
  describePromptBuilder,
  getContextScoutPromptBuilderById,
  getCoderPromptBuilderById,
  getPlannerPromptBuilderById,
  getQaPromptBuilderById,
  getReviewerPromptBuilderById,
  getSafetyPromptBuilderById,
  getVerifierPromptBuilderById,
  listPromptBuilderOptionsByRole,
  normalizePromptBuilderIdForRole,
} from './promptBuilders';
import type { PromptBuilderRole, PromptBuilderOption } from './promptBuilders/types';
import { ResponseParser } from './responseParser';
import { ShellExecutor } from './shellExecutor';
import {
  ChatViewProvider,
  ChatEntry,
  ApprovalMode,
  ChatControlsState,
  ChatModelOption,
  ChatPromptBuilderGroups,
  BusyOptions,
  REVIEWER_INHERIT_MODEL_ID,
  CODER_INHERIT_MODEL_ID,
  CODER_PROMPT_INHERIT_ID,
  CONTEXT_SCOUT_PROMPT_INHERIT_ID,
  QA_PROMPT_INHERIT_ID,
  REVIEWER_PROMPT_INHERIT_ID,
  SAFETY_PROMPT_INHERIT_ID,
  VERIFIER_INHERIT_MODEL_ID,
  VERIFIER_PROMPT_INHERIT_ID,
} from '../chatViewProvider';

const DEFAULT_MODEL_ID = 'ollama:qwen3:4b';
const SAMPLING_ROLES: readonly PromptBuilderRole[] = [
  'contextScout',
  'planner',
  'reviewer',
  'coder',
  'qa',
  'safety',
  'verifier',
] as const;

type RoleSamplingConfig = Record<PromptBuilderRole, RoleSamplingOverrides>;

interface RoleSamplingOverrides {
  temperature: number;
  topP: number;
  repetitionPenalty: number;
}

interface AssistantConfiguration extends GenerationConfig {
  collaboratorModelId: string;
  coderModelId: string;
  verifierModelId: string;
  contextScoutPromptBuilderId: string;
  plannerPromptBuilderId: string;
  reviewerPromptBuilderId: string;
  coderPromptBuilderId: string;
  qaPromptBuilderId: string;
  safetyPromptBuilderId: string;
  verifierPromptBuilderId: string;
  showCollaborationLiveStream: boolean;
  context: ContextCollectorOptions;
  allowCommandExecution: boolean;
  shell: string;
  roleSampling: RoleSamplingConfig;
}

export class AssistantController {
  private readonly output: vscode.OutputChannel;
  private readonly conversation = new ConversationManager();
  private readonly parser = new ResponseParser();
  private readonly plannerModel = new LocalModel();
  private readonly reviewerModel = new LocalModel();
  private readonly coderModel = new LocalModel();
  private readonly verifierModel = new LocalModel();
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
  private unitsMigrated: boolean;
  private readonly unitsMigrationStateKey = 'ai-code.unitsMigration.v1';

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

    this.unitsMigrated = this.context.globalState.get<boolean>(this.unitsMigrationStateKey, false);
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
      ),
      vscode.commands.registerCommand('ai-code.removeModel', () => this.handleRemoveModel()),
      vscode.commands.registerCommand('ai-code.resetSettings', () => this.handleResetSettings()),
      vscode.commands.registerCommand('ai-code.runDebugPrompt', () => this.handleRunDebugPrompt())
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
      provider.onDidChangePlannerModel(modelId => {
        void this.handlePlannerModelSelection(modelId);
      }),
      provider.onDidChangeReviewerModel(modelId => {
        void this.handleReviewerModelSelection(modelId);
      }),
      provider.onDidChangeCoderModel(modelId => {
        void this.handleCoderModelSelection(modelId);
      }),
      provider.onDidChangeVerifierModel(modelId => {
        void this.handleVerifierModelSelection(modelId);
      }),
      provider.onDidChangeContextPromptBuilder(builderId => {
        void this.handleContextPromptBuilderSelection(builderId);
      }),
      provider.onDidChangePlannerPromptBuilder(builderId => {
        void this.handlePlannerPromptBuilderSelection(builderId);
      }),
      provider.onDidChangeReviewerPromptBuilder(builderId => {
        void this.handleReviewerPromptBuilderSelection(builderId);
      }),
      provider.onDidChangeCoderPromptBuilder(builderId => {
        void this.handleCoderPromptBuilderSelection(builderId);
      }),
      provider.onDidChangeQaPromptBuilder(builderId => {
        void this.handleQaPromptBuilderSelection(builderId);
      }),
      provider.onDidChangeSafetyPromptBuilder(builderId => {
        void this.handleSafetyPromptBuilderSelection(builderId);
      }),
      provider.onDidChangeVerifierPromptBuilder(builderId => {
        void this.handleVerifierPromptBuilderSelection(builderId);
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

  private async handleRunDebugPrompt(): Promise<void> {
    if (this.isBusy) {
      void vscode.window.showInformationMessage('The assistant is already processing a request.');
      return;
    }
    const prompt = 'Create a python program that will print hello world to the console';
    await this.runAssistant(prompt, 'command');
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
      let chatStatusUpdater: ((status: string) => void) | undefined;
      if (origin === 'chat') {
        this.updateChatBusy('Loading models...', { cancellable: true });
        chatStatusUpdater = status => {
          const trimmed = status.trim();
          if (trimmed.length === 0) {
            return;
          }
          this.updateChatBusy(trimmed, { cancellable: true });
        };
      }
      await this.prepareModels(config, tokenSource.token, {
        showNotification: origin !== 'chat',
        onStatus: chatStatusUpdater,
      });
      if (origin === 'chat') {
        this.updateChatBusy('Generating response...', { cancellable: true });
      }
      const history = this.conversation.getHistory();
      const { plan, rawResponse } = await this.generatePlanWithRetries(
        prompt,
        context,
        history,
        config,
        tokenSource.token,
        origin
      );
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

  private async prepareModels(
    config: AssistantConfiguration,
    token?: vscode.CancellationToken,
    options: { showNotification?: boolean; onStatus?: (status: string) => void } = {}
  ): Promise<void> {
    const showNotification = options.showNotification ?? true;
    const plannerConfig = this.toGenerationConfig(config, config.modelId, 'planner');
    await this.prepareSingleModel('Planner', this.plannerModel, plannerConfig, token, {
      showNotification,
      onStatus: options.onStatus,
    });

    const reviewerId = config.collaboratorModelId || config.modelId;
    const reviewerModelInstance = reviewerId === config.modelId ? this.plannerModel : this.reviewerModel;
    if (reviewerModelInstance === this.plannerModel) {
      const reuseMessage = `[Reviewer] Reusing planner model ${reviewerId}. Update ai-code.collaboratorModelId to select a distinct reviewer.`;
      this.log(reuseMessage);
      options.onStatus?.(reuseMessage);
    } else {
      const reviewerConfig = this.toGenerationConfig(config, reviewerId, 'reviewer');
      await this.prepareSingleModel('Reviewer', reviewerModelInstance, reviewerConfig, token, {
        showNotification,
        onStatus: options.onStatus,
      });
    }

    const coderId = config.coderModelId || reviewerId;
    const coderModelInstance =
      coderId === config.modelId
        ? this.plannerModel
        : coderId === reviewerId
          ? reviewerModelInstance
          : this.coderModel;

    if (coderModelInstance === this.plannerModel) {
      const reuseMessage = `[Coder] Reusing planner model ${coderId}. Update ai-code.coderModelId to pick a dedicated coding model.`;
      this.log(reuseMessage);
      options.onStatus?.(reuseMessage);
    } else if (coderModelInstance === reviewerModelInstance) {
      const reuseMessage = `[Coder] Reusing reviewer model ${coderId}. Update ai-code.coderModelId to override.`;
      this.log(reuseMessage);
      options.onStatus?.(reuseMessage);
    } else {
      const coderConfig = this.toGenerationConfig(config, coderId, 'coder');
      await this.prepareSingleModel('Coder', coderModelInstance, coderConfig, token, {
        showNotification,
        onStatus: options.onStatus,
      });
    }

    const verifierId = config.verifierModelId || coderId;
    const verifierModelInstance =
      verifierId === config.modelId
        ? this.plannerModel
        : verifierId === reviewerId
          ? reviewerModelInstance
          : verifierId === coderId
            ? coderModelInstance
            : this.verifierModel;

    if (verifierModelInstance === this.plannerModel) {
      const reuseMessage = `[Verifier] Reusing planner model ${verifierId}. Update ai-code.verifierModelId to pick a dedicated verification model.`;
      this.log(reuseMessage);
      options.onStatus?.(reuseMessage);
      return;
    }

    if (verifierModelInstance === reviewerModelInstance) {
      const reuseMessage = `[Verifier] Reusing reviewer model ${verifierId}. Update ai-code.verifierModelId to override.`;
      this.log(reuseMessage);
      options.onStatus?.(reuseMessage);
      return;
    }

    if (verifierModelInstance === coderModelInstance) {
      const reuseMessage = `[Verifier] Reusing coding model ${verifierId}. Update ai-code.verifierModelId to override.`;
      this.log(reuseMessage);
      options.onStatus?.(reuseMessage);
      return;
    }

    const verifierConfig = this.toGenerationConfig(config, verifierId, 'verifier');
    await this.prepareSingleModel('Verifier', this.verifierModel, verifierConfig, token, {
      showNotification,
      onStatus: options.onStatus,
    });
  }

  private async prepareSingleModel(
    role: 'Planner' | 'Reviewer' | 'Coder' | 'Verifier',
    model: LocalModel,
    generationConfig: GenerationConfig,
    token: vscode.CancellationToken | undefined,
    options: { showNotification: boolean; onStatus?: (status: string) => void }
  ): Promise<void> {
    const reportStatus = (status: string) => {
      const trimmed = status.trim();
      if (!trimmed) {
        return;
      }
      const message = `[${role}] ${trimmed}`;
      this.log(message);
      options.onStatus?.(message);
    };

    if (model.isLoaded(generationConfig.modelId)) {
      reportStatus(`Model ready: ${generationConfig.modelId}`);
      return;
    }

    if (options.showNotification) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading ${role.toLowerCase()} model ${generationConfig.modelId}`,
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
            await model.ensureLoaded(
              generationConfig,
              status => {
                const trimmedStatus = status.trim();
                if (trimmedStatus) {
                  progress.report({ message: trimmedStatus });
                }
                reportStatus(status);
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
      await model.ensureLoaded(
        generationConfig,
        status => {
          reportStatus(status);
        },
        token
      );
    }

    reportStatus(`Model ready: ${generationConfig.modelId}`);
  }

  private toGenerationConfig(
    config: AssistantConfiguration,
    modelId: string,
    role: PromptBuilderRole
  ): GenerationConfig {
    const sampling = config.roleSampling[role];
    return {
      modelId,
      maxNewTokens: config.maxNewTokens,
      temperature: sampling?.temperature ?? config.temperature,
      topP: sampling?.topP ?? config.topP,
      repetitionPenalty: sampling?.repetitionPenalty ?? config.repetitionPenalty,
      requestTimeoutMs: config.requestTimeoutMs,
      generationTimeoutMs: config.generationTimeoutMs,
    };
  }

  private async generatePlanWithRetries(
    prompt: string,
    context: string,
    history: ConversationMessage[],
    config: AssistantConfiguration,
    token: vscode.CancellationToken,
    origin: 'command' | 'chat'
  ): Promise<{ plan: AssistantPlan; rawResponse: string }> {
    const attemptHistory = [...history];
    let attempt = 0;
    let parseFailures = 0;
    let rawResponse = '';

    while (true) {
      attempt += 1;
      this.throwIfCancelled(token);
      if (attempt > 1) {
        const attemptLabel = `Retrying assistant response (attempt ${attempt})...`;
        this.log(`Retrying assistant response (attempt ${attempt}).`);
        if (origin === 'chat') {
          this.updateChatBusy(attemptLabel, { cancellable: true });
        }
      }

      const request: AssistantRequest = {
        prompt,
        context,
        history: attemptHistory,
      };
      const { verifiedPlan } = await this.invokeCollaborativePlan(
        request,
        config,
        token,
        origin,
        attempt
      );
      rawResponse = verifiedPlan;

      try {
        const plan = this.parser.parse(rawResponse);
        return { plan, rawResponse };
      } catch (error) {
        parseFailures += 1;
        const reason = error instanceof Error ? error.message : String(error);
        const truncatedReason = reason.length > 500 ? `${reason.slice(0, 500)}…` : reason;
        this.log(`Failed to parse assistant response on attempt ${attempt}: ${truncatedReason}`);

        if (origin === 'chat') {
          const notice =
            parseFailures === 1
              ? 'Assistant response was not valid JSON. Asking it to try again.'
              : `Assistant response was still not valid JSON (attempt ${parseFailures + 1}). Retrying...`;
          this.chatView?.addNotice(notice);
        } else if (parseFailures === 1) {
          void vscode.window.showWarningMessage('Assistant response was not valid JSON. Retrying...');
        }

        const truncatedResponse = rawResponse.length > 4000 ? `${rawResponse.slice(0, 4000)}…` : rawResponse;
        attemptHistory.push({ role: 'assistant', content: truncatedResponse });
        const reminder =
          parseFailures === 1
            ? 'Your previous reply could not be parsed as JSON. Respond again using only valid JSON matching the required schema. Do not include markdown fences or extra commentary.'
            : 'Reminder: respond with valid JSON only, matching the required schema. Do not include markdown fences or extra commentary.';
        attemptHistory.push({ role: 'user', content: reminder });
      }
    }
  }

  private async invokeCollaborativePlan(
    request: AssistantRequest,
    config: AssistantConfiguration,
    token: vscode.CancellationToken,
    origin: 'command' | 'chat',
    attempt: number
  ): Promise<{
    contextScoutBriefing: string;
    plannerDraft: string;
    coderPlan: string;
    reviewerPlan: string;
    qaPlan: string;
    safetyPlan: string;
    verifiedPlan: string;
  }> {
    const streamingEnabled = config.showCollaborationLiveStream;
    const showChatStreaming = streamingEnabled && origin === 'chat' && !!this.chatView;
    const attemptLabel = attempt > 1 ? ` (attempt ${attempt})` : '';
    const agentSequence = ['contextScout', 'planner', 'coder', 'reviewer', 'qa', 'safety', 'verifier'];
    this.log(`[Collaboration] Agent order: ${agentSequence.join(' → ')}.`);

    const contextScoutBuilder = getContextScoutPromptBuilderById(config.contextScoutPromptBuilderId);
    const plannerBuilder = getPlannerPromptBuilderById(config.plannerPromptBuilderId);
    const reviewerBuilder = getReviewerPromptBuilderById(config.reviewerPromptBuilderId);
    const coderBuilder = getCoderPromptBuilderById(config.coderPromptBuilderId);
    const qaBuilder = getQaPromptBuilderById(config.qaPromptBuilderId);
    const safetyBuilder = getSafetyPromptBuilderById(config.safetyPromptBuilderId);
    const verifierBuilder = getVerifierPromptBuilderById(config.verifierPromptBuilderId);

    let scoutEntry: ChatEntry | null = null;
    let scoutLastLength = 0;
    const ensureScoutEntry = (): ChatEntry | null => {
      if (!showChatStreaming) {
        return null;
      }
      if (!scoutEntry) {
        scoutEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: '',
          subtitle: `Context scout analysing...${attemptLabel}`,
          timestamp: Date.now(),
        };
        this.chatView?.append(scoutEntry);
      }
      return scoutEntry;
    };
    const updateScoutLog = (content: string) => {
      if (!streamingEnabled) {
        return;
      }
      if (content.length === scoutLastLength) {
        return;
      }
      const chunk = content.slice(scoutLastLength);
      scoutLastLength = content.length;
      if (chunk.trim().length === 0) {
        return;
      }
      this.log(`[ContextScout][stream] ${chunk}`);
    };

    const contextScoutPrompt = contextScoutBuilder.buildPrompt(request);
    if (origin === 'chat') {
      this.updateChatBusy('Context scout reviewing workspace...', { cancellable: true });
    }
    this.log(`[ContextScout] Reviewing context with ${config.modelId} using "${contextScoutBuilder.label}".`);
    const contextScoutBriefing = await this.invokeSingleModel(
      'ContextScout',
      this.plannerModel,
      this.toGenerationConfig(config, config.modelId, 'contextScout'),
      contextScoutPrompt,
      token,
      streamingEnabled
        ? {
            onStream: content => {
              const entry = ensureScoutEntry();
              if (entry) {
                const updated: ChatEntry = { ...entry, text: content };
                scoutEntry = updated;
                this.chatView?.update(updated);
              }
              updateScoutLog(content);
            },
            onComplete: final => {
              updateScoutLog(final);
              const entry = ensureScoutEntry();
              if (entry) {
                const updated: ChatEntry = {
                  ...entry,
                  text: final,
                  subtitle: `Context scout briefing${attemptLabel}`,
                };
                scoutEntry = updated;
                this.chatView?.update(updated);
              }
            },
          }
        : undefined
    );
    const scoutPreview =
      contextScoutBriefing.length > 400 ? `${contextScoutBriefing.slice(0, 400)}…` : contextScoutBriefing;
    this.log(`[ContextScout] Briefing ready (${contextScoutBriefing.length} chars). Preview: ${scoutPreview}`);

    const contextHistory: ConversationMessage[] = [
      ...request.history,
      { role: 'assistant', content: `Context scout briefing:\n${contextScoutBriefing}` },
      {
        role: 'user',
        content:
          'Incorporate the context scout briefing above. If essential artifacts are missing, highlight them in liveLog and steps before proceeding.',
      },
    ];
    const requestWithContext: AssistantRequest = { ...request, history: contextHistory };

    let plannerEntry: ChatEntry | null = null;
    let plannerLastLength = 0;
    const ensurePlannerEntry = (): ChatEntry | null => {
      if (!showChatStreaming) {
        return null;
      }
      if (!plannerEntry) {
        plannerEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: '',
          subtitle: `Planner drafting...${attemptLabel}`,
          timestamp: Date.now(),
        };
        this.chatView?.append(plannerEntry);
      }
      return plannerEntry;
    };
    const updatePlannerLog = (content: string) => {
      if (!streamingEnabled) {
        return;
      }
      if (content.length === plannerLastLength) {
        return;
      }
      const chunk = content.slice(plannerLastLength);
      plannerLastLength = content.length;
      if (chunk.trim().length === 0) {
        return;
      }
      this.log(`[Planner][stream] ${chunk}`);
    };

    const plannerPrompt = plannerBuilder.buildPrompt(requestWithContext);
    if (origin === 'chat') {
      this.updateChatBusy('Planner drafting response...', { cancellable: true });
    }
    this.log(`[Planner] Generating draft with ${config.modelId} using "${plannerBuilder.label}".`);
    const plannerDraft = await this.invokeSingleModel(
      'Planner',
      this.plannerModel,
      this.toGenerationConfig(config, config.modelId, 'planner'),
      plannerPrompt,
      token,
      streamingEnabled
        ? {
            onStream: content => {
              const entry = ensurePlannerEntry();
              if (entry) {
                const updated: ChatEntry = { ...entry, text: content };
                plannerEntry = updated;
                this.chatView?.update(updated);
              }
              updatePlannerLog(content);
            },
            onComplete: final => {
              updatePlannerLog(final);
              const entry = ensurePlannerEntry();
              if (entry) {
                const updated: ChatEntry = {
                  ...entry,
                  text: final,
                  subtitle: `Planner draft${attemptLabel}`,
                };
                plannerEntry = updated;
                this.chatView?.update(updated);
              }
            },
          }
        : undefined
    );
    const plannerPreview = plannerDraft.length > 400 ? `${plannerDraft.slice(0, 400)}…` : plannerDraft;
    this.log(`[Planner] Draft ready (${plannerDraft.length} chars). Preview: ${plannerPreview}`);

    const reviewerId = config.collaboratorModelId || config.modelId;
    const reviewerModel = reviewerId === config.modelId ? this.plannerModel : this.reviewerModel;
    const coderId = config.coderModelId || reviewerId;
    const coderModel =
      coderId === config.modelId
        ? this.plannerModel
        : coderId === reviewerId
          ? reviewerModel
          : this.coderModel;

    let coderEntry: ChatEntry | null = null;
    let coderLastLength = 0;
    const ensureCoderEntry = (): ChatEntry | null => {
      if (!showChatStreaming) {
        return null;
      }
      if (!coderEntry) {
        coderEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: '',
          subtitle: `Coder implementing...${attemptLabel}`,
          timestamp: Date.now(),
        };
        this.chatView?.append(coderEntry);
      }
      return coderEntry;
    };
    const updateCoderLog = (content: string) => {
      if (!streamingEnabled) {
        return;
      }
      if (content.length === coderLastLength) {
        return;
      }
      const chunk = content.slice(coderLastLength);
      coderLastLength = content.length;
      if (chunk.trim().length === 0) {
        return;
      }
      this.log(`[Coder][stream] ${chunk}`);
    };

    const coderPrompt = coderBuilder.buildPrompt(requestWithContext, plannerDraft);
    if (origin === 'chat') {
      this.updateChatBusy('Coder drafting changes...', { cancellable: true });
    }
    this.log(`[Coder] Implementing plan with ${coderId} using "${coderBuilder.label}".`);
    const coderPlan = await this.invokeSingleModel(
      'Coder',
      coderModel,
      this.toGenerationConfig(config, coderId, 'coder'),
      coderPrompt,
      token,
      streamingEnabled
        ? {
            onStream: content => {
              const entry = ensureCoderEntry();
              if (entry) {
                const updated: ChatEntry = { ...entry, text: content };
                coderEntry = updated;
                this.chatView?.update(updated);
              }
              updateCoderLog(content);
            },
            onComplete: final => {
              updateCoderLog(final);
              const entry = ensureCoderEntry();
              if (entry) {
                const updated: ChatEntry = {
                  ...entry,
                  text: final,
                  subtitle: `Coder plan${attemptLabel}`,
                };
                coderEntry = updated;
                this.chatView?.update(updated);
              }
            },
          }
        : undefined
    );
    const coderPreview = coderPlan.length > 400 ? `${coderPlan.slice(0, 400)}…` : coderPlan;
    this.log(`[Coder] Plan ready (${coderPlan.length} chars). Preview: ${coderPreview}`);

    let reviewerEntry: ChatEntry | null = null;
    let reviewerLastLength = 0;
    const ensureReviewerEntry = (): ChatEntry | null => {
      if (!showChatStreaming) {
        return null;
      }
      if (!reviewerEntry) {
        reviewerEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: '',
          subtitle: `Reviewer refining...${attemptLabel}`,
          timestamp: Date.now(),
        };
        this.chatView?.append(reviewerEntry);
      }
      return reviewerEntry;
    };
    const updateReviewerLog = (content: string) => {
      if (!streamingEnabled) {
        return;
      }
      if (content.length === reviewerLastLength) {
        return;
      }
      const chunk = content.slice(reviewerLastLength);
      reviewerLastLength = content.length;
      if (chunk.trim().length === 0) {
        return;
      }
      this.log(`[Reviewer][stream] ${chunk}`);
    };

    const reviewerPrompt = reviewerBuilder.buildPrompt(requestWithContext, coderPlan);
    if (origin === 'chat') {
      this.updateChatBusy('Reviewer refining plan...', { cancellable: true });
    }
    this.log(`[Reviewer] Refining draft with ${reviewerId} using "${reviewerBuilder.label}".`);
    const reviewerPlan = await this.invokeSingleModel(
      'Reviewer',
      reviewerModel,
      this.toGenerationConfig(config, reviewerId, 'reviewer'),
      reviewerPrompt,
      token,
      streamingEnabled
        ? {
            onStream: content => {
              const entry = ensureReviewerEntry();
              if (entry) {
                const updated: ChatEntry = { ...entry, text: content };
                reviewerEntry = updated;
                this.chatView?.update(updated);
              }
              updateReviewerLog(content);
            },
            onComplete: final => {
              updateReviewerLog(final);
              const entry = ensureReviewerEntry();
              if (entry) {
                const updated: ChatEntry = {
                  ...entry,
                  text: final,
                  subtitle: `Reviewer plan${attemptLabel}`,
                };
                reviewerEntry = updated;
                this.chatView?.update(updated);
              }
            },
          }
        : undefined
    );
    const reviewerPreview = reviewerPlan.length > 400 ? `${reviewerPlan.slice(0, 400)}…` : reviewerPlan;
    this.log(`[Reviewer] Plan ready (${reviewerPlan.length} chars). Preview: ${reviewerPreview}`);

    let qaEntry: ChatEntry | null = null;
    let qaLastLength = 0;
    const ensureQaEntry = (): ChatEntry | null => {
      if (!showChatStreaming) {
        return null;
      }
      if (!qaEntry) {
        qaEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: '',
          subtitle: `QA validating...${attemptLabel}`,
          timestamp: Date.now(),
        };
        this.chatView?.append(qaEntry);
      }
      return qaEntry;
    };
    const updateQaLog = (content: string) => {
      if (!streamingEnabled) {
        return;
      }
      if (content.length === qaLastLength) {
        return;
      }
      const chunk = content.slice(qaLastLength);
      qaLastLength = content.length;
      if (chunk.trim().length === 0) {
        return;
      }
      this.log(`[QA][stream] ${chunk}`);
    };

    const qaPrompt = qaBuilder.buildPrompt(requestWithContext, reviewerPlan);
    if (origin === 'chat') {
      this.updateChatBusy('QA agent validating plan...', { cancellable: true });
    }
    this.log(`[QA] Stress-testing plan with ${coderId} using "${qaBuilder.label}".`);
    const qaPlan = await this.invokeSingleModel(
      'QA',
      coderModel,
      this.toGenerationConfig(config, coderId, 'qa'),
      qaPrompt,
      token,
      streamingEnabled
        ? {
            onStream: content => {
              const entry = ensureQaEntry();
              if (entry) {
                const updated: ChatEntry = { ...entry, text: content };
                qaEntry = updated;
                this.chatView?.update(updated);
              }
              updateQaLog(content);
            },
            onComplete: final => {
              updateQaLog(final);
              const entry = ensureQaEntry();
              if (entry) {
                const updated: ChatEntry = {
                  ...entry,
                  text: final,
                  subtitle: `QA findings${attemptLabel}`,
                };
                qaEntry = updated;
                this.chatView?.update(updated);
              }
            },
          }
        : undefined
    );
    const qaPreview = qaPlan.length > 400 ? `${qaPlan.slice(0, 400)}…` : qaPlan;
    this.log(`[QA] Plan after QA review (${qaPlan.length} chars). Preview: ${qaPreview}`);

    let safetyEntry: ChatEntry | null = null;
    let safetyLastLength = 0;
    const ensureSafetyEntry = (): ChatEntry | null => {
      if (!showChatStreaming) {
        return null;
      }
      if (!safetyEntry) {
        safetyEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: '',
          subtitle: `Safety auditing...${attemptLabel}`,
          timestamp: Date.now(),
        };
        this.chatView?.append(safetyEntry);
      }
      return safetyEntry;
    };
    const updateSafetyLog = (content: string) => {
      if (!streamingEnabled) {
        return;
      }
      if (content.length === safetyLastLength) {
        return;
      }
      const chunk = content.slice(safetyLastLength);
      safetyLastLength = content.length;
      if (chunk.trim().length === 0) {
        return;
      }
      this.log(`[Safety][stream] ${chunk}`);
    };

    const safetyPrompt = safetyBuilder.buildPrompt(requestWithContext, qaPlan);
    if (origin === 'chat') {
      this.updateChatBusy('Safety auditor scanning plan...', { cancellable: true });
    }
    this.log(`[Safety] Auditing plan with ${coderId} using "${safetyBuilder.label}".`);
    const safetyPlan = await this.invokeSingleModel(
      'Safety',
      coderModel,
      this.toGenerationConfig(config, coderId, 'safety'),
      safetyPrompt,
      token,
      streamingEnabled
        ? {
            onStream: content => {
              const entry = ensureSafetyEntry();
              if (entry) {
                const updated: ChatEntry = { ...entry, text: content };
                safetyEntry = updated;
                this.chatView?.update(updated);
              }
              updateSafetyLog(content);
            },
            onComplete: final => {
              updateSafetyLog(final);
              const entry = ensureSafetyEntry();
              if (entry) {
                const updated: ChatEntry = {
                  ...entry,
                  text: final,
                  subtitle: `Safety review${attemptLabel}`,
                };
                safetyEntry = updated;
                this.chatView?.update(updated);
              }
            },
          }
        : undefined
    );
    const safetyPreview = safetyPlan.length > 400 ? `${safetyPlan.slice(0, 400)}…` : safetyPlan;
    this.log(`[Safety] Plan after safety review (${safetyPlan.length} chars). Preview: ${safetyPreview}`);

    let verifierEntry: ChatEntry | null = null;
    let verifierLastLength = 0;
    const ensureVerifierEntry = (): ChatEntry | null => {
      if (!showChatStreaming) {
        return null;
      }
      if (!verifierEntry) {
        verifierEntry = {
          id: this.nextMessageId('assistant'),
          role: 'assistant',
          text: '',
          subtitle: `Verifier checking...${attemptLabel}`,
          timestamp: Date.now(),
        };
        this.chatView?.append(verifierEntry);
      }
      return verifierEntry;
    };
    const updateVerifierLog = (content: string) => {
      if (!streamingEnabled) {
        return;
      }
      if (content.length === verifierLastLength) {
        return;
      }
      const chunk = content.slice(verifierLastLength);
      verifierLastLength = content.length;
      if (chunk.trim().length === 0) {
        return;
      }
      this.log(`[Verifier][stream] ${chunk}`);
    };

    const verifierId = config.verifierModelId || coderId;
    const verifierModel =
      verifierId === config.modelId
        ? this.plannerModel
        : verifierId === reviewerId
          ? reviewerModel
          : verifierId === coderId
            ? coderModel
            : this.verifierModel;
    const verifierPrompt = verifierBuilder.buildPrompt(requestWithContext, safetyPlan);
    if (origin === 'chat') {
      this.updateChatBusy('Verifier ensuring JSON compliance...', { cancellable: true });
    }
    this.log(`[Verifier] Ensuring JSON compliance with ${verifierId} using "${verifierBuilder.label}".`);
    const verifiedPlan = await this.invokeSingleModel(
      'Verifier',
      verifierModel,
      this.toGenerationConfig(config, verifierId, 'verifier'),
      verifierPrompt,
      token,
      streamingEnabled
        ? {
            onStream: content => {
              const entry = ensureVerifierEntry();
              if (entry) {
                const updated: ChatEntry = { ...entry, text: content };
                verifierEntry = updated;
                this.chatView?.update(updated);
              }
              updateVerifierLog(content);
            },
            onComplete: final => {
              updateVerifierLog(final);
              const entry = ensureVerifierEntry();
              if (entry) {
                const updated: ChatEntry = {
                  ...entry,
                  text: final,
                  subtitle: `Verifier result${attemptLabel}`,
                };
                verifierEntry = updated;
                this.chatView?.update(updated);
              }
            },
          }
        : undefined
    );
    const verifierPreview = verifiedPlan.length > 400 ? `${verifiedPlan.slice(0, 400)}…` : verifiedPlan;
    this.log(`[Verifier] Plan ready (${verifiedPlan.length} chars). Preview: ${verifierPreview}`);

    return { contextScoutBriefing, plannerDraft, coderPlan, reviewerPlan, qaPlan, safetyPlan, verifiedPlan };
  }

  private async invokeSingleModel(
    role: 'ContextScout' | 'Planner' | 'Reviewer' | 'Coder' | 'QA' | 'Safety' | 'Verifier',
    model: LocalModel,
    generationConfig: GenerationConfig,
    prompt: string,
    token: vscode.CancellationToken,
    options: { onStream?: (content: string) => void; onComplete?: (final: string) => void } = {}
  ): Promise<string> {
    this.throwIfCancelled(token);
    const { onStream, onComplete } = options;
    let streamed = '';
    const generated = await model.generate(
      prompt,
      generationConfig,
      chunk => {
        streamed += chunk;
        if (onStream) {
          onStream(streamed);
        }
      },
      token
    );
    let response = streamed || generated;
    if (!streamed && onStream && response) {
      onStream(response);
    }
    const trimmed = response.trim();
    if (!trimmed) {
      throw new Error(`${role} model returned an empty response.`);
    }
    if (onComplete) {
      onComplete(trimmed);
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

  private async handleRemoveModel(): Promise<void> {
    if (this.knownModels.size === 0) {
      void vscode.window.showInformationMessage('No stored models are available to remove.');
      return;
    }

    const picks: Array<vscode.QuickPickItem & { id: string }> = Array.from(this.knownModels).map(id => ({
      label: this.describeModel(id),
      description: id,
      id,
    }));
    picks.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

    const selection = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Select a stored Ollama model to remove',
      ignoreFocusOut: true,
    });

    if (!selection) {
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Remove ${selection.label} from Local Ai Coder?`,
      { modal: true },
      'Remove'
    );

    if (confirmation !== 'Remove') {
      return;
    }

    this.knownModels.delete(selection.id);
    await this.context.globalState.update(this.knownModelsStorageKey, Array.from(this.knownModels));
    this.log(`Removed stored model ${selection.id}.`);
    void vscode.window.showInformationMessage(`${selection.label} removed from Local Ai Coder.`);
    await this.refreshChatPreferences();
  }

  private async handleResetSettings(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      'Reset Local Ai Coder settings to their defaults?',
      { modal: true },
      'Reset'
    );

    if (confirmation !== 'Reset') {
      return;
    }

    try {
      const baseConfig = vscode.workspace.getConfiguration();
      await baseConfig.update('ai-code', undefined, vscode.ConfigurationTarget.Global);
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        await baseConfig.update('ai-code', undefined, vscode.ConfigurationTarget.Workspace);
      }

      this.knownModels.clear();
      await this.context.globalState.update(this.knownModelsStorageKey, []);
      this.approvalMode = 'requireApproval';
      await this.context.globalState.update(this.approvalModeStorageKey, this.approvalMode);

      this.log('Local Ai Coder settings reset to defaults.');
      this.chatView?.addNotice('Local Ai Coder settings reset to defaults.');
      await this.refreshChatPreferences();
      void vscode.window.showInformationMessage('Local Ai Coder settings reset to defaults.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to reset settings: ${message}`);
      void vscode.window.showErrorMessage(`Failed to reset Local Ai Coder settings: ${message}`);
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
      await this.prepareModels(updatedConfig);
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
    await this.ensureConfigurationUnits(config);
    const excludeGlobsSetting = config.get<unknown>('context.excludeGlobs');
    const excludeGlobs = Array.isArray(excludeGlobsSetting)
      ? (excludeGlobsSetting.filter(item => typeof item === 'string') as string[])
      : [];
    const overrideExcludes = config.get('context.overrideDefaultExcludes', false);
    const contextOptions: ContextCollectorOptions = {
      maxFiles: config.get('context.maxFiles', 40),
      maxFileSize: this.readKilobyteSetting(config, 'context.maxFileSize', 200),
      maxTotalSize: this.readKilobyteSetting(config, 'context.maxTotalSize', 1500),
      includeBinary: config.get('context.includeBinary', false),
      excludeGlobs,
      useDefaultExcludes: !overrideExcludes,
      prioritizeChangedFiles: config.get('context.prioritizeChangedFiles', true),
    };
    const configuredModelId = config.get('modelId', DEFAULT_MODEL_ID);
    const resolvedModelId = this.resolveModelId(configuredModelId);
    const collaboratorSetting = config.get('collaboratorModelId');
    const resolvedCollaboratorId =
      typeof collaboratorSetting === 'string' && collaboratorSetting.trim().length > 0
        ? this.resolveModelId(collaboratorSetting)
        : resolvedModelId;
    const coderSetting = config.get('coderModelId');
    const resolvedCoderId =
      typeof coderSetting === 'string' && coderSetting.trim().length > 0
        ? this.resolveModelId(coderSetting)
        : resolvedCollaboratorId;
    const verifierSetting = config.get('verifierModelId');
    const resolvedVerifierId =
      typeof verifierSetting === 'string' && verifierSetting.trim().length > 0
        ? this.resolveModelId(verifierSetting)
        : resolvedCoderId;
    const plannerPromptSetting = config.get('promptBuilders.planner');
    const resolvedPlannerPromptBuilderId = this.normalizePromptBuilderId(
      plannerPromptSetting,
      'planner',
      DEFAULT_PLANNER_PROMPT_BUILDER_ID
    );
    const contextScoutPromptSetting = config.get('promptBuilders.contextScout');
    const resolvedContextScoutPromptBuilderId = this.normalizePromptBuilderId(
      contextScoutPromptSetting,
      'contextScout',
      resolvedPlannerPromptBuilderId
    );
    const reviewerPromptSetting = config.get('promptBuilders.reviewer');
    const legacyCoderPromptSetting = config.get('promptBuilders.coder');
    const reviewerSource =
      typeof reviewerPromptSetting === 'string' && reviewerPromptSetting.trim().length > 0
        ? reviewerPromptSetting
        : typeof legacyCoderPromptSetting === 'string' && legacyCoderPromptSetting.trim().length > 0
          ? legacyCoderPromptSetting
          : '';
    const resolvedReviewerPromptBuilderId = reviewerSource
      ? this.normalizePromptBuilderId(reviewerSource, 'reviewer', resolvedPlannerPromptBuilderId)
      : resolvedPlannerPromptBuilderId;
    const coderPromptSetting = config.get('promptBuilders.coder');
    const resolvedCoderPromptBuilderId = this.normalizePromptBuilderId(
      coderPromptSetting,
      'coder',
      resolvedReviewerPromptBuilderId
    );
    const qaPromptSetting = config.get('promptBuilders.qa');
    const resolvedQaPromptBuilderId = this.normalizePromptBuilderId(
      qaPromptSetting,
      'qa',
      resolvedCoderPromptBuilderId
    );
    const safetyPromptSetting = config.get('promptBuilders.safety');
    const resolvedSafetyPromptBuilderId = this.normalizePromptBuilderId(
      safetyPromptSetting,
      'safety',
      resolvedQaPromptBuilderId
    );
    const verifierPromptSetting = config.get('promptBuilders.verifier');
    const resolvedVerifierPromptBuilderId = this.normalizePromptBuilderId(
      verifierPromptSetting,
      'verifier',
      resolvedSafetyPromptBuilderId
    );
    this.recordKnownModel(resolvedModelId);
    this.recordKnownModel(resolvedCollaboratorId);
    this.recordKnownModel(resolvedCoderId);
    this.recordKnownModel(resolvedVerifierId);

    const temperature = this.readNumberSetting(config, 'temperature', 0.2);
    const topP = this.readNumberSetting(config, 'sampling.topP', 0.95);
    const repetitionPenalty = this.readNumberSetting(config, 'sampling.repetitionPenalty', 1.05);
    const roleSampling = this.readRoleSamplingConfiguration(config, {
      temperature,
      topP,
      repetitionPenalty,
    });

    return {
      modelId: resolvedModelId,
      collaboratorModelId: resolvedCollaboratorId,
      coderModelId: resolvedCoderId,
      verifierModelId: resolvedVerifierId,
      contextScoutPromptBuilderId: resolvedContextScoutPromptBuilderId,
      plannerPromptBuilderId: resolvedPlannerPromptBuilderId,
      reviewerPromptBuilderId: resolvedReviewerPromptBuilderId,
      coderPromptBuilderId: resolvedCoderPromptBuilderId,
      qaPromptBuilderId: resolvedQaPromptBuilderId,
      safetyPromptBuilderId: resolvedSafetyPromptBuilderId,
      verifierPromptBuilderId: resolvedVerifierPromptBuilderId,
      showCollaborationLiveStream: config.get('collaboration.showLiveStream', false),
      maxNewTokens: config.get('maxNewTokens', 5120),
      temperature,
      topP,
      repetitionPenalty,
      requestTimeoutMs: this.readSecondsSetting(config, 'ollama.requestTimeoutMs', 30),
      generationTimeoutMs: this.readSecondsSetting(config, 'ollama.generationTimeoutMs', 120),
      context: contextOptions,
      allowCommandExecution: config.get('allowCommandExecution', true),
      shell: config.get('shell', 'default'),
      roleSampling,
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

  private normalizePromptBuilderId(
    builderId: unknown,
    role: PromptBuilderRole,
    fallbackId: string
  ): string {
    const fallback = normalizePromptBuilderIdForRole(fallbackId, role) ?? fallbackId;
    if (typeof builderId !== 'string') {
      return fallback;
    }
    const trimmed = builderId.trim();
    if (!trimmed) {
      return fallback;
    }
    const normalized = normalizePromptBuilderIdForRole(trimmed, role);
    if (normalized) {
      return normalized;
    }
    return fallback;
  }

  private isOllamaModelId(value: string): boolean {
    return /^ollama:/i.test(value.trim());
  }

  private async ensureConfigurationUnits(config: vscode.WorkspaceConfiguration): Promise<void> {
    if (this.unitsMigrated) {
      return;
    }
    try {
      const migrated = await this.migrateUnitSettings(config);
      if (migrated) {
        await this.context.globalState.update(this.unitsMigrationStateKey, true);
        this.unitsMigrated = true;
      } else {
        this.log('Some settings could not be migrated to the new units. They will be retried on next launch.');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`Failed to migrate settings to new units: ${reason}`);
    }
  }

  private async migrateUnitSettings(baseConfig: vscode.WorkspaceConfiguration): Promise<boolean> {
    const baseResults = await Promise.all([
      this.migrateSizeSetting(baseConfig, 'context.maxFileSize'),
      this.migrateSizeSetting(baseConfig, 'context.maxTotalSize'),
      this.migrateTimeoutSetting(baseConfig, 'ollama.requestTimeoutMs'),
      this.migrateTimeoutSetting(baseConfig, 'ollama.generationTimeoutMs'),
    ]);

    const folders = vscode.workspace.workspaceFolders ?? [];
    const folderResults = await Promise.all(
      folders.map(async folder => {
        const scoped = vscode.workspace.getConfiguration('ai-code', folder.uri);
        const results = await Promise.all([
          this.migrateSizeSetting(scoped, 'context.maxFileSize', 'folder'),
          this.migrateSizeSetting(scoped, 'context.maxTotalSize', 'folder'),
          this.migrateTimeoutSetting(scoped, 'ollama.requestTimeoutMs', 'folder'),
          this.migrateTimeoutSetting(scoped, 'ollama.generationTimeoutMs', 'folder'),
        ]);
        return results.every(Boolean);
      })
    );

    return baseResults.every(Boolean) && folderResults.every(Boolean);
  }

  private async migrateSizeSetting(
    config: vscode.WorkspaceConfiguration,
    key: string,
    scope?: 'folder'
  ): Promise<boolean> {
    const inspection = config.inspect<number>(key);
    if (!inspection) {
      return true;
    }
    const convert = (value: number) => {
      if (!Number.isFinite(value) || value <= 0) {
        return null;
      }
      if (value < 1000) {
        return null;
      }
      return Number((value / 1000).toFixed(3));
    };
    if (scope === 'folder') {
      return this.applyMigration(
        config,
        key,
        inspection.workspaceFolderValue,
        vscode.ConfigurationTarget.WorkspaceFolder,
        convert
      );
    }
    const [globalResult, workspaceResult] = await Promise.all([
      this.applyMigration(config, key, inspection.globalValue, vscode.ConfigurationTarget.Global, convert),
      this.applyMigration(config, key, inspection.workspaceValue, vscode.ConfigurationTarget.Workspace, convert),
    ]);
    return globalResult && workspaceResult;
  }

  private async migrateTimeoutSetting(
    config: vscode.WorkspaceConfiguration,
    key: string,
    scope?: 'folder'
  ): Promise<boolean> {
    const inspection = config.inspect<number>(key);
    if (!inspection) {
      return true;
    }
    const convert = (value: number) => {
      if (!Number.isFinite(value)) {
        return null;
      }
      if (value === 0) {
        return 0;
      }
      return Number((value / 1000).toFixed(3));
    };
    if (scope === 'folder') {
      return this.applyMigration(
        config,
        key,
        inspection.workspaceFolderValue,
        vscode.ConfigurationTarget.WorkspaceFolder,
        convert
      );
    }
    const [globalResult, workspaceResult] = await Promise.all([
      this.applyMigration(config, key, inspection.globalValue, vscode.ConfigurationTarget.Global, convert),
      this.applyMigration(config, key, inspection.workspaceValue, vscode.ConfigurationTarget.Workspace, convert),
    ]);
    return globalResult && workspaceResult;
  }

  private async applyMigration(
    config: vscode.WorkspaceConfiguration,
    key: string,
    value: unknown,
    target: vscode.ConfigurationTarget,
    convert: (value: number) => number | null
  ): Promise<boolean> {
    if (typeof value !== 'number') {
      return true;
    }
    const converted = convert(value);
    if (converted === null || converted === value) {
      return true;
    }
    try {
      await config.update(key, converted, target);
      this.log(`Migrated ${key} from ${value} to ${converted}.`);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`Failed to migrate ${key}: ${reason}`);
      return false;
    }
  }

  private readNumberSetting(
    config: vscode.WorkspaceConfiguration,
    key: string,
    defaultValue: number
  ): number {
    const raw = config.get<unknown>(key);
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    return defaultValue;
  }

  private readRoleSamplingConfiguration(
    config: vscode.WorkspaceConfiguration,
    defaults: RoleSamplingOverrides
  ): RoleSamplingConfig {
    const sampling: Partial<RoleSamplingConfig> = {};
    for (const role of SAMPLING_ROLES) {
      sampling[role] = {
        temperature: this.readNumberSetting(config, `temperature.${role}`, defaults.temperature),
        topP: this.readNumberSetting(config, `sampling.topP.${role}`, defaults.topP),
        repetitionPenalty: this.readNumberSetting(
          config,
          `sampling.repetitionPenalty.${role}`,
          defaults.repetitionPenalty
        ),
      };
    }
    return sampling as RoleSamplingConfig;
  }

  private readKilobyteSetting(
    config: vscode.WorkspaceConfiguration,
    key: string,
    defaultKilobytes: number
  ): number {
    const raw = config.get<number>(key);
    const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultKilobytes;
    const normalized = numeric > 0 ? numeric : defaultKilobytes;
    return Math.max(1, Math.round(normalized * 1000));
  }

  private readSecondsSetting(
    config: vscode.WorkspaceConfiguration,
    key: string,
    defaultSeconds: number
  ): number {
    const raw = config.get<number>(key);
    const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultSeconds;
    return Math.round(numeric * 1000);
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

  private async handlePlannerModelSelection(modelId: string): Promise<void> {
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
    this.chatView?.addNotice(`Planning model set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleReviewerModelSelection(modelId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (modelId === REVIEWER_INHERIT_MODEL_ID) {
      await config.update('collaboratorModelId', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Reviewer model set to follow the planning model.');
      this.chatView?.addNotice('Reviewer model will match the planner.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const trimmed = modelId.trim();
    if (!trimmed) {
      await config.update('collaboratorModelId', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.resolveModelId(trimmed);
    const current = config.get('collaboratorModelId');
    if (typeof current === 'string') {
      const normalizedCurrent = current.trim().length > 0 ? this.resolveModelId(current) : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('collaboratorModelId', normalized, vscode.ConfigurationTarget.Workspace);
    this.recordKnownModel(normalized);
    const updatedConfig = await this.getConfiguration();
    const label = this.describeModel(updatedConfig.collaboratorModelId);
    this.log(`Reviewer model updated to ${updatedConfig.collaboratorModelId}.`);
    this.chatView?.addNotice(`Reviewer model set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleCoderModelSelection(modelId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (modelId === CODER_INHERIT_MODEL_ID) {
      await config.update('coderModelId', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Coding model set to follow the reviewer model.');
      this.chatView?.addNotice('Coding model will match the reviewer.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const trimmed = modelId.trim();
    if (!trimmed) {
      await config.update('coderModelId', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.resolveModelId(trimmed);
    const current = config.get('coderModelId');
    if (typeof current === 'string') {
      const normalizedCurrent = current.trim().length > 0 ? this.resolveModelId(current) : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('coderModelId', normalized, vscode.ConfigurationTarget.Workspace);
    this.recordKnownModel(normalized);
    const updatedConfig = await this.getConfiguration();
    const label = this.describeModel(updatedConfig.coderModelId);
    this.log(`Coding model updated to ${updatedConfig.coderModelId}.`);
    this.chatView?.addNotice(`Coding model set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleVerifierModelSelection(modelId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (modelId === VERIFIER_INHERIT_MODEL_ID) {
      await config.update('verifierModelId', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Verification model set to follow the coding model.');
      this.chatView?.addNotice('Verification model will match the coding model.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const trimmed = modelId.trim();
    if (!trimmed) {
      await config.update('verifierModelId', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.resolveModelId(trimmed);
    const current = config.get('verifierModelId');
    if (typeof current === 'string') {
      const trimmedCurrent = current.trim();
      const normalizedCurrent = trimmedCurrent.length > 0 ? this.resolveModelId(trimmedCurrent) : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('verifierModelId', normalized, vscode.ConfigurationTarget.Workspace);
    this.recordKnownModel(normalized);
    const updatedConfig = await this.getConfiguration();
    const label = this.describeModel(updatedConfig.verifierModelId);
    this.log(`Verification model updated to ${updatedConfig.verifierModelId}.`);
    this.chatView?.addNotice(`Verification model set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleContextPromptBuilderSelection(builderId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (builderId === CONTEXT_SCOUT_PROMPT_INHERIT_ID) {
      await config.update('promptBuilders.contextScout', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Context scout prompt builder set to follow the planner prompt builder.');
      this.chatView?.addNotice('Context scout prompt style will match the planner.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.normalizePromptBuilderId(
      builderId,
      'contextScout',
      DEFAULT_CONTEXT_SCOUT_PROMPT_BUILDER_ID
    );
    const current = config.get('promptBuilders.contextScout');
    if (typeof current === 'string') {
      const trimmed = current.trim();
      const normalizedCurrent =
        trimmed.length > 0
          ? this.normalizePromptBuilderId(trimmed, 'contextScout', DEFAULT_CONTEXT_SCOUT_PROMPT_BUILDER_ID)
          : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('promptBuilders.contextScout', normalized, vscode.ConfigurationTarget.Workspace);
    const updatedConfig = await this.getConfiguration();
    const label = describePromptBuilder(updatedConfig.contextScoutPromptBuilderId);
    this.log(`Context scout prompt builder updated to ${updatedConfig.contextScoutPromptBuilderId}.`);
    this.chatView?.addNotice(`Context scout prompt style set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handlePlannerPromptBuilderSelection(builderId: string): Promise<void> {
    const normalized = this.normalizePromptBuilderId(
      builderId,
      'planner',
      DEFAULT_PLANNER_PROMPT_BUILDER_ID
    );
    const config = vscode.workspace.getConfiguration('ai-code');
    const current = config.get('promptBuilders.planner');
    if (typeof current === 'string') {
      const normalizedCurrent = this.normalizePromptBuilderId(
        current,
        'planner',
        DEFAULT_PLANNER_PROMPT_BUILDER_ID
      );
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    } else if (current === undefined && normalized === DEFAULT_PLANNER_PROMPT_BUILDER_ID) {
      await this.refreshChatPreferences();
      return;
    }

    await config.update('promptBuilders.planner', normalized, vscode.ConfigurationTarget.Workspace);
    const updatedConfig = await this.getConfiguration();
    const label = describePromptBuilder(updatedConfig.plannerPromptBuilderId);
    this.log(`Planning prompt builder updated to ${updatedConfig.plannerPromptBuilderId}.`);
    this.chatView?.addNotice(`Planning prompt style set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleReviewerPromptBuilderSelection(builderId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (builderId === REVIEWER_PROMPT_INHERIT_ID) {
      await config.update('promptBuilders.reviewer', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Reviewer prompt builder set to follow the planner prompt builder.');
      this.chatView?.addNotice('Reviewer prompt style will match the planner.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.normalizePromptBuilderId(
      builderId,
      'reviewer',
      DEFAULT_REVIEWER_PROMPT_BUILDER_ID
    );
    const current = config.get('promptBuilders.reviewer');
    if (typeof current === 'string') {
      const trimmed = current.trim();
      const normalizedCurrent =
        trimmed.length > 0
          ? this.normalizePromptBuilderId(trimmed, 'reviewer', DEFAULT_REVIEWER_PROMPT_BUILDER_ID)
          : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('promptBuilders.reviewer', normalized, vscode.ConfigurationTarget.Workspace);
    const updatedConfig = await this.getConfiguration();
    const label = describePromptBuilder(updatedConfig.reviewerPromptBuilderId);
    this.log(`Reviewer prompt builder updated to ${updatedConfig.reviewerPromptBuilderId}.`);
    this.chatView?.addNotice(`Reviewer prompt style set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleCoderPromptBuilderSelection(builderId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (builderId === CODER_PROMPT_INHERIT_ID) {
      await config.update('promptBuilders.coder', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Coder prompt builder set to follow the reviewer prompt builder.');
      this.chatView?.addNotice('Coder prompt style will match the reviewer.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.normalizePromptBuilderId(
      builderId,
      'coder',
      DEFAULT_CODER_PROMPT_BUILDER_ID
    );
    const current = config.get('promptBuilders.coder');
    if (typeof current === 'string') {
      const trimmed = current.trim();
      const normalizedCurrent =
        trimmed.length > 0
          ? this.normalizePromptBuilderId(trimmed, 'coder', DEFAULT_CODER_PROMPT_BUILDER_ID)
          : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('promptBuilders.coder', normalized, vscode.ConfigurationTarget.Workspace);
    const updatedConfig = await this.getConfiguration();
    const label = describePromptBuilder(updatedConfig.coderPromptBuilderId);
    this.log(`Coder prompt builder updated to ${updatedConfig.coderPromptBuilderId}.`);
    this.chatView?.addNotice(`Coder prompt style set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleQaPromptBuilderSelection(builderId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (builderId === QA_PROMPT_INHERIT_ID) {
      await config.update('promptBuilders.qa', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('QA prompt builder set to follow the coder prompt builder.');
      this.chatView?.addNotice('QA prompt style will match the coder.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.normalizePromptBuilderId(builderId, 'qa', DEFAULT_QA_PROMPT_BUILDER_ID);
    const current = config.get('promptBuilders.qa');
    if (typeof current === 'string') {
      const trimmed = current.trim();
      const normalizedCurrent =
        trimmed.length > 0
          ? this.normalizePromptBuilderId(trimmed, 'qa', DEFAULT_QA_PROMPT_BUILDER_ID)
          : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('promptBuilders.qa', normalized, vscode.ConfigurationTarget.Workspace);
    const updatedConfig = await this.getConfiguration();
    const label = describePromptBuilder(updatedConfig.qaPromptBuilderId);
    this.log(`QA prompt builder updated to ${updatedConfig.qaPromptBuilderId}.`);
    this.chatView?.addNotice(`QA prompt style set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleSafetyPromptBuilderSelection(builderId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (builderId === SAFETY_PROMPT_INHERIT_ID) {
      await config.update('promptBuilders.safety', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Safety prompt builder set to follow the QA prompt builder.');
      this.chatView?.addNotice('Safety prompt style will match the QA prompt.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.normalizePromptBuilderId(
      builderId,
      'safety',
      DEFAULT_SAFETY_PROMPT_BUILDER_ID
    );
    const current = config.get('promptBuilders.safety');
    if (typeof current === 'string') {
      const trimmed = current.trim();
      const normalizedCurrent =
        trimmed.length > 0
          ? this.normalizePromptBuilderId(trimmed, 'safety', DEFAULT_SAFETY_PROMPT_BUILDER_ID)
          : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('promptBuilders.safety', normalized, vscode.ConfigurationTarget.Workspace);
    const updatedConfig = await this.getConfiguration();
    const label = describePromptBuilder(updatedConfig.safetyPromptBuilderId);
    this.log(`Safety prompt builder updated to ${updatedConfig.safetyPromptBuilderId}.`);
    this.chatView?.addNotice(`Safety prompt style set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async handleVerifierPromptBuilderSelection(builderId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-code');
    if (builderId === VERIFIER_PROMPT_INHERIT_ID) {
      await config.update('promptBuilders.verifier', '', vscode.ConfigurationTarget.Workspace);
      const updatedConfig = await this.getConfiguration();
      this.log('Verification prompt builder set to follow the safety prompt builder.');
      this.chatView?.addNotice('Verification prompt style will match the safety prompt.');
      await this.refreshChatPreferences(updatedConfig);
      return;
    }

    const normalized = this.normalizePromptBuilderId(
      builderId,
      'verifier',
      DEFAULT_VERIFIER_PROMPT_BUILDER_ID
    );
    const current = config.get('promptBuilders.verifier');
    if (typeof current === 'string') {
      const trimmed = current.trim();
      const normalizedCurrent =
        trimmed.length > 0
          ? this.normalizePromptBuilderId(trimmed, 'verifier', DEFAULT_VERIFIER_PROMPT_BUILDER_ID)
          : '';
      if (normalizedCurrent === normalized) {
        await this.refreshChatPreferences();
        return;
      }
    }

    await config.update('promptBuilders.verifier', normalized, vscode.ConfigurationTarget.Workspace);
    const updatedConfig = await this.getConfiguration();
    const label = describePromptBuilder(updatedConfig.verifierPromptBuilderId);
    this.log(`Verification prompt builder updated to ${updatedConfig.verifierPromptBuilderId}.`);
    this.chatView?.addNotice(`Verification prompt style set to ${label}.`);
    await this.refreshChatPreferences(updatedConfig);
  }

  private async refreshChatPreferences(config?: AssistantConfiguration): Promise<void> {
    if (!this.chatView) {
      return;
    }
    const effectiveConfig = config ?? (await this.getConfiguration());
    const models = await this.discoverModelOptions(
      effectiveConfig.modelId,
      effectiveConfig.collaboratorModelId,
      effectiveConfig.coderModelId,
      effectiveConfig.verifierModelId
    );
    const rawConfig = vscode.workspace.getConfiguration('ai-code');
    const collaboratorSetting = rawConfig.get('collaboratorModelId');
    const collaboratorFollowsPlanner =
      typeof collaboratorSetting === 'string' ? collaboratorSetting.trim().length === 0 : true;
    const coderSetting = rawConfig.get('coderModelId');
    const coderFollowsReviewer = typeof coderSetting === 'string' ? coderSetting.trim().length === 0 : true;
    const verifierSetting = rawConfig.get('verifierModelId');
    const verifierFollowsCoder = typeof verifierSetting === 'string' ? verifierSetting.trim().length === 0 : true;
    const promptBuilders = this.collectPromptBuilderOptions();
    const contextPromptSetting = rawConfig.get('promptBuilders.contextScout');
    const contextPromptFollowsPlanner =
      typeof contextPromptSetting === 'string' ? contextPromptSetting.trim().length === 0 : true;
    const reviewerPromptSetting = rawConfig.get('promptBuilders.reviewer');
    const legacyReviewerPromptSetting = rawConfig.get('promptBuilders.coder');
    const reviewerPromptFollowsPlanner =
      typeof reviewerPromptSetting === 'string'
        ? reviewerPromptSetting.trim().length === 0
        : typeof legacyReviewerPromptSetting === 'string'
          ? legacyReviewerPromptSetting.trim().length === 0
          : true;
    const coderPromptSetting = rawConfig.get('promptBuilders.coder');
    const coderPromptFollowsReviewer =
      typeof coderPromptSetting === 'string' ? coderPromptSetting.trim().length === 0 : true;
    const qaPromptSetting = rawConfig.get('promptBuilders.qa');
    const qaPromptFollowsCoder =
      typeof qaPromptSetting === 'string' ? qaPromptSetting.trim().length === 0 : true;
    const safetyPromptSetting = rawConfig.get('promptBuilders.safety');
    const safetyPromptFollowsQa =
      typeof safetyPromptSetting === 'string' ? safetyPromptSetting.trim().length === 0 : true;
    const verifierPromptSetting = rawConfig.get('promptBuilders.verifier');
    const verifierPromptFollowsSafety =
      typeof verifierPromptSetting === 'string' ? verifierPromptSetting.trim().length === 0 : true;
    const controls: ChatControlsState = {
      approvalMode: this.approvalMode,
      plannerModelId: effectiveConfig.modelId,
      reviewerModelId: effectiveConfig.collaboratorModelId,
      reviewerFollowsPlanner: collaboratorFollowsPlanner,
      coderModelId: effectiveConfig.coderModelId,
      coderFollowsReviewer,
      verifierModelId: effectiveConfig.verifierModelId,
      verifierFollowsCoder,
      contextScoutPromptBuilderId: effectiveConfig.contextScoutPromptBuilderId,
      contextScoutPromptFollowsPlanner: contextPromptFollowsPlanner,
      plannerPromptBuilderId: effectiveConfig.plannerPromptBuilderId,
      reviewerPromptBuilderId: effectiveConfig.reviewerPromptBuilderId,
      reviewerPromptFollowsPlanner,
      coderPromptBuilderId: effectiveConfig.coderPromptBuilderId,
      coderPromptFollowsReviewer,
      qaPromptBuilderId: effectiveConfig.qaPromptBuilderId,
      qaPromptFollowsCoder,
      safetyPromptBuilderId: effectiveConfig.safetyPromptBuilderId,
      safetyPromptFollowsQa,
      verifierPromptBuilderId: effectiveConfig.verifierPromptBuilderId,
      verifierPromptFollowsSafety,
      models,
      promptBuilders,
    };
    this.chatView.setPreferences(controls);
  }

  private async discoverModelOptions(...currentModelIds: string[]): Promise<ChatModelOption[]> {
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
    for (const id of currentModelIds) {
      addCandidate(id);
    }
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

  private collectPromptBuilderOptions(): ChatPromptBuilderGroups {
    const optionsByRole = listPromptBuilderOptionsByRole();
    const mapOptions = (options: readonly PromptBuilderOption[]) =>
      options.map(option => ({
        id: option.id,
        label: option.label,
        description: option.description,
        role: option.role,
      }));

    return {
      contextScout: mapOptions(optionsByRole.contextScout),
      planner: mapOptions(optionsByRole.planner),
      reviewer: mapOptions(optionsByRole.reviewer),
      coder: mapOptions(optionsByRole.coder),
      qa: mapOptions(optionsByRole.qa),
      safety: mapOptions(optionsByRole.safety),
      verifier: mapOptions(optionsByRole.verifier),
    };
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

































