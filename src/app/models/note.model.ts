import { Uri } from 'vscode';

// -----------------------------------------------------------------------------
// Identity & validation
// -----------------------------------------------------------------------------

/**
 * Output of scanning Markdown notes for frontmatter `id` presence and uniqueness.
 *
 * `index` maps declared ids to note URIs when uniquely identifiable.
 */
export interface NotesIdentityValidationResult {
  index: Map<string, Uri>;
  errors: NotesIdentityValidationError[];
  warnings: NotesIdentityValidationWarning[];
}

export type NotesIdentityValidationError =
  | {
      type: 'missing-id';
      file: Uri;
    }
  | {
      type: 'duplicated-id';
      id: string;
      files: Uri[];
    };

/**
 * Non-fatal filename vs frontmatter `id` mismatch (identity remains frontmatter-driven).
 */
export type NotesIdentityValidationWarning = {
  type: 'filename-mismatch';
  id: string;
  file: Uri;
  filenameBase: string;
};

// -----------------------------------------------------------------------------
// Core note model
// -----------------------------------------------------------------------------

/** Single `references:` row from YAML frontmatter (paths not yet resolved to workspace URIs). */
export type DeclaredReference = {
  file: string;
  /** Single 1-based line number for precise reference. */
  line?: number;
  /** Optional inclusive end line for range references (1-based). */
  endLine?: number;
  /** Optional lightweight symbol identifier (compatibility for compact syntax only). */
  symbol?: string;
};

/** Markdown note payload loaded from disk (including fields parsed from frontmatter). */
export interface Note {
  id: string;
  title: string;
  content: string;
  filePath: string;
  createdAt: Date;
  updatedAt: Date;
  tags?: string[];
  links?: string[];
  references?: DeclaredReference[];
  type?: string;
  summary?: string;
}

/** Describes an editor-insertable Markdown link targeting another note or location. */
export interface NoteLink {
  notePath: string;
  noteTitle: string;
  targetFilePath?: string;
  targetLine?: number;
}

// -----------------------------------------------------------------------------
// Tree view models
// -----------------------------------------------------------------------------

/** Explorer root row representing one Markdown note file. */
export type NoteTreeNode = {
  type: 'note';
  id: string;
  uri: Uri;
  title?: string;
};

/** Collapsible group for outgoing links vs backlinks under a note row. */
export type RelationGroupTreeNode = {
  type: 'group';
  relation: 'links' | 'backlinks';
  parentId: string;
  parentUri: Uri;
};

/** Leaf row for a linked or backlinked note under a relation group. */
export type RelatedNoteTreeNode = {
  type: 'related';
  id: string;
  uri: Uri;
  title?: string;
  relation: 'links' | 'backlinks';
};

export type NotesTreeNode =
  | NoteTreeNode
  | RelationGroupTreeNode
  | RelatedNoteTreeNode;

// -----------------------------------------------------------------------------
// Results & DTOs
// -----------------------------------------------------------------------------

/** Minimal descriptor for a note as `{ id, uri, optional title }` (links/backlinks surfaces). */
export type NoteReference = {
  id: string;
  uri: Uri;
  title?: string;
};

/** Notes whose declared frontmatter `links` include the target id (frontmatter-only derivation). */
export type BacklinkSourcesResult = {
  sources: NoteReference[];
};

/**
 * Resolved outbound `links` ids against the identity index.
 *
 * `valid` pairs ids with workspace URIs; `broken` lists ids with no matching note file.
 */
export type ResolvedLinksResult = {
  valid: { id: string; uri: Uri }[];
  broken: string[];
};

/**
 * Resolved `references:` targets against workspace paths.
 *
 * `broken` captures invalid paths or missing files without throwing for individual references.
 */
export type ResolvedReferencesResult = {
  valid: { file: string; uri: Uri; line?: number }[];
  broken: { file: string; reason: string }[];
};

// -----------------------------------------------------------------------------
// Shared parsing & operations
// -----------------------------------------------------------------------------

/**
 * Per-operation shared state: avoids repeated filesystem scans within one orchestrated call.
 * Not a global cache — discard after the operation completes.
 */
export type OperationContext = {
  noteUris?: Uri[];
};

/** Result of tolerant frontmatter parsing; inspect `errors` for recoverable issues. */
export type SafeParseResult<T> = {
  data: T | null;
  errors: string[];
};

/** Identity-related fields extracted from YAML frontmatter (not inferred from body). */
export type FrontmatterIdentity = {
  id?: string;
  title?: string;
  links: string[];
};
