# Agent Guidelines

## Repository scope
These instructions apply to the entire `AI-Code` repository.

## Conventions
- This project is a VS Code extension written in TypeScript; keep the code idiomatic and prefer modern TypeScript/ES modules.
- Update documentation alongside functional changes when relevant (for example, update `README.md` if user-facing behavior changes).

## Required checks
- After making code changes, run `npm run compile` to ensure the extension builds successfully.
- If you modify TypeScript sources under `src/`, also run `npm run test` (an alias for the compile step) before finishing.