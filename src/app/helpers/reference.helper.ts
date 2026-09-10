import type { DeclaredReference } from '../models/note.model';
import { parseFrontmatterDialect } from './frontmatter-dialect.helper';
import {
  normalizeDeclaredReference,
  stripYamlQuotes,
  unquoteYamlScalar,
} from './normalization.helper';

/**
 * Compact reference grammar: `path[#start[(:|-)end]][@symbol]`.
 *
 * @remarks
 * `#L12` and `#12` are equivalent, and a range accepts either separator (`#2-5`, `#2:5`),
 * because both spellings are already in circulation. Anchors have no compact spelling - they
 * hold literal source text - so a compact entry carries position and symbol only.
 *
 * The symbol may not contain `/`, which is what keeps a scoped path such as
 * `src/@scope/pkg/index.ts` from being read as a path plus a symbol.
 */
const COMPACT_REFERENCE = /^(.*?)(?:#L?(\d+)(?:[:-]L?(\d+))?)?(?:@([^\s/]+))?$/;

/**
 * Parses a compact reference item such as `path/to/file#12` into a {@link DeclaredReference}.
 */
function parseCompactReference(item: string): DeclaredReference {
  const trimmed = String(item ?? '').trim();

  const match = trimmed.match(COMPACT_REFERENCE);
  if (!match) {
    return { file: stripYamlQuotes(trimmed) };
  }

  const rawPath = stripYamlQuotes((match[1] ?? '').trim());
  const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
  const endLine = match[3] ? Number.parseInt(match[3], 10) : undefined;
  const symbol = match[4] ? stripYamlQuotes(match[4].trim()) : undefined;

  const out: DeclaredReference = { file: rawPath };

  if (typeof line === 'number' && Number.isFinite(line)) {
    out.line = line;
  }
  if (typeof endLine === 'number' && Number.isFinite(endLine)) {
    out.endLine = endLine;
  }
  if (symbol) {
    out.symbol = symbol;
  }

  return out;
}

/** Structured detail keys that qualify the `- file:` row above them. */
const NUMERIC_DETAIL_KEYS = ['line', 'endLine', 'column', 'endColumn'] as const;
const TEXT_DETAIL_KEYS = ['symbol', 'anchor'] as const;

type NumericDetailKey = (typeof NUMERIC_DETAIL_KEYS)[number];
type TextDetailKey = (typeof TEXT_DETAIL_KEYS)[number];

/**
 * Applies one indented `key: value` detail line to the reference being built.
 *
 * @returns `true` when the line was a recognized detail.
 */
function applyStructuredDetail(
  target: DeclaredReference,
  line: string,
): boolean {
  const match = line.match(/^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
  if (!match) {
    return false;
  }

  const key = match[1];
  const rawValue = match[2];

  if ((NUMERIC_DETAIL_KEYS as readonly string[]).includes(key)) {
    const parsed = Number.parseInt(stripYamlQuotes(rawValue).trim(), 10);

    if (Number.isInteger(parsed) && parsed > 0) {
      target[key as NumericDetailKey] = parsed;
    }

    return true;
  }

  if ((TEXT_DETAIL_KEYS as readonly string[]).includes(key)) {
    const value = unquoteYamlScalar(rawValue);

    if (value.length > 0) {
      target[key as TextDetailKey] = value;
    }

    return true;
  }

  return false;
}

/**
 * Tolerantly parses `references:` from the restricted frontmatter dialect used by the extension.
 *
 * @remarks
 * Both authoring forms are read into the same model and neither is preferred:
 *
 * - compact list items (`- src/auth/auth.service.ts#42`, inline bracket lists);
 * - structured mappings (`- file: <path>` followed by indented `line`, `endLine`, `column`,
 *   `endColumn`, `symbol` and `anchor` details).
 *
 * Unknown detail keys are ignored rather than rejected, so a note carrying fields this version
 * does not understand still yields its references.
 */
export function parseDeclaredReferencesFromFrontmatter(
  frontmatter: string,
): DeclaredReference[] {
  const parsed = parseFrontmatterDialect(frontmatter, {
    listKeys: ['references'],
  });

  // If dialect parser yielded a straightforward string list, treat each entry
  // as a compact reference item (may contain `#<line>` suffix). However, the
  // restricted dialect will sometimes surface structured mapping rows as
  // string list items (e.g. `- file: path`) - detect that pattern and fall
  // through to the targeted structured-mapping parser below instead of
  // misinterpreting `file: ...` as a literal path.
  if (Object.prototype.hasOwnProperty.call(parsed.lists, 'references')) {
    const items = parsed.lists.references;
    const looksLikeMapping = items.some((it) => {
      const s = String(it ?? '').trim();
      return /^[A-Za-z_][\w-]*\s*:/.test(s);
    });
    if (!looksLikeMapping) {
      return items
        .map((it) => parseCompactReference(it))
        .map(normalizeDeclaredReference)
        .filter((r): r is DeclaredReference => r !== null);
    }
    // fall through to the structured-line parser below
  }

  // Fall back to tolerant structured parsing when items are mappings.
  const lines = String(frontmatter ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('references:')) {
      const inline = trimmed.slice('references:'.length).trim();
      if (inline === '[]') {
        return [];
      }
      sectionStart = i + 1;
      break;
    }
  }

  if (sectionStart === -1) {
    return [];
  }

  const refs: DeclaredReference[] = [];

  for (let i = sectionStart; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (!/^\s/.test(line)) {
      const nextKey = line.match(/^([a-zA-Z_][\w-]*)\s*:/);
      if (nextKey && nextKey[1] !== 'references') {
        break;
      }
    }

    const fileMatch = line.match(/^\s*-\s*file:\s*(.+)$/);
    if (fileMatch) {
      const filePath = stripYamlQuotes(fileMatch[1].trim());
      if (filePath.trim().length > 0) {
        refs.push({ file: filePath.trim() });
      }
      continue;
    }

    const compactMatch = line.match(/^\s*-\s*(.+)$/);
    if (compactMatch) {
      refs.push(parseCompactReference(compactMatch[1].trim()));
      continue;
    }

    if (refs.length > 0) {
      applyStructuredDetail(refs[refs.length - 1], line);
    }
  }

  return refs
    .map(normalizeDeclaredReference)
    .filter((r): r is DeclaredReference => r !== null);
}

/**
 * Normalizes and validates a declared reference row. Returns `null` for invalid rows.
 */
export { normalizeDeclaredReference };
