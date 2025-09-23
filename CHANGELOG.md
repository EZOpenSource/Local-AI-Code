# Changelog

## Unreleased
- Added a collaborative planner/reviewer pipeline that lets two local Ollama models refine each other's work before presenting a plan to the user.
- Introduced the `ai-code.collaboratorModelId` setting so you can pick a dedicated reviewer model.
- Added the `ai-code.collaboration.showLiveStream` toggle to surface the planner and reviewer dialogue in real time.
- Expanded the collaboration flow with a context scout, QA analyst, and safety auditor so plans ship with test guidance and risk mitigation baked in before verification.
- Added per-role prompt builder selections in the chat view so the context scout, planner, reviewer, QA, safety, and verifier stages can each be configured independently.
- Split the prompt builder catalog into role-specific identifiers (for example `structured-default/qa`) so every stage can advertise tailored instructions without sharing IDs.
- Introduced an optional `ai-code.coderModelId` setting so the coding stage can run on a dedicated Ollama model separate from the reviewer.
- Strengthened the verifier prompts to enforce semantic consistency across steps, commands, and file actions in addition to JSON validity.
- Added per-role sampling controls (temperature, top-p, and repetition penalty) so each agent can run with tuned creativity—defaulting the verifier to deterministic JSON enforcement.
- Updated the default planner, reviewer, and verifier models to `ollama:qwen2.5-coder:7b`, `ollama:deepseek-coder:6.7b`, and `ollama:phi3:mini` so new installations run well within a 16 GB RAM budget.
- Logged the full contextScout → planner → coder → reviewer → QA → safety → verifier sequence when collaboration starts and updated coder/QA prompts to spell out that FileActionExecutor.apply wraps `vscode.workspace.fs.writeFile` for every file action.
- Reordered the collaboration pipeline so the coder implements the planner's draft before the reviewer polishes it.
- Added chat-view settings shortcuts to forget saved Ollama models, reset every `ai-code` preference to defaults, and trigger a built-in “Hello, World!” debug prompt that exercises the full agent chain.
- Strengthened the planner/coder prompts with a concrete JSON example so assistants emit fileActions reliably and added integration tests that prove parsed plans create files (or safely no-op when empty).

## 0.0.1
- Initial release of Local Ai Coder with local model execution, workspace context streaming, command approvals, and
  file-action approvals.
