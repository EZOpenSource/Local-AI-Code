# Local Ai Coder for Visual Studio Code

Local Ai Coder is a Visual Studio Code extension that embeds a fully local AI coding partner directly inside the editor. The assistant reads your project, drafts step-by-step plans, proposes shell/PowerShell commands, and prepares file changes—all of which are executed only after you explicitly approve them. No external APIs are called at runtime; inference is handled by a locally running [Ollama](https://ollama.com/) daemon that you control.

## Key capabilities

- **Workspace awareness** – Streams the relevant files from the open workspace into the prompt while respecting size limits and ignoring common build artifacts, with controls to fine-tune which folders are excluded.
- **Local-first inference** – Streams responses from an Ollama model running on your machine. Choose any Ollama model identifier in the extension settings and the assistant will download and serve it locally.
- **Guarded shell access** – The assistant can suggest PowerShell or shell commands. Each command is shown to you with full context and runs only after you press **Approve**.
- **Safe file operations** – File creations, edits, and deletions are surfaced as actionable items with previews and explicit confirmation prompts before changes are applied to disk.
- **Interruptible workflows** – Track live progress for shell commands and file operations right inside the chat view and cancel long-running plans with a single click.
- **Conversation memory** – Maintains a rolling, persisted conversation history so follow-up questions benefit from earlier context—even across reloads. Reset the memory at any time with the *Local Ai Coder: Reset Conversation* command.

## Getting started

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Compile the extension**
   ```bash
   npm run compile
   ```
3. **Launch the extension**
   - Open this folder in Visual Studio Code.
   - Open `extension.ts` and press **F5** to start a new Extension Development Host.
   - Run the command **Local Ai Coder: Ask** from the Command Palette.
4. **Prepare Ollama**
   - Install Ollama from [ollama.com](https://ollama.com/) and ensure the `ollama` CLI is on your `PATH`.
   - Pull the default model by running `ollama pull qwen3:4b` or use **Local Ai Coder: Download Model** inside VS Code to fetch it automatically.

## Configuration options

All settings live under the `ai-code` namespace. Key options include:

| Setting | Description |
| --- | --- |
| `ai-code.modelId` | Ollama identifier prefixed with `ollama:`. Defaults to `ollama:qwen3:4b`. |
| `ai-code.maxNewTokens` | Maximum number of tokens generated per reply. |
| `ai-code.temperature` | Sampling temperature controlling creativity. |
| `ai-code.context.maxFiles` | Limit on how many files are streamed into the model context. |
| `ai-code.context.maxFileSize` | Maximum size (bytes) for any individual file considered for context. |
| `ai-code.context.maxTotalSize` | Total byte budget across all files included in the context. |
| `ai-code.allowCommandExecution` | If false, command suggestions are logged but never executed. |
| `ai-code.shell` | Shell executable used for approved commands. Set to `powershell` on Windows for PowerShell support. |
| `ai-code.context.includeBinary` | When enabled, permits binary files in the context stream (disabled by default). |
| `ai-code.context.excludeGlobs` | Extra glob patterns to exclude from context collection. |
| `ai-code.context.overrideDefaultExcludes` | When true, only the custom exclude globs are applied (default excludes are ignored). |
| `ai-code.context.prioritizeChangedFiles` | Prefer Git changed and staged files when building the context payload. |
| `ai-code.ollama.requestTimeoutMs` | Timeout (milliseconds) for Ollama REST requests such as `/api/pull` and `/api/show`. |
| `ai-code.ollama.generationTimeoutMs` | Timeout (milliseconds) for Ollama generation streaming requests. |
| `ai-code.sampling.topP` | `top_p` nucleus sampling value forwarded to Ollama generations. |
| `ai-code.sampling.repetitionPenalty` | Repetition penalty applied during generation. |

Use **Local Ai Coder: Download Model** to have the extension pull the configured Ollama model and warm the cache before you start chatting.

The **Quick Actions** view in the Local Ai Coder activity bar exposes shortcuts for opening the extension settings or downloading the currently selected model without crafting a prompt.

MIT © 2024 Local Dev

## Offline conversion workflow

The `scripts/convert_model.py` helper wraps `optimum` so you can produce the ONNX assets transformers.js expects:

1. Ensure Python 3.10+ is available and install the conversion toolchain:
   ```powershell
   pip install "transformers>=4.38" "optimum[onnxruntime]" onnx onnxruntime
   ```
2. Export the model (the example below targets Code Llama):
   ```powershell
   npm run convert:model -- --model meta-llama/CodeLlama-7b-Instruct-hf --output "C:\models\CodeLlama7B"
   ```
3. Register the exported assets with Ollama using `ollama create` and choose a model name (for example, `ollama create codellama-7b --path "C:\\models\\CodeLlama7B"`).
4. Update the `ai-code.modelId` setting to the Ollama reference you created (for example, `ollama:codellama-7b`) and run **Local Ai Coder: Download Model** to warm the cache.

The script copies `config.json`, `tokenizer.json`, and `generation_config.json` alongside the ONNX runtime graph in `onnx/`. Feel free to keep a library of converted models and swap between them by updating the `ai-code.modelId` setting. Ollama performs any needed quantization at runtime, so no additional steps are required here.
