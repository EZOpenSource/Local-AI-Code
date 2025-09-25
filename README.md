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

