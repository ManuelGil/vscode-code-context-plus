/**
 * Pure matching primitives used to locate a declared reference inside current source text.
 *
 * @remarks
 * This module deliberately avoids importing `vscode` at runtime so that every rule
 * (anchor drift, symbol disambiguation, ambiguity detection) is verifiable without an
 * editor host. The VS Code-facing side lives in `reference-resolver.helper.ts`.
 *
 * Two invariants hold across this file:
 * - Line numbers are **1-based inclusive**, matching the frontmatter dialect.
 * - Nothing here guesses. When several equally plausible candidates exist the caller
 *   receives all of them and is expected to report ambiguity instead of picking one.
 */

import type { DocumentSymbol, SymbolInformation } from 'vscode';

/** Maximum anchor length persisted in frontmatter; longer lines are truncated on capture. */
const MAX_ANCHOR_LENGTH = 160;

/** Read-only view over a document's lines (satisfied by `TextDocument` adapters and by plain strings). */
export type TextSnapshot = {
  readonly lineCount: number;
  /** Returns the text of a 0-based line, without the line break. */
  lineAt(zeroBasedLine: number): string;
};

/**
 * Builds a {@link TextSnapshot} from raw text.
 *
 * @param text Full document text (CRLF tolerated).
 */
export function snapshotFromText(text: string): TextSnapshot {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  return {
    lineCount: lines.length,
    lineAt: (zeroBasedLine: number) => lines[zeroBasedLine] ?? '',
  };
}

/**
 * Normalizes anchor text for comparison.
 *
 * @remarks
 * Indentation and internal whitespace runs are not identity: reformatting, re-indenting
 * or wrapping a line must not invalidate an anchor. Everything else is compared literally.
 */
function normalizeAnchorText(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derives the anchor to persist for a given source line.
 *
 * @returns `undefined` for blank lines, which carry no recoverable identity.
 */
export function anchorFromLine(lineText: string): string | undefined {
  const trimmed = String(lineText ?? '').trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.length > MAX_ANCHOR_LENGTH
    ? trimmed.slice(0, MAX_ANCHOR_LENGTH)
    : trimmed;
}

/**
 * Locates the 1-based lines that still carry the anchor text.
 *
 * @remarks
 * Matching runs in two tiers and never mixes them:
 * 1. the normalized line equals the normalized anchor (the line survived intact);
 * 2. the normalized line contains the normalized anchor (the line grew around it).
 *
 * Tier 2 is consulted only when tier 1 finds nothing, so a line that still exists verbatim
 * is never outranked by an unrelated line that merely contains the same substring.
 *
 * @param snapshot Current document text.
 * @param anchor Persisted anchor text.
 * @param bounds Optional 1-based inclusive line window to restrict the search to.
 */
function findAnchorLines(
  snapshot: TextSnapshot,
  anchor: string,
  bounds?: { fromLine?: number; toLine?: number },
): number[] {
  const needle = normalizeAnchorText(anchor);

  if (needle.length === 0) {
    return [];
  }

  const first = Math.max(1, bounds?.fromLine ?? 1);
  const last = Math.min(
    snapshot.lineCount,
    bounds?.toLine ?? snapshot.lineCount,
  );

  const exact: number[] = [];
  const partial: number[] = [];

  for (let line = first; line <= last; line++) {
    const candidate = normalizeAnchorText(snapshot.lineAt(line - 1));

    if (candidate.length === 0) {
      continue;
    }

    if (candidate === needle) {
      exact.push(line);
      continue;
    }

    if (candidate.includes(needle)) {
      partial.push(line);
    }
  }

  return exact.length > 0 ? exact : partial;
}

// -----------------------------------------------------------------------------
// Symbol matching
// -----------------------------------------------------------------------------

/** Flattened document symbol, independent of `DocumentSymbol` vs `SymbolInformation` shape. */
export type SymbolCandidate = {
  /** Qualified name path, outermost container first (e.g. `['AuthService', 'login']`). */
  path: string[];
  /** 1-based inclusive line range covered by the symbol. */
  startLine: number;
  endLine: number;
  /** 1-based position of the symbol name itself (used as the navigation target). */
  selectionLine: number;
  selectionColumn: number;
};

/** Separators accepted in a declared `symbol:` value (`.`, `::`, `#`). */
const SYMBOL_SEPARATORS = /::|[.#]/;

/**
 * Splits a declared symbol into its qualified segments.
 *
 * @remarks
 * `AuthService.login`, `AuthService::login` and `AuthService#login` denote the same symbol,
 * so all three spellings are accepted; the persisted form is `.`-separated.
 */
export function parseSymbolPath(symbol: string): string[] {
  return String(symbol ?? '')
    .split(SYMBOL_SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Serializes a qualified path back into the persisted `.`-separated form. */
export function formatSymbolPath(path: readonly string[]): string {
  return path.join('.');
}

/**
 * Returns `true` for symbol names that carry no stable identity.
 *
 * @remarks
 * Language servers surface placeholders for unnamed constructs - the TypeScript server, for
 * example, emits `<function>` entries when a file fails to parse. Those must never become a
 * reference target.
 */
function isAddressableSymbolName(name: string): boolean {
  const trimmed = String(name ?? '').trim();

  if (trimmed.length === 0) {
    return false;
  }

  return !(trimmed.startsWith('<') && trimmed.endsWith('>'));
}

/**
 * Selects the candidates that a declared symbol denotes.
 *
 * @remarks
 * Resolution is exact first, then suffix-based:
 * - a candidate whose full qualified path equals the declared one always wins, so a top-level
 *   `login` is never confused with `AuthService.login`;
 * - otherwise the declared path is matched against the tail of each candidate path on segment
 *   boundaries, so a reference written before the class was moved into a namespace still resolves.
 *
 * Several matches are returned as such: callers disambiguate with other evidence or report
 * ambiguity. Overloaded members legitimately produce several candidates.
 */
export function matchSymbolCandidates(
  candidates: readonly SymbolCandidate[],
  symbol: string,
): SymbolCandidate[] {
  const declared = parseSymbolPath(symbol);

  if (declared.length === 0) {
    return [];
  }

  const exact = candidates.filter(
    (candidate) =>
      candidate.path.length === declared.length &&
      candidate.path.every((segment, index) => segment === declared[index]),
  );

  if (exact.length > 0) {
    return exact;
  }

  return candidates.filter((candidate) => {
    if (candidate.path.length <= declared.length) {
      return false;
    }

    const tail = candidate.path.slice(candidate.path.length - declared.length);
    return tail.every((segment, index) => segment === declared[index]);
  });
}

/** Flattened symbol enriched with its `SymbolKind` numeric value. */
export type KindedSymbolCandidate = SymbolCandidate & { kind: number };

function isDocumentSymbol(
  value: DocumentSymbol | SymbolInformation,
): value is DocumentSymbol {
  return (
    (value as DocumentSymbol).selectionRange !== undefined &&
    (value as SymbolInformation).location === undefined
  );
}

/**
 * Flattens whatever `executeDocumentSymbolProvider` returned into qualified candidates.
 *
 * @remarks
 * The command may answer with a `DocumentSymbol` tree or with flat `SymbolInformation`, and
 * both shapes occur in the wild depending on the language extension. Unnamed entries are
 * dropped: they cannot be addressed by name and, when a file stops parsing, they are exactly
 * the entries a server invents.
 */
export function flattenDocumentSymbols(
  raw: readonly (DocumentSymbol | SymbolInformation)[] | undefined,
): KindedSymbolCandidate[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: KindedSymbolCandidate[] = [];

  const pushDocumentSymbol = (symbol: DocumentSymbol, parents: string[]) => {
    const addressable = isAddressableSymbolName(symbol.name);
    const path = addressable ? [...parents, symbol.name.trim()] : parents;

    if (addressable) {
      out.push({
        path,
        kind: symbol.kind,
        startLine: symbol.range.start.line + 1,
        endLine: symbol.range.end.line + 1,
        selectionLine: symbol.selectionRange.start.line + 1,
        selectionColumn: symbol.selectionRange.start.character + 1,
      });
    }

    for (const child of symbol.children ?? []) {
      pushDocumentSymbol(child, path);
    }
  };

  for (const entry of raw) {
    if (isDocumentSymbol(entry)) {
      pushDocumentSymbol(entry, []);
      continue;
    }

    if (!isAddressableSymbolName(entry.name)) {
      continue;
    }

    const container = entry.containerName?.trim();
    const path =
      container && isAddressableSymbolName(container)
        ? [container, entry.name.trim()]
        : [entry.name.trim()];

    out.push({
      path,
      kind: entry.kind,
      startLine: entry.location.range.start.line + 1,
      endLine: entry.location.range.end.line + 1,
      selectionLine: entry.location.range.start.line + 1,
      selectionColumn: entry.location.range.start.character + 1,
    });
  }

  return out;
}

/**
 * Returns the innermost candidate containing a 1-based line, preferring structural symbols.
 *
 * @remarks
 * Used at capture time to answer "which symbol is the cursor in?". Structural kinds (types and
 * callables) are preferred over locals, because a local binding is far more volatile than the
 * function that contains it.
 *
 * @param candidates Flattened symbols of the document.
 * @param line 1-based line of interest.
 * @param isStructural Predicate marking a candidate as a type or callable.
 */
export function findEnclosingSymbol(
  candidates: readonly SymbolCandidate[],
  line: number,
  isStructural: (candidate: SymbolCandidate) => boolean,
): SymbolCandidate | undefined {
  const containing = candidates.filter(
    (candidate) => candidate.startLine <= line && line <= candidate.endLine,
  );

  if (containing.length === 0) {
    return undefined;
  }

  const innermost = (list: readonly SymbolCandidate[]): SymbolCandidate =>
    list.reduce((best, candidate) =>
      candidate.path.length > best.path.length ? candidate : best,
    );

  const structural = containing.filter(isStructural);

  return innermost(structural.length > 0 ? structural : containing);
}

// -----------------------------------------------------------------------------
// Resolution planning
// -----------------------------------------------------------------------------

/** How a reference was located in the current text. */
export type ReferenceStrategy = 'file' | 'position' | 'anchor' | 'symbol';

/** Why a reference could not be located, or what had to be given up on. */
export type ReferenceIssue =
  | 'file-not-found'
  | 'path-ambiguous'
  | 'line-out-of-range'
  | 'anchor-not-found'
  | 'anchor-ambiguous'
  | 'symbol-not-found'
  | 'symbol-ambiguous'
  | 'symbol-provider-unavailable';

/** Outcome of planning one reference against current document text. */
export type ReferencePlan =
  | {
      status: 'located';
      strategy: ReferenceStrategy;
      /** 1-based inclusive lines in the current text. */
      startLine: number;
      endLine: number;
      /** 1-based columns, carried over only when the declared position still holds. */
      column?: number;
      endColumn?: number;
      /** Declared line, when the reference had to move to stay correct. */
      movedFromLine?: number;
      /** Set when a richer strategy was declared but could not be honored. */
      fallback?: ReferenceIssue;
    }
  | {
      status: 'unresolved';
      issue: ReferenceIssue;
      /** Number of equally plausible candidates, for ambiguity reporting. */
      candidateCount?: number;
    };

/** Subset of a declared reference that participates in in-file resolution. */
export type ReferenceLocationInput = {
  line?: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
  symbol?: string;
  anchor?: string;
};

/** Declared span height, so a moved reference keeps covering the same amount of code. */
function declaredSpan(ref: ReferenceLocationInput): number {
  if (ref.line === undefined || ref.endLine === undefined) {
    return 0;
  }

  return Math.max(0, ref.endLine - ref.line);
}

function clampLine(line: number, snapshot: TextSnapshot): number {
  return Math.min(Math.max(1, line), Math.max(1, snapshot.lineCount));
}

/**
 * Resolves a declared reference against current document text.
 *
 * @remarks
 * Evidence is consulted from most to least specific - symbol, then anchor, then the raw
 * position - and each step falls through rather than failing when its evidence is missing,
 * because a language server that returns nothing is not proof that the code is gone.
 *
 * Ambiguity is never resolved by proximity or by picking the first candidate: when two
 * locations are equally plausible the plan is `unresolved`, so navigation reports the
 * conflict instead of opening the wrong code.
 *
 * @param ref Declared reference fields.
 * @param snapshot Current text of the referenced file.
 * @param symbols Flattened document symbols, or `undefined` when no provider answered.
 */
export function planReferenceResolution(
  ref: ReferenceLocationInput,
  snapshot: TextSnapshot,
  symbols?: readonly SymbolCandidate[],
): ReferencePlan {
  const span = declaredSpan(ref);

  const located = (
    strategy: ReferenceStrategy,
    startLine: number,
    endLine: number,
    extras?: Partial<ReferencePlan & { status: 'located' }>,
  ): ReferencePlan => ({
    status: 'located',
    strategy,
    startLine: clampLine(startLine, snapshot),
    endLine: clampLine(Math.max(startLine, endLine), snapshot),
    ...extras,
  });

  // ---------------------------------------------------------------------------
  // 1. Symbol evidence (language-provider dependent).
  // ---------------------------------------------------------------------------
  if (ref.symbol) {
    if (!symbols) {
      // No provider answered for this language: degrade instead of failing.
      if (ref.line === undefined && !ref.anchor) {
        return located('file', 1, 1, {
          fallback: 'symbol-provider-unavailable',
        });
      }
    } else {
      const matches = matchSymbolCandidates(symbols, ref.symbol);

      if (matches.length === 1) {
        return locateWithinSymbol(matches[0], ref, snapshot, span);
      }

      if (matches.length > 1) {
        // Overloads and same-named members: disambiguate only with hard evidence.
        if (ref.anchor) {
          const byAnchor = matches.filter(
            (candidate) =>
              findAnchorLines(snapshot, ref.anchor as string, {
                fromLine: candidate.startLine,
                toLine: candidate.endLine,
              }).length === 1,
          );

          if (byAnchor.length === 1) {
            return locateWithinSymbol(byAnchor[0], ref, snapshot, span);
          }
        }

        if (ref.line !== undefined) {
          const declaredLine = ref.line;
          const byLine = matches.filter(
            (candidate) =>
              candidate.startLine <= declaredLine &&
              declaredLine <= candidate.endLine,
          );

          if (byLine.length === 1) {
            return locateWithinSymbol(byLine[0], ref, snapshot, span);
          }
        }

        return {
          status: 'unresolved',
          issue: 'symbol-ambiguous',
          candidateCount: matches.length,
        };
      }

      // The symbol is gone (renamed, deleted, or the file no longer parses).
      if (ref.line === undefined && !ref.anchor) {
        return { status: 'unresolved', issue: 'symbol-not-found' };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Anchor evidence (language agnostic).
  // ---------------------------------------------------------------------------
  if (ref.anchor) {
    const hits = findAnchorLines(snapshot, ref.anchor);

    if (hits.length === 0) {
      return { status: 'unresolved', issue: 'anchor-not-found' };
    }

    if (ref.line !== undefined && hits.includes(ref.line)) {
      return located('position', ref.line, ref.line + span, {
        column: ref.column,
        endColumn: ref.endColumn,
      });
    }

    if (hits.length === 1) {
      return located('anchor', hits[0], hits[0] + span, {
        movedFromLine: ref.line,
      });
    }

    return {
      status: 'unresolved',
      issue: 'anchor-ambiguous',
      candidateCount: hits.length,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Raw position.
  // ---------------------------------------------------------------------------
  if (ref.line !== undefined) {
    if (ref.line > snapshot.lineCount) {
      return { status: 'unresolved', issue: 'line-out-of-range' };
    }

    return located('position', ref.line, ref.line + span, {
      column: ref.column,
      endColumn: ref.endColumn,
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Whole file.
  // ---------------------------------------------------------------------------
  return located('file', 1, 1);
}

/**
 * Turns a matched symbol into a concrete span.
 *
 * @remarks
 * When the anchor pinpoints a single line strictly inside the symbol, the reference is about
 * that line and follows it. Otherwise the reference is about the symbol itself and adopts the
 * symbol's own range, which is how a reference to a function that grew keeps covering all of it.
 */
function locateWithinSymbol(
  candidate: SymbolCandidate,
  ref: ReferenceLocationInput,
  snapshot: TextSnapshot,
  span: number,
): ReferencePlan {
  if (ref.anchor) {
    const inside = findAnchorLines(snapshot, ref.anchor, {
      fromLine: candidate.startLine,
      toLine: candidate.endLine,
    });

    if (
      inside.length === 1 &&
      inside[0] !== candidate.startLine &&
      inside[0] !== candidate.selectionLine
    ) {
      return {
        status: 'located',
        strategy: 'symbol',
        startLine: inside[0],
        endLine: Math.min(Math.max(1, snapshot.lineCount), inside[0] + span),
        ...(ref.line !== undefined && ref.line !== inside[0]
          ? { movedFromLine: ref.line }
          : {}),
      };
    }
  }

  return {
    status: 'located',
    strategy: 'symbol',
    startLine: candidate.selectionLine,
    endLine: Math.max(candidate.selectionLine, candidate.endLine),
    column: candidate.selectionColumn,
    ...(ref.line !== undefined && ref.line !== candidate.selectionLine
      ? { movedFromLine: ref.line }
      : {}),
  };
}
