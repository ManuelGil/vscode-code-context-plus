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

/**
 * Single `references:` row from YAML frontmatter (paths not yet resolved to workspace URIs).
 *
 * @remarks
 * `file` is the only required field; everything else narrows the reference and makes it
 * recoverable after the code moves. The fields divide into two groups:
 *
 * - **Position** (`line`, `endLine`, `column`, `endColumn`): where the code was. Exact while
 *   nothing above it changes, and worthless once it does.
 * - **Identity** (`symbol`, `anchor`): what the code *is*. Neither can be reconstructed later,
 *   which is why both are persisted; everything derivable from them is resolved on demand.
 */
export type DeclaredReference = {
  file: string;
  /** Single 1-based line number for precise reference. */
  line?: number;
  /** Optional inclusive end line for range references (1-based). */
  endLine?: number;
  /** Optional 1-based start column, honored only while the declared line still holds. */
  column?: number;
  /** Optional 1-based end column (exclusive). */
  endColumn?: number;
  /** Optional qualified symbol name, e.g. `AuthService.login`. */
  symbol?: string;
  /** Optional literal source text of the referenced line, used to follow it when it moves. */
  anchor?: string;
};

/**
 * Location evidence captured from an editor when a reference is created.
 *
 * @remarks
 * Everything except the file path: the caller owns the position and identity fields, the
 * service owns turning a `Uri` into a persisted workspace-relative path.
 */
export type DeclaredReferenceLocation = Omit<DeclaredReference, 'file'>;

/** Markdown note payload loaded from disk (including fields parsed from frontmatter). */
export interface Note {
  id: string;
  title: string;
  content: string;
  filePath: string;
  tags?: string[];
  links?: string[];
  references?: DeclaredReference[];
  type?: string;
  summary?: string;
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
  /** Whether the note declares links or is the target of one (drives collapsible state). */
  hasRelations?: boolean;
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
 * One declared reference that targets a given file, resolved against its current text.
 *
 * @remarks
 * `startLine`/`endLine` are the 1-based inclusive span the reference currently covers. They are
 * absent - and `issue` is set - when the reference could not be located without guessing.
 */
export type FileContextEntry = {
  note: NoteReference;
  ref: DeclaredReference;
  startLine?: number;
  endLine?: number;
  strategy?: string;
  /** Declared line, present only when the reference had to move to stay correct. */
  movedFromLine?: number;
  /** Why the reference could not be located. */
  issue?: string;
};

// -----------------------------------------------------------------------------
// Shared parsing & operations
// -----------------------------------------------------------------------------

/**
 * Per-operation shared state: avoids repeated filesystem scans within one orchestrated call.
 * Not a global cache - discard after the operation completes.
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
