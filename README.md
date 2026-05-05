# CodeContext+

[![GitHub package.json version](https://img.shields.io/github/package-json/v/ManuelGil/vscode-code-context-plus?style=for-the-badge&logo=github)](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-code-context-plus)
[![GitHub Repo Stars](https://img.shields.io/github/stars/ManuelGil/vscode-code-context-plus?style=for-the-badge&logo=github)](https://github.com/ManuelGil/vscode-code-context-plus)
[![GitHub License](https://img.shields.io/github/license/ManuelGil/vscode-code-context-plus?style=for-the-badge&logo=github)](https://github.com/ManuelGil/vscode-code-context-plus/blob/main/LICENSE)

> See where context exists in your code.

You already write notes and document decisions.

But when you are inside your code, that context is not visible.

CodeContext+ shows you where knowledge exists, directly in your editor.

<img src="https://raw.githubusercontent.com/ManuelGil/vscode-code-context-plus/refs/heads/main/assets/screenshot-1.png" alt="Context appears directly in your code" />

## How it works

CodeContext+ connects your notes with your code.

Each indicator represents real notes linked to that part of the code.

A single line can have multiple related notes, reflecting different decisions, fixes, or explanations.

<img src="https://raw.githubusercontent.com/ManuelGil/vscode-code-context-plus/refs/heads/main/assets/screenshot-2.png" alt="Multiple notes connected to the same line" />

## Navigate context

When you see context, you can open it immediately.

Jump directly from your code to the notes that explain that specific line.

<img src="https://raw.githubusercontent.com/ManuelGil/vscode-code-context-plus/refs/heads/main/assets/screenshot-3.png" alt="Open related notes from your code" />

## Project Overview

CodeContext+ links notes to specific files and lines in your code.

This allows context to be discovered and opened directly from where it is relevant.

## Workflow

1. Create a note
2. Link it to other notes
3. Add references to code (file and line)
4. Open context directly from your code

## The Problem

Code changes quickly, but context does not.

Decisions, explanations, and trade-offs get scattered across comments, documents, pull requests, and memory.

When you need them, they are hard to find.

You don’t just need to navigate files.
You need to navigate knowledge.

## What This Is

CodeContext+ connects notes to specific files and lines through structured references.

It allows developers to see and navigate context directly from files and lines.

## Key Concepts

### Notes

Markdown files that capture context:

- decisions
- explanations
- debugging insights
- architecture notes

### Links

Structured relationships between notes.

They define how knowledge is connected.

### Backlinks

Automatically derived relationships.

They let you discover where a note is referenced from.

### References

Connections between notes and code:

```yaml
references:
  - file: src/auth/service.ts
    line: 42
```

## What Makes It Different

- Works directly inside your code (no context switching)
- Connects notes as a system, not isolated documents
- Makes knowledge navigable, not just stored

## How It Feels

Create a note.
Connect it.
Follow the context.

Instead of searching, you move through understanding.

## Core Features

- See context directly in your code (💡 indicators)
- Open related notes from a specific line
- Connect code to knowledge through references
- Navigate links and backlinks between notes
- Explore related notes from a unified view

## Example

```ts
// TODO: fix token expiration
```

This line might be connected to:

- a bug investigation
- a refactor note
- a design decision

Instead of searching, you see that context immediately - directly in your code.

## Installation

1. Install from the VS Code Marketplace
2. Open a project
3. Start creating notes

## Getting Started

Create a note and add a reference:

```yaml
id: auth-bug
title: Auth Bug
references:
  - file: src/auth/service.ts
    line: 42
```

Open the file → the context appears automatically.

## Philosophy

Code is only part of the system.

Understanding comes from the connections between:

- code
- decisions
- explanations

CodeContext+ helps you see those connections.

## Contributing

CodeContext+ is open-source and welcomes community contributions:

1. Fork the [GitHub repository](https://github.com/ManuelGil/vscode-code-context-plus).
2. Create a new branch:

   ```bash
   git checkout -b feature/your-feature
   ```

3. Make your changes, commit them, and push to your fork.
4. Submit a Pull Request against the `main` branch.

Before contributing, please review the [Contribution Guidelines](https://github.com/ManuelGil/vscode-code-context-plus/blob/main/CONTRIBUTING.md) for coding standards, testing, and commit message conventions. Open an Issue if you find a bug or want to request a new feature.

## Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment for all, regardless of gender, sexual orientation, disability, ethnicity, religion, or other personal characteristic. Please review our [Code of Conduct](https://github.com/ManuelGil/vscode-code-context-plus/blob/main/CODE_OF_CONDUCT.md) before participating in our community.

## Changelog

For a complete list of changes, see the [CHANGELOG.md](https://github.com/ManuelGil/vscode-code-context-plus/blob/main/CHANGELOG.md).

## Authors

- **Manuel Gil** - _Owner_ - [@ManuelGil](https://github.com/ManuelGil)

See also the list of [contributors](https://github.com/ManuelGil/vscode-code-context-plus/contributors) who participated in this project.

## Follow Me

- **GitHub**: [![GitHub followers](https://img.shields.io/github/followers/ManuelGil?style=for-the-badge\&logo=github)](https://github.com/ManuelGil)
- **X (formerly Twitter)**: [![X Follow](https://img.shields.io/twitter/follow/imgildev?style=for-the-badge\&logo=x)](https://twitter.com/imgildev)

## Other Extensions

- **[Auto Barrel](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-auto-barrel)**
  Automatically generates and maintains barrel (`index.ts`) files for your TypeScript projects.

- **[Angular File Generator](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-angular-generator)**
  Generates boilerplate and navigates your Angular (9→20+) project from within the editor, with commands for components, services, directives, modules, pipes, guards, reactive snippets, and JSON2TS transformations.

- **[NestJS File Generator](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-nestjs-generator)**
  Simplifies creation of controllers, services, modules, and more for NestJS projects, with custom commands and Swagger snippets.

- **[NestJS Snippets](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-nestjs-snippets-extension)**
  Ready-to-use code patterns for creating controllers, services, modules, DTOs, filters, interceptors, and more in NestJS.

- **[T3 Stack / NextJS / ReactJS File Generator](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-nextjs-generator)**
  Automates file creation (components, pages, hooks, API routes, etc.) in T3 Stack (Next.js, React) projects and can start your dev server from VSCode.

- **[Drizzle ORM Snippets](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-drizzle-snippets)**
  Collection of code snippets to speed up Drizzle ORM usage, defines schemas, migrations, and common database operations in TypeScript/JavaScript.

- **[CodeIgniter 4 Spark](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-codeigniter4-spark)**
  Scaffolds controllers, models, migrations, libraries, and CLI commands in CodeIgniter 4 projects using Spark, directly from the editor.

- **[CodeIgniter 4 Snippets](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-codeigniter4-snippets)**
  Snippets for accelerating development with CodeIgniter 4, including controllers, models, validations, and more.

- **[CodeIgniter 4 Shield Snippets](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-codeigniter4-shield-snippets)**
  Snippets tailored to CodeIgniter 4 Shield for faster authentication and security-related code.

- **[Mustache Template Engine - Snippets & Autocomplete](https://marketplace.visualstudio.com/items?itemName=imgildev.vscode-mustache-snippets)**
  Snippets and autocomplete support for Mustache templates, making HTML templating faster and more reliable.

## Recommended Browser Extension

For developers who work with `.vsix` files for offline installations or distribution, the complementary [**One-Click VSIX**](https://chromewebstore.google.com/detail/imojppdbcecfpeafjagncfplelddhigc?utm_source=item-share-cb) extension is recommended, available for both Chrome and Firefox.

> **One-Click VSIX** integrates a direct "Download Extension" button into each VSCode Marketplace page, ensuring the file is saved with the `.vsix` extension, even if the server provides a `.zip` archive. This simplifies the process of installing or sharing extensions offline by eliminating the need for manual file renaming.

- [Get One-Click VSIX for Chrome &rarr;](https://chromewebstore.google.com/detail/imojppdbcecfpeafjagncfplelddhigc?utm_source=item-share-cb)
- [Get One-Click VSIX for Firefox &rarr;](https://addons.mozilla.org/es-ES/firefox/addon/one-click-vsix/)

## License

This project is licensed under the **MIT License**. See the [LICENSE](https://github.com/ManuelGil/vscode-code-context-plus/blob/main/LICENSE) file for details.
