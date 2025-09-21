import * as vscode from 'vscode';

interface SettingsItem {
  readonly label: string;
  readonly description?: string;
  readonly command: vscode.Command;
}

export class SettingsViewProvider implements vscode.TreeDataProvider<SettingsItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SettingsItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  getTreeItem(element: SettingsItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.command = element.command;
    item.iconPath = element.command.command === 'ai-code.downloadModel'
      ? new vscode.ThemeIcon('cloud-download')
      : new vscode.ThemeIcon('gear');
    return item;
  }

  getChildren(element?: SettingsItem): vscode.ProviderResult<SettingsItem[]> {
    if (element) {
      return [];
    }

    return [
      {
        label: 'Open Extension Settings',
        description: 'Configure Local Ai Coder',
        command: {
          command: 'ai-code.openSettings',
          title: 'Open Local Ai Coder Settings'
        }
      },
      {
        label: 'Download Model Assets',
        description: 'Fetch the configured model without running a prompt',
        command: {
          command: 'ai-code.downloadModel',
          title: 'Download Local Ai Coder Model'
        }
      }
    ];
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public openExtensionSettings(): Thenable<void> {
    return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-dev.ai-code');
  }
}




