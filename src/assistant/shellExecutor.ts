import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { ShellCommandRequest } from '../types';

export interface ShellExecutionResult {
  command: string;
  stdout: string;
  stderr: string;
}

export class ShellExecutor {
  constructor(private readonly output: vscode.OutputChannel) {}

  public async runWithApproval(
    request: ShellCommandRequest,
    shellSetting: string,
    token?: vscode.CancellationToken
  ): Promise<ShellExecutionResult | null> {
    const detail = request.description ? `${request.description}\n\n${request.command}` : request.command;
    const approval = await vscode.window.showWarningMessage(
      `Allow the assistant to execute the following command?`,
      { modal: true, detail },
      'Approve',
      'Reject'
    );
    if (approval !== 'Approve') {
      this.output.appendLine(`Command rejected: ${request.command}`);
      return null;
    }

    return this.execute(request, shellSetting, token);
  }

  public async runWithoutApproval(
    request: ShellCommandRequest,
    shellSetting: string,
    token?: vscode.CancellationToken
  ): Promise<ShellExecutionResult> {
    return this.execute(request, shellSetting, token);
  }

  private async execute(
    request: ShellCommandRequest,
    shellSetting: string,
    token?: vscode.CancellationToken
  ): Promise<ShellExecutionResult> {
    const cwd = this.resolveWorkspacePath();
    const shell = shellSetting === 'default' || shellSetting.trim().length === 0 ? undefined : shellSetting;

    this.output.appendLine(`$ ${request.command}`);
    return await new Promise<ShellExecutionResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finalize = (result: ShellExecutionResult | Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cancellationListener?.dispose();
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      const child = spawn(request.command, {
        cwd,
        shell: shell ?? true,
        env: process.env,
        windowsHide: true,
      });

      const cancellationListener = token?.onCancellationRequested(() => {
        if (settled) {
          return;
        }
        this.output.appendLine(`Command cancelled: ${request.command}`);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        finalize(new vscode.CancellationError());
      });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', data => {
        const text = typeof data === 'string' ? data : data.toString();
        if (text) {
          stdout += text;
          this.output.append(text);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', data => {
        const text = typeof data === 'string' ? data : data.toString();
        if (text) {
          stderr += text;
          this.output.append(text);
        }
      });

      child.on('error', error => {
        finalize(error instanceof Error ? error : new Error(String(error)));
      });

      child.on('close', code => {
        if (settled) {
          return;
        }
        if (code === 0) {
          finalize({ command: request.command, stdout, stderr });
        } else {
          const error = new Error(`${request.command} exited with code ${code ?? 'unknown'}`);
          this.output.appendLine(`Command failed: ${error.message}`);
          finalize(error);
        }
      });
    });
  }

  private resolveWorkspacePath(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return folders[0].uri.fsPath;
  }
}
