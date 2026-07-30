import { stripYamlQuotes } from './normalization.helper';

export type FrontmatterDialectParseResult = {
  /** Top-level `key: value` pairs (value is the raw string after `:`). */
  scalars: Record<string, string>;
  /** Top-level list fields normalized to string arrays (only for supported list keys). */
  lists: Record<string, string[]>;
  /** Non-fatal warnings about unsupported structures encountered while parsing. */
  warnings: string[];
};

export type ParseFrontmatterDialectOptions = {
  /**
   * List-typed keys to parse tolerantly.
   * Only these keys will accept bracket lists or YAML block sequences.
   */
  listKeys: readonly string[];
};

const DEFAULT_LIST_KEYS = ['tags', 'links'] as const;

function parseInlineBracketList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return [];
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return inner
    .split(',')
    .map((entry) => stripYamlQuotes(entry).trim())
    .filter((entry) => entry.length > 0);
}

function isTopLevelKeyLine(line: string): boolean {
  return /^[A-Za-z_][\w-]*\s*:/.test(line);
}

/** Matches a YAML block scalar indicator (`>`, `|`) with optional chomping (`-`, `+`). */
const BLOCK_SCALAR_INDICATOR = /^([>|])[-+]?$/;

/**
 * Collects the indented body of a block scalar starting at `startIndex`.
 *
 * @returns The folded value and the index of the last consumed line.
 */
function readBlockScalar(
  lines: readonly string[],
  startIndex: number,
  style: '>' | '|',
): { value: string; lastIndex: number } {
  const bodyLines: string[] = [];
  let index = startIndex;

  for (; index < lines.length; index++) {
    const line = lines[index];

    if (line.trim() === '') {
      bodyLines.push('');
      continue;
    }

    // A non-indented line ends the block (next top-level key or trailing junk).
    if (!/^\s+/.test(line)) {
      break;
    }

    bodyLines.push(line.trim());
  }

  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }

  // Folded blocks read as one line; literal blocks keep their line breaks.
  const value =
    style === '>'
      ? bodyLines.join(' ').replace(/\s+/g, ' ').trim()
      : bodyLines.join('\n');

  return { value, lastIndex: index - 1 };
}

/**
 * Parses a *restricted* frontmatter dialect used by CodeContext+.
 *
 * Goals:
 * - **Strict internally, tolerant externally**: accept safe human variants, normalize into deterministic structures.
 * - **Not a YAML engine**: only supports top-level `key: value`, top-level block scalars
 *   (`key: >` folded to one line, `key: |` keeping line breaks), and top-level lists for known keys
 *   (`key: [a, b]`, `key: a`, or `key:\n  - a\n  - b`).
 * - Detect unsupported nested structures and surface warnings (does not throw).
 */
export function parseFrontmatterDialect(
  rawFrontmatter: string,
  options?: Partial<ParseFrontmatterDialectOptions>,
): FrontmatterDialectParseResult {
  const listKeys = new Set(
    (options?.listKeys ?? DEFAULT_LIST_KEYS).map((k) => k.trim()),
  );

  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const warnings: string[] = [];

  const lines = rawFrontmatter.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) {
      continue;
    }

    // Only parse top-level keys (no indentation).
    if (/^\s+/.test(rawLine)) {
      const nestedKey = rawLine.trim().match(/^([A-Za-z_][\w-]*)\s*:/);
      if (nestedKey) {
        warnings.push(
          `Nested YAML structures are not supported by CodeContext+ frontmatter parser (found "${nestedKey[1]}:" under indentation).`,
        );
      }
      continue;
    }

    const separatorIndex = rawLine.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    const restRaw = rawLine.slice(separatorIndex + 1);
    const rest = restRaw.trim();

    if (!key) {
      continue;
    }

    // Accept: key: >   /   key: |   (block scalar spanning the indented lines below)
    const blockScalar = listKeys.has(key)
      ? null
      : BLOCK_SCALAR_INDICATOR.exec(rest);
    if (blockScalar) {
      const { value, lastIndex } = readBlockScalar(
        lines,
        i + 1,
        blockScalar[1] as '>' | '|',
      );
      scalars[key] = value;
      i = lastIndex;
      continue;
    }

    // Always store scalar form (raw) for downstream consumers that only want strings.
    scalars[key] = rest;

    if (!listKeys.has(key)) {
      continue;
    }

    // Accept: key: [a, b]
    if (rest.startsWith('[')) {
      lists[key] = parseInlineBracketList(rest);
      continue;
    }

    // Accept: key: value  (single)
    if (rest.length > 0) {
      lists[key] = [stripYamlQuotes(rest)];
      continue;
    }

    // Accept: key:   (block sequence)
    const items: string[] = [];
    let sawAnyIndented = false;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine.trim() === '') {
        // blank lines inside block are tolerated
        sawAnyIndented = true;
        continue;
      }

      // Stop at next top-level key.
      if (!/^\s+/.test(nextLine)) {
        if (isTopLevelKeyLine(nextLine)) {
          break;
        }
        // Non-indented junk line; stop block parsing.
        break;
      }

      sawAnyIndented = true;

      const itemMatch = nextLine.match(/^\s*-\s*(.*)$/);
      if (itemMatch) {
        const item = stripYamlQuotes(itemMatch[1] ?? '').trim();
        if (item.length > 0) {
          items.push(item);
        }
        continue;
      }

      // Indented but not a list item => nested structure or unsupported scalar continuation.
      const nestedKey = nextLine.trim().match(/^([A-Za-z_][\w-]*)\s*:/);
      if (nestedKey) {
        warnings.push(
          `Nested YAML structures are not supported by CodeContext+ frontmatter parser (found "${key}:" with nested "${nestedKey[1]}:").`,
        );
      } else {
        warnings.push(
          `Unsupported YAML structure under "${key}:" (only "- item" sequences are supported).`,
        );
      }
      break;
    }

    // `key:` with no values is interpreted as explicit empty list (more tolerant than YAML-null).
    lists[key] = sawAnyIndented ? items : [];
  }

  return { scalars, lists, warnings };
}
