import type { DeclaredReference } from '../models/note.model';
import { toPosixPath } from './path-format.helper';

/**
 * Removes surrounding YAML quotes from a scalar value.
 *
 * @remarks
 * Frontmatter values may contain quoted strings depending on
 * authoring style or serializer behavior.
 *
 * Examples:
 * - `"src/auth.ts"` → `src/auth.ts`
 * - `'auth-bug'` → `auth-bug`
 *
 * @param value Raw YAML scalar value.
 */
export function stripYamlQuotes(value: string): string {
  const normalizedValue = String(value ?? '').trim();

  const isDoubleQuoted =
    normalizedValue.startsWith('"') && normalizedValue.endsWith('"');

  const isSingleQuoted =
    normalizedValue.startsWith("'") && normalizedValue.endsWith("'");

  if (isDoubleQuoted || isSingleQuoted) {
    return normalizedValue.slice(1, -1).trim();
  }

  return normalizedValue;
}

/**
 * Normalizes a reference file path into a deterministic
 * workspace-relative POSIX path.
 *
 * @remarks
 * The runtime intentionally operates using:
 * - relative paths
 * - POSIX separators
 * - deterministic reference matching
 *
 * Supported examples:
 * - `src/auth/service.ts`
 * - `./src/auth/service.ts`
 * - `src/auth/service.ts#12`
 *
 * The optional `#<line>` fragment is removed during path normalization.
 *
 * @param rawPath Raw reference path from frontmatter.
 */
export function normalizeReferencePath(rawPath: string): string {
  const normalizedInput = stripYamlQuotes(String(rawPath ?? '')).trim();

  if (normalizedInput === '') {
    return '';
  }

  const pathWithoutLineFragment = normalizedInput.replace(/#\d+$/, '');

  const workspaceRelativePath = pathWithoutLineFragment.replace(/^\.\//, '');

  const posixPath = toPosixPath(workspaceRelativePath);

  return posixPath.replace(/\/+/g, '/');
}

/**
 * Normalizes a declared reference line number.
 *
 * @remarks
 * Only positive integer line numbers are considered valid runtime references.
 *
 * Invalid values return `undefined`.
 *
 * @param value Runtime line value.
 */
export function normalizeReferenceLine(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsedValue = Number.parseInt(value.trim(), 10);

    if (Number.isInteger(parsedValue) && parsedValue > 0) {
      return parsedValue;
    }
  }

  return undefined;
}

/**
 * Normalizes a single declared reference into a deterministic runtime structure.
 *
 * @remarks
 * The runtime supports hybrid reference ingestion:
 *
 * Compact syntax:
 * ```yaml
 * references:
 *   - src/auth/auth.service.ts#12
 * ```
 *
 * Structured syntax:
 * ```yaml
 * references:
 *   - file: src/auth/auth.service.ts
 *     line: 12
 * ```
 *
 * Both forms normalize into the same runtime representation.
 *
 * Invalid references return `null`.
 *
 * @param reference Declared frontmatter reference.
 */
export function normalizeDeclaredReference(
  reference: DeclaredReference | null | undefined,
): DeclaredReference | null {
  if (!reference || typeof reference.file !== 'string') {
    return null;
  }

  const normalizedFile = normalizeReferencePath(reference.file);

  if (!normalizedFile) {
    return null;
  }

  const normalizedLine = normalizeReferenceLine(reference.line);
  const normalizedEndLine = normalizeReferenceLine((reference as any).endLine);
  const symbolRaw = (reference as any).symbol;
  const normalizedSymbol =
    typeof symbolRaw === 'string' && symbolRaw.trim().length > 0
      ? stripYamlQuotes(symbolRaw).trim()
      : undefined;

  // If neither line nor symbol is present, return file-level reference.
  if (normalizedLine === undefined && normalizedSymbol === undefined) {
    return { file: normalizedFile };
  }

  // Coerce range if endLine is set and ensure inclusive ordering.
  if (normalizedEndLine !== undefined && normalizedLine !== undefined) {
    const start = Math.min(normalizedLine, normalizedEndLine);
    const end = Math.max(normalizedLine, normalizedEndLine);
    return {
      file: normalizedFile,
      line: start,
      endLine: end,
      ...(normalizedSymbol ? { symbol: normalizedSymbol } : {}),
    };
  }

  // Single line with possible symbol.
  if (normalizedLine !== undefined) {
    return {
      file: normalizedFile,
      line: normalizedLine,
      ...(normalizedSymbol ? { symbol: normalizedSymbol } : {}),
    };
  }

  // Symbol-only reference.
  return { file: normalizedFile, symbol: normalizedSymbol };
}

/**
 * Normalizes a list of declared references.
 *
 * @remarks
 * Invalid references are ignored safely.
 *
 * @param references Raw declared references.
 */
export function normalizeDeclaredReferences(
  references: readonly (DeclaredReference | null | undefined)[] | undefined,
): DeclaredReference[] {
  if (!Array.isArray(references)) {
    return [];
  }

  const normalizedReferences: DeclaredReference[] = [];

  for (const reference of references) {
    const normalizedReference = normalizeDeclaredReference(reference);

    if (normalizedReference) {
      normalizedReferences.push(normalizedReference);
    }
  }

  return normalizedReferences;
}

/**
 * Determines whether two declared references are operationally equivalent.
 *
 * @remarks
 * Runtime equality is deterministic and based on:
 * - normalized file path
 * - normalized line number
 *
 * References without line numbers are considered equivalent
 * when both target the same normalized file.
 *
 * @param left Left runtime reference.
 * @param right Right runtime reference.
 */
export function areReferencesEqual(
  left: DeclaredReference,
  right: DeclaredReference,
): boolean {
  const leftFile = normalizeReferencePath(left.file);
  const rightFile = normalizeReferencePath(right.file);

  if (leftFile !== rightFile) {
    return false;
  }

  const leftLine = normalizeReferenceLine(left.line);
  const leftEnd = normalizeReferenceLine((left as any).endLine);
  const leftSymbol = typeof left.symbol === 'string' ? left.symbol : undefined;

  const rightLine = normalizeReferenceLine(right.line);
  const rightEnd = normalizeReferenceLine((right as any).endLine);
  const rightSymbol =
    typeof right.symbol === 'string' ? right.symbol : undefined;

  // Symbol-based equality takes precedence: both must have the same symbol.
  if (leftSymbol !== undefined || rightSymbol !== undefined) {
    return (
      leftSymbol !== undefined &&
      rightSymbol !== undefined &&
      leftSymbol === rightSymbol
    );
  }

  // Both file-level (no lines) -> equal.
  if (
    leftLine === undefined &&
    rightLine === undefined &&
    leftEnd === undefined &&
    rightEnd === undefined
  ) {
    return true;
  }

  // Normalize ranges: if one side is a range and the other a single line, test containment.
  // If both are ranges, consider them equal when they overlap.
  const leftStart = leftLine;
  const leftStop = leftEnd ?? leftLine;
  const rightStart = rightLine;
  const rightStop = rightEnd ?? rightLine;

  if (leftStart === undefined || rightStart === undefined) {
    // One side lacks line info while the other has it: not equal (file-level handled above).
    return false;
  }

  // Overlap check (inclusive).
  return !(leftStop! < rightStart! || rightStop! < leftStart!);
}

/**
 * Normalizes semantic string collections such as:
 * - links
 * - tags
 *
 * @remarks
 * The runtime intentionally preserves lightweight semantics.
 *
 * This normalization:
 * - trims values
 * - removes surrounding YAML quotes
 * - removes duplicates
 * - preserves insertion order
 *
 * Empty values are ignored safely.
 *
 * @param values Semantic string values.
 */
function normalizeSemanticStrings(
  values: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalizedValues: string[] = [];
  const seenValues = new Set<string>();

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalizedValue = stripYamlQuotes(value).trim();

    if (!normalizedValue) {
      continue;
    }

    if (seenValues.has(normalizedValue)) {
      continue;
    }

    seenValues.add(normalizedValue);
    normalizedValues.push(normalizedValue);
  }

  return normalizedValues;
}

/**
 * Normalizes declared semantic links.
 *
 * @param links Declared note links.
 */
export function normalizeLinks(links: readonly string[] | undefined): string[] {
  return normalizeSemanticStrings(links);
}

/**
 * Normalizes declared semantic tags.
 *
 * @param tags Declared note tags.
 */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  return normalizeSemanticStrings(tags);
}
