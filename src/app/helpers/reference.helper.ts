import type { DeclaredReference } from '../models/note.model';
import { parseFrontmatterDialect } from './frontmatter-dialect.helper';
import {
  normalizeDeclaredReference,
  stripYamlQuotes,
} from './normalization.helper';

/**
 * Parses a compact reference item like `path/to/file#12` into a DeclaredReference.
 */
function parseCompactReference(item: string): DeclaredReference {
  const trimmed = String(item ?? '').trim();

  // Match `path#start:end@symbol`, `path#start:end`, `path#line@symbol`,
  // `path#line`, `path@symbol`, or just `path`.
  const m = trimmed.match(/^(.*?)(?:#(\d+)(?::(\d+))?)?(?:@(\S+))?$/);
  if (!m) {
    return { file: stripYamlQuotes(trimmed) };
  }

  const rawPath = stripYamlQuotes((m[1] ?? '').trim());
  const line = m[2] ? Number.parseInt(m[2], 10) : undefined;
  const endLine = m[3] ? Number.parseInt(m[3], 10) : undefined;
  const symbol = m[4] ? stripYamlQuotes(m[4].trim()) : undefined;

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

/**
 * Tolerantly parses `references:` from the restricted frontmatter dialect used by the extension.
 *
 * Supports both compact list forms (inline lists or `- item` strings containing `path#line`) and
 * the structured mapping form (`- file: <path>\n  line: <n>`). Always returns normalized rows
 * with trimmed file paths and integer 1-based lines when present.
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
  // string list items (e.g. `- file: path`) — detect that pattern and fall
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
      const rawPath = fileMatch[1].trim();
      const filePath = stripYamlQuotes(rawPath);
      if (typeof filePath === 'string' && filePath.trim().length > 0) {
        refs.push({ file: filePath.trim() });
      }
      continue;
    }

    const compactMatch = line.match(/^\s*-\s*(.+)$/);
    if (compactMatch) {
      const item = compactMatch[1].trim();
      refs.push(parseCompactReference(item));
      continue;
    }

    const lineMatch = line.match(/^\s+line:\s*(.+)$/);
    if (lineMatch && refs.length > 0) {
      const n = Number.parseInt(lineMatch[1].trim(), 10);
      const last = refs[refs.length - 1];
      const parsedLine =
        typeof n === 'number' &&
        Number.isFinite(n) &&
        Number.isInteger(n) &&
        n > 0
          ? n
          : undefined;
      if (parsedLine !== undefined) {
        last.line = parsedLine;
      }
      continue;
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
