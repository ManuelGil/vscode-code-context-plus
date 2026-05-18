# Change Log

All notable changes to the "CodeContext+" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-05-18

### Added

- Add lightweight contextual hover previews showing note title, summary, reference counts, and quick actions.
- Add transient "Preview context" QuickPick command for line-level context preview.
- Add session-scoped contextual continuity memory to track recent contextual navigations and enable continuity breadcrumbs.
- Add deterministic contextual prioritization (recency, operational type, locality) for hovers and previews.
- Add optional `type` frontmatter support for bounded operational typing.

### Changed

- Centralize reference and metadata normalization (paths, lines, links, tags) for deterministic runtime semantics.
- Refactor reference parsing, decorators, and services to use centralized normalization and improve path/line determinism.
- Implement contextual density throttling and grouping for decorators to keep editor surfaces lightweight and local-first.
- Integrate continuity memory with note opening flows and previews; show transient context breadcrumbs in the status bar.
- Add regression tests covering hybrid references, path/line normalization, and decoration stability.

## [1.1.0] - 2026-05-09

### Added

- Add tolerant frontmatter parsing for tags and links

### Changed

- Preserve explicit empty tag lists when saving notes.
- Update note lists to show tags only when they are present

### Fixed

- Fix note frontmatter parsing for list fields and quoted values.
- Fix note creation when no tags are provided

## [1.0.0] - 2026-05-04

### Added

- Initial release of CodeContext+ extension

[Unreleased]: https://github.com/ManuelGil/vscode-code-context-plus/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/ManuelGil/vscode-code-context-plus/releases/tag/v1.2.0
[1.1.0]: https://github.com/ManuelGil/vscode-code-context-plus/releases/tag/v1.1.0
[1.0.0]: https://github.com/ManuelGil/vscode-code-context-plus/releases/tag/v1.0.0
