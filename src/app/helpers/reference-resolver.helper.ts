/**
 * Resolves declared frontmatter references to their current location using VS Code APIs.
 *
 * @remarks
 * This module is the only place that talks to language providers. It contributes no index,
 * no database and no persisted metadata: every answer is derived on demand from the live
 * document and from whatever provider the language extension registered.
 *
 * The decision rules live in `reference-match.helper.ts` as pure functions; what follows is
 * the adapter that feeds them real editor state and turns their output into `Range`s.
 */

import {
  commands,
  type DocumentSymbol,
  Position,
  Range,
  type SymbolInformation,
  SymbolKind,
  type TextDocument,
  Uri,
  workspace,
} from 'vscode';

import type { DeclaredReference } from '../models/note.model';
import { toPosixPath } from './path-format.helper';
import {
  anchorFromLine,
  findEnclosingSymbol,
  flattenDocumentSymbols,
  formatSymbolPath,
  type KindedSymbolCandidate,
  parseSymbolPath,
  planReferenceResolution,
  type ReferenceIssue,
  type ReferencePlan,
  type ReferenceStrategy,
  type TextSnapshot,
} from './reference-match.helper';

export type { ReferenceIssue, ReferenceStrategy };

/** Where a reference currently points, and how that was established. */
export type ResolvedReference = {
  status: 'resolved';
  ref: DeclaredReference;
  uri: Uri;
  /** Zero-based range, ready for `revealRange` / `Selection`. */
  range: Range;
  /** 1-based inclusive span, matching how references are written in frontmatter. */
  startLine: number;
  endLine: number;
  strategy: ReferenceStrategy | 'workspace-symbol' | 'path';
  /** Declared line, present only when the reference had to move to stay correct. */
  movedFromLine?: number;
  /** Set when a richer strategy was declared but could not be honored. */
  fallback?: ReferenceIssue;
};

/** A reference that cannot be pointed at code without guessing. */
export type UnresolvedReference = {
  status: 'unresolved';
  ref: DeclaredReference;
  /** Present when the file itself was found but the location inside it was not. */
  uri?: Uri;
  issue: ReferenceIssue;
  candidateCount?: number;
};

export type ReferenceResolution = ResolvedReference | UnresolvedReference;

/** Roots a reference path is resolved against (multi-root aware). */
export type ReferenceResolutionContext = {
  workspaceRoot: Uri;
  notesDir?: Uri | null;
};

// -----------------------------------------------------------------------------
// Path resolution
// -----------------------------------------------------------------------------

/**
 * Resolves a declared reference path to candidate absolute URIs without touching the disk.
 *
 * @remarks
 * Absolute paths are taken literally. Relative paths are resolved against the workspace folder
 * first and against the notes folder second, which keeps notes that use note-relative paths
 * working.
 */
export function resolveReferenceFileCandidates(
  workspaceRoot: Uri,
  notesDir: Uri | null | undefined,
  fileRef: string,
): Uri[] {
  const trimmedRaw = String(fileRef ?? '').trim();
  if (!trimmedRaw) {
    return [];
  }

  const slashPath = trimmedRaw.replace(/\\/g, '/');
  const isAbsolutePosix = slashPath.startsWith('/');
  const isAbsoluteWin = /^[a-zA-Z]:/.test(slashPath);

  if (isAbsolutePosix || isAbsoluteWin) {
    try {
      return [Uri.file(trimmedRaw)];
    } catch {
      return [];
    }
  }

  const segments = slashPath.split('/').filter((s) => s !== '' && s !== '.');
  const candidates: Uri[] = [];

  for (const base of [workspaceRoot, notesDir ?? undefined]) {
    if (!base) {
      continue;
    }

    try {
      let uri = base;
      for (const segment of segments) {
        uri =
          segment === '..'
            ? Uri.joinPath(uri, '..')
            : Uri.joinPath(uri, segment);
      }
      candidates.push(uri);
    } catch {
      // Ignore resolution failures for this base.
    }
  }

  return candidates;
}

async function fileExists(uri: Uri): Promise<boolean> {
  try {
    await workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recovers a moved file by basename, accepting the result only when it is unique.
 *
 * @remarks
 * A file that moved to another folder is unrecoverable from its old path alone, but VS Code can
 * search the workspace for it. A single hit is a fact; several hits are a guess, so they are
 * reported as ambiguous rather than picked from.
 */
async function recoverFileByBasename(
  fileRef: string,
): Promise<{ uri?: Uri; count: number }> {
  const basename = toPosixPath(fileRef).split('/').pop();

  if (!basename || basename.length === 0) {
    return { count: 0 };
  }

  try {
    const matches = await workspace.findFiles(
      `**/${basename}`,
      '**/node_modules/**',
      2,
    );

    return {
      uri: matches.length === 1 ? matches[0] : undefined,
      count: matches.length,
    };
  } catch {
    return { count: 0 };
  }
}

// -----------------------------------------------------------------------------
// Document symbols
// -----------------------------------------------------------------------------

/** Symbol kinds that identify a type or a callable, as opposed to a local binding. */
const STRUCTURAL_SYMBOL_KINDS = new Set<SymbolKind>([
  SymbolKind.Class,
  SymbolKind.Constructor,
  SymbolKind.Enum,
  SymbolKind.Function,
  SymbolKind.Interface,
  SymbolKind.Method,
  SymbolKind.Module,
  SymbolKind.Namespace,
  SymbolKind.Struct,
]);

/** Bounded memo so decorations do not re-query the language server for an unchanged document. */
const symbolMemo = new Map<string, KindedSymbolCandidate[] | undefined>();
const SYMBOL_MEMO_LIMIT = 64;

/**
 * Asks the document symbol provider for `document`, memoized per document version.
 *
 * @returns `undefined` when no provider answered - which is not the same as "no symbols".
 */
async function getDocumentSymbolCandidates(
  document: TextDocument,
): Promise<KindedSymbolCandidate[] | undefined> {
  const key = `${document.uri.toString()}@${document.version}`;

  if (symbolMemo.has(key)) {
    return symbolMemo.get(key);
  }

  let candidates: KindedSymbolCandidate[] | undefined;

  try {
    const raw = await commands.executeCommand<
      (DocumentSymbol | SymbolInformation)[] | undefined
    >('vscode.executeDocumentSymbolProvider', document.uri);

    candidates = raw === undefined ? undefined : flattenDocumentSymbols(raw);
  } catch {
    candidates = undefined;
  }

  if (symbolMemo.size >= SYMBOL_MEMO_LIMIT) {
    symbolMemo.clear();
  }
  symbolMemo.set(key, candidates);

  return candidates;
}

/**
 * Looks for a symbol across the workspace when its file no longer exists.
 *
 * @remarks
 * This is the only mechanism that survives a file being moved or renamed outside VS Code, and
 * it is accepted only on a single workspace-local match with the declared container. The
 * workspace symbol provider answers with fuzzy matches from outside the workspace as well
 * (`lib.dom.d.ts`, dependencies), so filtering is not optional.
 */
async function recoverBySymbolAcrossWorkspace(
  symbol: string,
): Promise<{ uri?: Uri; count: number }> {
  const path = parseSymbolPath(symbol);
  const leaf = path[path.length - 1];
  const container = path.length > 1 ? path[path.length - 2] : undefined;

  if (!leaf) {
    return { count: 0 };
  }

  let raw: SymbolInformation[] | undefined;
  try {
    raw = await commands.executeCommand<SymbolInformation[] | undefined>(
      'vscode.executeWorkspaceSymbolProvider',
      leaf,
    );
  } catch {
    return { count: 0 };
  }

  if (!Array.isArray(raw)) {
    return { count: 0 };
  }

  const matches = raw.filter((entry) => {
    if (entry.name.trim() !== leaf) {
      return false;
    }

    if (container && entry.containerName?.trim() !== container) {
      return false;
    }

    return workspace.getWorkspaceFolder(entry.location.uri) !== undefined;
  });

  const uris = new Map<string, Uri>();
  for (const match of matches) {
    uris.set(match.location.uri.toString(), match.location.uri);
  }

  const unique = [...uris.values()];
  return {
    uri: unique.length === 1 ? unique[0] : undefined,
    count: unique.length,
  };
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** Adapts a `TextDocument` to the pure matching interface. */
function snapshotFromDocument(document: TextDocument): TextSnapshot {
  return {
    lineCount: document.lineCount,
    lineAt: (zeroBasedLine: number) =>
      zeroBasedLine >= 0 && zeroBasedLine < document.lineCount
        ? document.lineAt(zeroBasedLine).text
        : '',
  };
}

function planToRange(plan: ReferencePlan, document: TextDocument): Range {
  if (plan.status !== 'located') {
    return new Range(0, 0, 0, 0);
  }

  const startLine = Math.min(plan.startLine, document.lineCount) - 1;
  const endLine = Math.min(plan.endLine, document.lineCount) - 1;

  const startCharacter =
    plan.column !== undefined ? Math.max(0, plan.column - 1) : 0;
  const endCharacter =
    plan.endColumn !== undefined
      ? Math.max(0, plan.endColumn - 1)
      : document.lineAt(endLine).text.length;

  return new Range(
    new Position(startLine, startCharacter),
    new Position(endLine, endCharacter),
  );
}

/**
 * Resolves one declared reference to a current location.
 *
 * @remarks
 * Nothing is written back: a reference that drifted is reported as drifted and keeps working.
 * The frontmatter is only ever changed by an explicit user action.
 */
export async function resolveDeclaredReference(
  ref: DeclaredReference,
  context: ReferenceResolutionContext,
): Promise<ReferenceResolution> {
  const candidates = resolveReferenceFileCandidates(
    context.workspaceRoot,
    context.notesDir,
    ref.file,
  );

  let uri: Uri | undefined;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      uri = candidate;
      break;
    }
  }

  let recoveredPath = false;

  if (!uri) {
    // The declared path is gone. Try the symbol first (it identifies code, not a location),
    // then the filename.
    if (ref.symbol) {
      const bySymbol = await recoverBySymbolAcrossWorkspace(ref.symbol);
      if (bySymbol.uri) {
        uri = bySymbol.uri;
        recoveredPath = true;
      } else if (bySymbol.count > 1) {
        return {
          status: 'unresolved',
          ref,
          issue: 'path-ambiguous',
          candidateCount: bySymbol.count,
        };
      }
    }

    if (!uri) {
      const byName = await recoverFileByBasename(ref.file);
      if (byName.uri) {
        uri = byName.uri;
        recoveredPath = true;
      } else {
        return {
          status: 'unresolved',
          ref,
          issue: byName.count > 1 ? 'path-ambiguous' : 'file-not-found',
          ...(byName.count > 1 ? { candidateCount: byName.count } : {}),
        };
      }
    }
  }

  let document: TextDocument;
  try {
    document = await workspace.openTextDocument(uri);
  } catch {
    return { status: 'unresolved', ref, uri, issue: 'file-not-found' };
  }

  const resolution = await resolveDeclaredReferenceInDocument(ref, document);

  if (resolution.status === 'unresolved' || !recoveredPath) {
    return resolution;
  }

  // The file itself had to be recovered, which outranks how the spot inside it was found.
  return {
    ...resolution,
    strategy: resolution.strategy === 'symbol' ? 'workspace-symbol' : 'path',
  };
}

/**
 * Resolves a reference against a document that is already known to be the target file.
 *
 * @remarks
 * Callers that project context onto an open editor know the file up front, so the path
 * resolution and existence checks of {@link resolveDeclaredReference} are pure overhead there:
 * one open document serves every reference pointing at it.
 *
 * @param ref Declared reference.
 * @param document Target document.
 */
export async function resolveDeclaredReferenceInDocument(
  ref: DeclaredReference,
  document: TextDocument,
): Promise<ReferenceResolution> {
  const symbols = ref.symbol ? await getDocumentSymbolCandidates(document) : [];

  const plan = planReferenceResolution(
    ref,
    snapshotFromDocument(document),
    symbols,
  );

  if (plan.status === 'unresolved') {
    return {
      status: 'unresolved',
      ref,
      uri: document.uri,
      issue: plan.issue,
      ...(plan.candidateCount !== undefined
        ? { candidateCount: plan.candidateCount }
        : {}),
    };
  }

  return {
    status: 'resolved',
    ref,
    uri: document.uri,
    range: planToRange(plan, document),
    strategy: plan.strategy,
    startLine: plan.startLine,
    endLine: plan.endLine,
    ...(plan.movedFromLine !== undefined
      ? { movedFromLine: plan.movedFromLine }
      : {}),
    ...(plan.fallback !== undefined ? { fallback: plan.fallback } : {}),
  };
}

// -----------------------------------------------------------------------------
// Capture
// -----------------------------------------------------------------------------

/** Location fields captured from the editor when a reference is created. */
export type CapturedReferenceLocation = {
  line: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
  symbol?: string;
  anchor?: string;
};

/**
 * Captures everything needed to find this code again from the current editor state.
 *
 * @remarks
 * The position alone is not identity, so the anchor (the line's own text) and the enclosing
 * symbol are recorded alongside it. Neither can be reconstructed later - they describe the code
 * as it was when the note was written - which is why they are persisted while everything else
 * (ranges, columns, current line numbers) is derived on demand.
 */
export async function captureReferenceLocation(
  document: TextDocument,
  selection: Range,
): Promise<CapturedReferenceLocation> {
  const startLine = selection.start.line;
  const endLine = selection.end.line;

  // A selection that ends at column 0 of the next line covers whole lines only.
  const effectiveEndLine =
    endLine > startLine && selection.end.character === 0
      ? endLine - 1
      : endLine;

  const captured: CapturedReferenceLocation = { line: startLine + 1 };

  if (effectiveEndLine > startLine) {
    captured.endLine = effectiveEndLine + 1;
  } else if (!selection.isEmpty) {
    // A partial single-line selection is explicit intent: keep the columns.
    captured.column = selection.start.character + 1;
    captured.endColumn = selection.end.character + 1;
  }

  const anchor = anchorFromLine(document.lineAt(startLine).text);
  if (anchor) {
    captured.anchor = anchor;
  }

  const symbols = await getDocumentSymbolCandidates(document);
  if (symbols && symbols.length > 0) {
    const enclosing = findEnclosingSymbol(symbols, startLine + 1, (candidate) =>
      STRUCTURAL_SYMBOL_KINDS.has((candidate as KindedSymbolCandidate).kind),
    );

    if (enclosing) {
      captured.symbol = formatSymbolPath(enclosing.path);
    }
  }

  return captured;
}
