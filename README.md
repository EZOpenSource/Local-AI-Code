# Local Ai Coder for Visual Studio Code

Local Ai Coder is a Visual Studio Code extension that embeds a fully local AI coding partner directly inside the editor. The assistant reads your project, drafts step-by-step plans, proposes shell/PowerShell commands, and prepares file changes—all of which are executed only after you explicitly approve them. No external APIs are called at runtime; inference is handled by a locally running [Ollama](https://ollama.com/) daemon that you control.

## Key capabilities

- **Workspace awareness** – Streams the relevant files from the open workspace into the prompt while respecting size limits and ignoring common build artifacts, with controls to fine-tune which folders are excluded.
- **Local-first inference** – Streams responses from an Ollama model running on your machine. Choose any Ollama model identifier in the extension settings and the assistant will download and serve it locally.
- **Collaborative reasoning** – Orchestrates a context scout, planner, coder, reviewer, QA analyst, safety auditor, and verifier so each stage critiques and augments the plan before you see it.
- **Embedded QA and safety** – The QA role populates test expectations while the safety auditor flags risky commands or file operations and adds mitigation steps automatically.
- **Role-specific models** – Choose distinct Ollama models for planning/thinking and hands-on coding directly from the chat view settings.
- **Custom prompt styles** – Assign different prompt builders to the context scout, planner, coder, reviewer, QA, safety auditor, and verifier so every role reasons with instructions tuned to its responsibilities.
- **Automated JSON verification** – Route every response through a verification model that ensures the final plan is valid JSON matching the required schema and catches semantic mismatches across steps, commands, and file actions.
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
   - Pull the default planner/reviewer stack by running:
     ```bash
     ollama pull qwen2.5-coder:7b
     ollama pull deepseek-coder:6.7b
     ollama pull phi3:mini
     ```
     You can also use **Local Ai Coder: Download Model** inside VS Code to fetch each configured model automatically.

## Configuration options

All settings live under the `ai-code` namespace. Key options include:

| Setting | Description |
| --- | --- |
| `ai-code.modelId` | Ollama identifier prefixed with `ollama:` for the planning/thinking role. Defaults to `ollama:qwen2.5-coder:7b`, which fits comfortably on 16 GB machines. |
| `ai-code.collaboratorModelId` | Optional second Ollama identifier for the reviewing role that polishes the coder output before QA. Defaults to `ollama:deepseek-coder:6.7b`; clear the field to reuse the planner. |
| `ai-code.coderModelId` | Optional Ollama identifier for the coding role that turns the planner's draft into concrete file actions. Leave blank to reuse the reviewer model. |
| `ai-code.verifierModelId` | Optional third Ollama identifier dedicated to verifying that responses are valid JSON. Defaults to the lightweight `ollama:phi3:mini`; clear the field to reuse the collaborator. |
| `ai-code.promptBuilders.contextScout` | Prompt builder identifier for the context scout. Leave blank to inherit the planner prompt builder. Examples: `structured-default/contextScout`, `concise-strategist/contextScout`. |
| `ai-code.promptBuilders.planner` | Prompt builder identifier for the planner. Leave blank to use the default comprehensive instructions. Examples: `structured-default/planner`, `concise-strategist/planner`. |
| `ai-code.promptBuilders.reviewer` | Prompt builder identifier for the reviewer. Leave blank to inherit the planner prompt builder. Examples: `structured-default/reviewer`, `concise-strategist/reviewer`. |
| `ai-code.promptBuilders.coder` | Prompt builder identifier for the coder. Leave blank to inherit the reviewer prompt builder. Examples: `structured-default/coder`, `concise-strategist/coder`. |
| `ai-code.promptBuilders.qa` | Prompt builder identifier for the QA role. Leave blank to inherit the reviewer prompt builder. Examples: `structured-default/qa`, `concise-strategist/qa`. |
| `ai-code.promptBuilders.safety` | Prompt builder identifier for the safety auditor. Leave blank to inherit the QA prompt builder. Examples: `structured-default/safety`, `concise-strategist/safety`. |
| `ai-code.promptBuilders.verifier` | Prompt builder identifier for the verifier. Leave blank to inherit the safety prompt builder. Examples: `structured-default/verifier`, `concise-strategist/verifier`. |
| `ai-code.collaboration.showLiveStream` | When enabled, surfaces the planner/reviewer conversation live as each model streams its draft. |
| `ai-code.maxNewTokens` | Maximum number of tokens generated per reply. |
| `ai-code.temperature` | Sampling temperature controlling creativity. |
| `ai-code.temperature.<role>` | Per-role temperature override for `contextScout`, `planner`, `reviewer`, `qa`, `safety`, or `verifier`. The verifier defaults to `0` for deterministic JSON checking. |
| `ai-code.context.maxFiles` | Limit on how many files are streamed into the model context. |
| `ai-code.context.maxFileSize` | Maximum size (kilobytes) for any individual file considered for context. |
| `ai-code.context.maxTotalSize` | Total kilobyte budget across all files included in the context. |
| `ai-code.allowCommandExecution` | If false, command suggestions are logged but never executed. |
| `ai-code.shell` | Shell executable used for approved commands. Set to `powershell` on Windows for PowerShell support. |
| `ai-code.context.includeBinary` | When enabled, permits binary files in the context stream (disabled by default). |
| `ai-code.context.excludeGlobs` | Extra glob patterns to exclude from context collection. |
| `ai-code.context.overrideDefaultExcludes` | When true, only the custom exclude globs are applied (default excludes are ignored). |
| `ai-code.context.prioritizeChangedFiles` | Prefer Git changed and staged files when building the context payload. |
| `ai-code.ollama.requestTimeoutMs` | Timeout (seconds) for Ollama REST requests such as `/api/pull` and `/api/show`. |
| `ai-code.ollama.generationTimeoutMs` | Timeout (seconds) for Ollama generation streaming requests. |
| `ai-code.sampling.topP` | `top_p` nucleus sampling value forwarded to Ollama generations. |
| `ai-code.sampling.topP.<role>` | Per-role `top_p` override for `contextScout`, `planner`, `reviewer`, `qa`, `safety`, or `verifier`. |
| `ai-code.sampling.repetitionPenalty` | Repetition penalty applied during generation. |
| `ai-code.sampling.repetitionPenalty.<role>` | Per-role repetition penalty override for `contextScout`, `planner`, `reviewer`, `qa`, `safety`, or `verifier`. |

When you point `ai-code.modelId`, `ai-code.collaboratorModelId`, `ai-code.coderModelId`, and `ai-code.verifierModelId` at different Ollama models, the planner drafts a response, the coder implements it, the collaborator reviews those changes, QA stress-tests the plan, safety adds mitigations, and the verifier enforces JSON formatting before the plan reaches you. Leaving the collaborator, coder, or verifier fields blank reuses the upstream role so you can choose between a single-model setup and the full multi-stage review.

Coder outputs now spell out how each file action will be applied: they note that `FileActionExecutor.apply` wraps `vscode.workspace.fs.writeFile` so you can see exactly how on-disk changes land before granting approval.

Use **Local Ai Coder: Download Model** to have the extension pull the configured Ollama model and warm the cache before you start chatting.

The **Quick Actions** view in the Local Ai Coder activity bar exposes shortcuts for opening the extension settings or downloading the currently selected model without crafting a prompt. The chat view’s settings menu now also lets you forget saved Ollama models, reset every `ai-code` preference back to its defaults, or fire a built-in “Hello, World!” debug prompt to verify the multi-agent workflow end-to-end.

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
