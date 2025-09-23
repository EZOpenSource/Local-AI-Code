import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';

export interface GenerationConfig {
  modelId: string;
  maxNewTokens: number;
  temperature: number;
  topP: number;
  repetitionPenalty: number;
  requestTimeoutMs: number;
  generationTimeoutMs: number;
}

type TextGenerationPipeline = (
  prompt: string,
  options: Record<string, unknown>,
  token?: vscode.CancellationToken
) => Promise<Array<{ generated_text: string }>>;

export class LocalModel {
  private pipeline: TextGenerationPipeline | null = null;
  private modelId: string | null = null;
  private loadingPromise: Promise<TextGenerationPipeline> | null = null;

  private throwIfCancelled(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }

  public isLoaded(modelId?: string): boolean {
    if (!this.pipeline) {
      return false;
    }
    return modelId ? this.modelId === modelId : true;
  }

  public async ensureLoaded(
    config: GenerationConfig,
    onProgress?: (status: string) => void,
    token?: vscode.CancellationToken
  ): Promise<void> {
    if (this.pipeline && this.modelId === config.modelId) {
      return;
    }
    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }
    this.throwIfCancelled(token);
    this.loadingPromise = this.loadPipeline(config, onProgress, token);
    try {
      const pipeline = await this.loadingPromise;
      this.pipeline = pipeline;
      this.modelId = config.modelId;
    } finally {
      this.loadingPromise = null;
    }
  }

  public async generate(
    prompt: string,
    config: GenerationConfig,
    onToken?: (token: string) => void,
    token?: vscode.CancellationToken
  ): Promise<string> {
    await this.ensureLoaded(config, undefined, token);
    this.throwIfCancelled(token);
    if (!this.pipeline) {
      throw new Error('Model pipeline failed to load.');
    }

    const generator = this.pipeline;
    const response = await generator(prompt, {
      max_new_tokens: config.maxNewTokens,
      temperature: config.temperature,
      top_p: config.topP,
      repetition_penalty: config.repetitionPenalty,
      callback_function: (tokens: string | string[]) => {
        const chunk = Array.isArray(tokens) ? tokens.join('') : tokens;
        if (chunk && onToken) {
          onToken(chunk);
        }
      },
    }, token);

    const generated = response?.[0]?.generated_text ?? '';
    return generated.substring(prompt.length) || generated;
  }

  private async loadPipeline(
    config: GenerationConfig,
    onProgress?: (status: string) => void,
    token?: vscode.CancellationToken
  ): Promise<TextGenerationPipeline> {
    if (!this.isOllamaModel(config.modelId)) {
      throw new Error('Only Ollama models are supported. Use the form "ollama:<model>".');
    }
    return this.loadOllamaPipeline(config, onProgress, token);
  }

  private isOllamaModel(modelId: string): boolean {
    return modelId.trim().toLowerCase().startsWith('ollama:');
  }

  private getOllamaModelName(modelId: string): string {
    const withoutPrefix = modelId.trim().replace(/^ollama:/i, '');
    return withoutPrefix.startsWith('//') ? withoutPrefix.slice(2) : withoutPrefix;
  }

  private getOllamaEndpoint(): URL {
    const configured = process.env.OLLAMA_HOST?.trim();
    if (configured) {
      const parsed = this.tryParseUrl(configured) ?? this.tryParseUrl(`http://${configured}`);
      if (parsed) {
        return parsed;
      }
    }
    return new URL('http://127.0.0.1:11434');
  }

  private tryParseUrl(value: string): URL | null {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }

  private buildOllamaRequestOptions(endpoint: URL, path: string): http.RequestOptions {
    const clientPathBase = endpoint.pathname.endsWith('/') ? endpoint.pathname.slice(0, -1) : endpoint.pathname;
    const requestPath = `${clientPathBase}${path.startsWith('/') ? path : `/${path}`}` || '/';
    const isHttps = endpoint.protocol === 'https:';
    const port = endpoint.port
      ? Number(endpoint.port)
      : isHttps
        ? 443
        : 11434;

    const options: http.RequestOptions = {
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (endpoint.username || endpoint.password) {
      const credentials = `${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`;
      options.headers = {
        ...options.headers,
        Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
      };
    }

    return options;
  }

  private async requestOllama<T>(
    endpoint: URL,
    path: string,
    body: unknown,
    timeoutMs: number,
    token?: vscode.CancellationToken
  ): Promise<T> {
    this.throwIfCancelled(token);
    const payload = body ? JSON.stringify(body) : '{}';
    const options = this.buildOllamaRequestOptions(endpoint, path);
    const client = options.protocol === 'https:' ? https : http;

    return new Promise<T>((resolve, reject) => {
      let cancellationListener: vscode.Disposable | undefined;
      let settled = false;
      const finalize = (result: T | Error) => {
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

      const req = client.request(options, res => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const errorChunks: string[] = [];
          res.setEncoding('utf8');
          res.on('data', chunk => errorChunks.push(chunk));
          res.on('end', () => {
            const errorBody = errorChunks.join('');
            finalize(new Error(`Ollama request failed (${res.statusCode}): ${errorBody || 'No response body'}`));
          });
          return;
        }

        const chunks: string[] = [];
        res.setEncoding('utf8');
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = chunks.join('');
            if (!text) {
              finalize({} as T);
              return;
            }
            const parsed = JSON.parse(text) as { error?: string } & T;
            if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error) {
              finalize(new Error(parsed.error));
              return;
            }
            finalize(parsed);
          } catch (error) {
            finalize(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      cancellationListener = token?.onCancellationRequested(() => {
        const cancelError = new vscode.CancellationError();
        req.destroy(cancelError);
        finalize(cancelError);
      });

      req.on('error', error => {
        finalize(error instanceof Error ? error : new Error(String(error)));
      });

      req.setTimeout(timeoutMs, () => {
        const timeoutError = new Error('Ollama request timed out.');
        req.destroy(timeoutError);
        finalize(timeoutError);
      });

      req.write(payload);
      req.end();
    });
  }

  private async loadOllamaPipeline(
    config: GenerationConfig,
    onProgress?: (status: string) => void,
    token?: vscode.CancellationToken
  ): Promise<TextGenerationPipeline> {
    const modelName = this.getOllamaModelName(config.modelId);
    if (!modelName) {
      throw new Error(`Invalid Ollama model identifier: ${config.modelId}`);
    }

    const endpoint = this.getOllamaEndpoint();
    const report = (status: string) => {
      if (onProgress) {
        onProgress(status);
      }
      console.log(`[ai-code] ${status}`);
    };

    report(`Contacting Ollama at ${endpoint.origin} for model ${modelName}...`);
    await this.pullOllamaModel(endpoint, modelName, report, config.requestTimeoutMs, token);
    try {
      await this.requestOllama<Record<string, unknown>>(endpoint, '/api/show', { model: modelName }, config.requestTimeoutMs, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to query Ollama for model "${modelName}": ${message}`);
    }

    report('Ollama model ready.');
    return async (prompt, options, generationToken) =>
      this.invokeOllamaGenerate(endpoint, modelName, prompt, options, config, generationToken);
  }

  private async pullOllamaModel(
    endpoint: URL,
    modelName: string,
    report: (status: string) => void,
    timeoutMs: number,
    token?: vscode.CancellationToken
  ): Promise<void> {
    this.throwIfCancelled(token);
    report(`Ensuring Ollama has downloaded and prepared ${modelName} (this may take a while for first-time setup)...`);

    const payload = JSON.stringify({ model: modelName, stream: true });
    const requestOptions = this.buildOllamaRequestOptions(endpoint, '/api/pull');
    requestOptions.headers = {
      ...(requestOptions.headers ?? {}),
      'Content-Length': Buffer.byteLength(payload),
    };

    const client = requestOptions.protocol === 'https:' ? https : http;

    await new Promise<void>((resolve, reject) => {
      let cancellationListener: vscode.Disposable | undefined;
      let settled = false;
      const finalize = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cancellationListener?.dispose();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const progressByKey = new Map<string, { completed?: number; total?: number }>();
      let currentStatus = 'Preparing download...';
      let lastRendered: string | undefined;
      let sawSuccess = false;

      const renderProgress = () => {
        let totalCompleted = 0;
        let totalTotal = 0;
        for (const state of progressByKey.values()) {
          if (typeof state.total === 'number' && state.total > 0) {
            totalTotal += state.total;
            if (typeof state.completed === 'number') {
              totalCompleted += Math.min(state.completed, state.total);
            }
          }
        }

        const ratio = totalTotal > 0 ? Math.max(0, Math.min(1, totalCompleted / totalTotal)) : undefined;
        const parts: string[] = [];
        if (ratio !== undefined) {
          const percent = Math.round(ratio * 100);
          parts.push(`${this.renderProgressBar(ratio)} ${percent}%`);
        }
        parts.push(currentStatus);

        const message = parts.filter(Boolean).join(' ').trim();
        if (message && message !== lastRendered) {
          lastRendered = message;
          report(message);
        }
      };

      const req = client.request(requestOptions, res => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const errorChunks: string[] = [];
          res.setEncoding('utf8');
          res.on('data', chunk => errorChunks.push(chunk));
          res.on('end', () => {
            const errorBody = errorChunks.join('');
            finalize(new Error(`Ollama pull failed (${res.statusCode}): ${errorBody || 'No response body'}`));
          });
          return;
        }

        res.setEncoding('utf8');
        let buffer = '';

        const processLine = (line: string) => {
          if (!line) {
            return;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }

          if (parsed && typeof parsed.error === 'string' && parsed.error) {
            finalize(new Error(parsed.error));
            req.destroy();
            return;
          }

          if (typeof parsed.status === 'string' && parsed.status) {
            currentStatus = parsed.status.trim();
          }

          const key = typeof parsed.digest === 'string' && parsed.digest ? parsed.digest : parsed.status ?? 'default';
          if (!progressByKey.has(key)) {
            progressByKey.set(key, {});
          }
          const entry = progressByKey.get(key)!;
          if (typeof parsed.total === 'number') {
            entry.total = parsed.total;
          }
          if (typeof parsed.completed === 'number') {
            entry.completed = parsed.completed;
          }

          if (parsed.status === 'success') {
            sawSuccess = true;
          }

          renderProgress();
        };

        res.on('data', chunk => {
          buffer += chunk;
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            processLine(line);
            newlineIndex = buffer.indexOf('\n');
          }
        });

        res.on('end', () => {
          const remaining = buffer.trim();
          if (remaining) {
            processLine(remaining);
          }

          if (!sawSuccess) {
            finalize(new Error('Ollama pull ended without success confirmation.'));
            return;
          }

          currentStatus = 'Model downloaded by Ollama.';
          renderProgress();
          finalize();
        });
      });

      cancellationListener = token?.onCancellationRequested(() => {
        const cancelError = new vscode.CancellationError();
        req.destroy(cancelError);
        finalize(cancelError);
      });

      req.setTimeout(timeoutMs, () => {
        const timeoutError = new Error('Ollama pull timed out.');
        req.destroy(timeoutError);
        finalize(timeoutError);
      });

      req.on('error', error => {
        finalize(error instanceof Error ? error : new Error(String(error)));
      });

      req.write(payload);
      req.end();
    });
  }

  private renderProgressBar(ratio: number, width = 24): string {
    const clamped = Math.max(0, Math.min(1, ratio));
    const filled = Math.min(width, Math.max(0, Math.round(clamped * width)));
    const empty = Math.max(0, width - filled);
    return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
  }

  private async invokeOllamaGenerate(
    endpoint: URL,
    modelName: string,
    prompt: string,
    options: Record<string, unknown>,
    config: GenerationConfig,
    token?: vscode.CancellationToken
  ): Promise<Array<{ generated_text: string }>> {
    this.throwIfCancelled(token);
    const callback = typeof options.callback_function === 'function' ? options.callback_function : undefined;

    const generationOptions: Record<string, number> = {};
    if (typeof options.max_new_tokens === 'number') {
      generationOptions.num_predict = options.max_new_tokens;
    }
    if (typeof options.temperature === 'number') {
      generationOptions.temperature = options.temperature;
    }
    if (typeof options.top_p === 'number') {
      generationOptions.top_p = options.top_p;
    }
    if (typeof options.repetition_penalty === 'number') {
      generationOptions.repeat_penalty = options.repetition_penalty;
    }

    const payload = JSON.stringify({
      model: modelName,
      prompt,
      stream: true,
      options: generationOptions,
    });

    const requestOptions = this.buildOllamaRequestOptions(endpoint, '/api/generate');
    requestOptions.headers = {
      ...(requestOptions.headers ?? {}),
      'Content-Length': Buffer.byteLength(payload),
    };
    const client = requestOptions.protocol === 'https:' ? https : http;

    return new Promise<Array<{ generated_text: string }>>((resolve, reject) => {
      let cancellationListener: vscode.Disposable | undefined;
      let settled = false;
      let inactivityTimer: NodeJS.Timeout | undefined;
      let req!: http.ClientRequest;

      const clearInactivityTimer = () => {
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = undefined;
        }
      };

      const finalize = (result: Array<{ generated_text: string }> | Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInactivityTimer();
        cancellationListener?.dispose();
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      const refreshInactivityTimer = () => {
        if (settled || config.generationTimeoutMs <= 0) {
          return;
        }
        clearInactivityTimer();
        inactivityTimer = setTimeout(() => {
          const timeoutError = new Error('Ollama generation timed out.');
          req.destroy(timeoutError);
          finalize(timeoutError);
        }, config.generationTimeoutMs);
      };

      req = client.request(requestOptions, res => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const errorChunks: string[] = [];
          res.setEncoding('utf8');
          res.on('data', chunk => errorChunks.push(chunk));
          res.on('end', () => {
            const errorBody = errorChunks.join('');
            finalize(new Error(`Ollama generate failed (${res.statusCode}): ${errorBody || 'No response body'}`));
          });
          return;
        }

        res.setEncoding('utf8');
        let buffer = '';
        let generated = '';

        const processLine = (line: string) => {
          if (!line) {
            return;
          }
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }

          if (parsed && typeof parsed.error === 'string' && parsed.error) {
            finalize(new Error(parsed.error));
            req.destroy();
            return;
          }

          const token = typeof parsed.response === 'string' ? parsed.response : '';
          if (token) {
            generated += token;
            if (callback) {
              callback(token);
            }
          }

          if (parsed.done) {
            finalize([{ generated_text: prompt + generated }]);
          }
        };

        res.on('data', chunk => {
          refreshInactivityTimer();
          buffer += chunk;
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            processLine(line);
            newlineIndex = buffer.indexOf('\n');
          }
        });

        res.on('end', () => {
          const remaining = buffer.trim();
          if (remaining) {
            processLine(remaining);
          }
          if (!settled) {
            finalize([{ generated_text: prompt + generated }]);
          }
        });
      });

      cancellationListener = token?.onCancellationRequested(() => {
        const cancelError = new vscode.CancellationError();
        req.destroy(cancelError);
        finalize(cancelError);
      });

      req.on('error', error => {
        finalize(error instanceof Error ? error : new Error(String(error)));
      });

      refreshInactivityTimer();

      req.write(payload);
      req.end();
    });
  }
}
