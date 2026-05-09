import type { Note } from '../models/note.model';

/**
 * Returns true when the note contains any operational semantic context
 * (fields used by core features: `id`, `links`, `references`).
 */
export function hasOperationalContext(note: Partial<Note>): boolean {
  return !!(
    (note.id && String(note.id).trim().length > 0) ||
    (note.links && note.links.length > 0) ||
    (note.references && note.references.length > 0)
  );
}

/**
 * Returns true when the note declares semantic outbound links in frontmatter.
 */
export function hasSemanticLinks(note: Partial<Note>): boolean {
  return !!(note.links && note.links.length > 0);
}

/**
 * Returns true when the note declares code references in frontmatter.
 */
export function hasReferences(note: Partial<Note>): boolean {
  return !!(note.references && note.references.length > 0);
}

/**
 * Returns true when the note has descriptive metadata worth showing to users.
 * This treats `tags` as descriptive and only counts non-empty tag lists.
 */
export function hasDescriptiveMetadata(note: Partial<Note>): boolean {
  return !!(
    (note.tags && note.tags.length > 0) ||
    (note.summary && String(note.summary).trim().length > 0)
  );
}

/**
 * Returns true when the note has any non-empty `tags` list.
 * Differentiates between absent (`undefined`) and explicitly empty (`[]`).
 */
export function hasTags(note: Partial<Note>): boolean {
  return !!(note.tags && note.tags.length > 0);
}
