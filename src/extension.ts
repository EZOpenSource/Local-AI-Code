import * as vscode from 'vscode';
import { AssistantController } from './assistant/assistantController';
import { ChatViewProvider } from './chatViewProvider';
import { SettingsViewProvider } from './settingsViewProvider';

let controller: AssistantController | null = null;
let chatProvider: ChatViewProvider | null = null;
let settingsProvider: SettingsViewProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  controller = new AssistantController(context);
  controller.register();

  chatProvider = new ChatViewProvider(context.extensionUri);
  controller.registerChatView(chatProvider);

  settingsProvider = new SettingsViewProvider();

  context.subscriptions.push(
    chatProvider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider('ai-code.quickActions', settingsProvider),
    vscode.commands.registerCommand('ai-code.openSettings', () => {
      if (settingsProvider) {
        void settingsProvider.openExtensionSettings();
      } else {
        void vscode.commands.executeCommand('workbench.action.openSettings', '@:ai-code');
      }
    })
  );

  vscode.window.showInformationMessage('Local Ai Coder is ready to help locally.');
}

export function deactivate(): void {
  controller = null;
  chatProvider = null;
  settingsProvider = null;
}

