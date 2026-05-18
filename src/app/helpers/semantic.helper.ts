import type { Note } from '../models/note.model';
import {
  normalizeDeclaredReferences,
  normalizeLinks,
  normalizeTags,
} from './normalization.helper';

/**
 * Returns true when the note declares operational references.
 *
 * @remarks
 * References participate in:
 * - contextual decorators
 * - line navigation
 * - file navigation
 * - contextual matching
 * - backlinks
 *
 * @param note Runtime note model.
 */
export function hasReferences(note: Partial<Note>): boolean {
  return normalizeDeclaredReferences(note.references).length > 0;
}

/**
 * Returns true when the note declares semantic links.
 *
 * @remarks
 * Semantic links participate in:
 * - related note resolution
 * - backlink traversal
 * - contextual relationships
 *
 * @param note Runtime note model.
 */
export function hasSemanticLinks(note: Partial<Note>): boolean {
  return normalizeLinks(note.links).length > 0;
}

/**
 * Returns true when the note contains operational contextual metadata.
 *
 * @remarks
 * Operational contextual metadata currently includes:
 * - id
 * - links
 * - references
 *
 * These semantics directly participate in runtime contextual behavior.
 *
 * @param note Runtime note model.
 */
export function hasOperationalContext(note: Partial<Note>): boolean {
  return !!(
    (note.id && String(note.id).trim().length > 0) ||
    hasSemanticLinks(note) ||
    hasReferences(note)
  );
}

/**
 * Returns true when the note contains descriptive metadata.
 *
 * @remarks
 * Descriptive metadata is informational and does not directly
 * activate runtime contextual behavior.
 *
 * @param note Runtime note model.
 */
export function hasDescriptiveMetadata(note: Partial<Note>): boolean {
  return !!(
    hasTags(note) ||
    (note.summary && String(note.summary).trim().length > 0)
  );
}

/**
 * Returns true when the note declares normalized tags.
 *
 * @param note Runtime note model.
 */
export function hasTags(note: Partial<Note>): boolean {
  return normalizeTags(note.tags).length > 0;
}
