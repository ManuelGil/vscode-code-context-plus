import { FileSystemError, type TextDocument, Uri, workspace } from 'vscode';

import { ExtensionConfig } from '../configs';
import {
  basenameFromFsPath,
  findFiles,
  getWorkspaceFolderUri,
  normalizeDeclaredReference,
  normalizeReferenceLine,
  normalizeReferencePath,
  parseDeclaredReferencesFromFrontmatter,
  parseFrontmatterDialect,
  quoteYamlScalar,
  type ReferenceResolution,
  readFileContent,
  resolveDeclaredReference,
  resolveDeclaredReferenceInDocument,
  resolveReferenceFileCandidates,
  stripYamlQuotes,
  toPosixPath,
  type UnresolvedReference,
} from '../helpers';
import type {
  DeclaredReference,
  DeclaredReferenceLocation,
  FileContextEntry,
  FrontmatterIdentity,
  Note,
  NotesIdentityValidationError,
  NotesIdentityValidationResult,
  NotesIdentityValidationWarning,
  OperationContext,
  SafeParseResult,
} from '../models/note.model';

type FrontmatterEntryRange = {
  key: string;
  start: number;
  end: number;
};

type FrontmatterSnapshot = {
  raw: string;
  entries: FrontmatterEntryRange[];
};

/**
 * Reads and writes project notes as Markdown files with YAML frontmatter under the configured notes folder.
 *
 * Uses the workspace filesystem as the only source of truth and resolves the notes directory from the selected workspace folder.
 *
 * Domain logic for identity index, outbound links, backlinks, and frontmatter references lives on this class as private methods (no secondary domain services).
 *
 * Cost (high level):
 * - Optional {@link OperationContext} avoids duplicate scans within one orchestrated call.
 * - No global caching.
 */
export class NotesService {
  private readonly frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  private readonly frontmatterCache = new Map<string, FrontmatterSnapshot>();

  /**
   * Initializes configuration only; filesystem access begins when a method is invoked.
   */
  constructor(readonly config: ExtensionConfig) {}

  private get notesDir(): Uri | null {
    const rootFolderUri = getWorkspaceFolderUri(this.config);

    if (!rootFolderUri) {
      return null;
    }

    const resolvedNotesRoot = Uri.joinPath(
      rootFolderUri,
      this.config.notesFolder,
    );

    return resolvedNotesRoot;
  }

  getNotesDirectoryUri(): Uri | null {
    return this.notesDir;
  }

  /**
   * Single entry point for filesystem note discovery; populates `context.noteUris` when `context` is provided.
   */
  async discoverNoteFileUrisThroughContext(
    context?: OperationContext,
  ): Promise<Uri[]> {
    if (context?.noteUris) {
      return context.noteUris;
    }

    if (!this.notesDir) {
      return [];
    }

    const files = await findFiles({
      baseDirectoryPath: this.notesDir.fsPath,
      baseDirectoryUri: this.notesDir,
      includeFilePatterns: ['**/*.md'],
      includeDotfiles: true,
    });
    const uris = [...files].sort((fileUriA, fileUriB) =>
      fileUriA.fsPath.localeCompare(fileUriB.fsPath),
    );

    if (context) {
      context.noteUris = uris;
    }

    return uris;
  }

  /**
   * Returns every readable note under the configured folder (missing note files are skipped).
   *
   * @throws When note discovery fails or when reading/parsing fails for any discovered file that exists on disk.
   */
  async getAllNotes(): Promise<Note[]> {
    const context: OperationContext = {};
    const noteUris = await this.discoverNoteFileUrisThroughContext(context);
    const notePromises = noteUris.map((uri) => this.getNote(uri));
    const notes = await Promise.all(notePromises);
    return notes.filter((note): note is Note => note !== null);
  }

  /**
   * Builds an in-memory `id -> Uri` index from note frontmatter, and returns basic validation output.
   *
   * Parses `id` and optional `title` from YAML frontmatter.
   *
   * Notes that cannot be read are skipped unless every candidate file fails to read — then this operation fails loudly.
   *
   * Cost: one filesystem discovery + one read per note file (see identity index). Pass `ctx` to share discovery within one operation.
   *
   * @throws When discovery fails or when every discovered note file fails to read.
   */
  async validateNotesIdentity(
    ctx?: OperationContext,
  ): Promise<NotesIdentityValidationResult> {
    const operationCtx = ctx ?? {};
    return this.validateNotesIdentityCore(operationCtx);
  }

  /**
   * Opens a note by its frontmatter `id`.
   *
   * Constraints:
   * - Rebuilds the identity index from disk on each call (deterministic, no background watchers).
   */
  async getNoteById(id: string): Promise<Note | null> {
    const trimmed = id.trim();
    if (!trimmed) {
      return null;
    }

    const operationCtx: OperationContext = {};
    const validation = await this.validateNotesIdentityCore(operationCtx);
    const duplicate = validation.errors.some(
      (e) => e.type === 'duplicated-id' && e.id === trimmed,
    );
    if (duplicate) {
      return null;
    }

    const uri = validation.index.get(trimmed);
    if (!uri) {
      return null;
    }

    return this.getNote(uri);
  }

  /**
   * Resolves `links` declared in frontmatter for the note identified by `noteId`.
   *
   * Constraints:
   * - Uses the identity index (`validateNotesIdentity`) as the only resolver source.
   * - Reads links only from frontmatter; invalid/non-string entries are ignored.
   *
   * @throws When identity validation fails irrecoverably or when the source note cannot be read from disk.
   */
  async getResolvedLinks(
    noteId: string,
    operationCtx?: OperationContext,
  ): Promise<{
    valid: { id: string; uri: Uri }[];
    broken: string[];
  }> {
    const ctx = operationCtx ?? {};
    const validation = await this.validateNotesIdentityCore(ctx);
    const trimmed = noteId.trim();
    if (!trimmed) {
      return { valid: [], broken: [] };
    }

    const duplicate = validation.errors.some(
      (e) => e.type === 'duplicated-id' && e.id === trimmed,
    );
    if (duplicate) {
      return { valid: [], broken: [] };
    }

    const sourceUri = validation.index.get(trimmed);
    if (!sourceUri) {
      return { valid: [], broken: [] };
    }

    let noteContent = '';
    try {
      noteContent = await readFileContent(sourceUri);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to resolve outbound links for note "${trimmed}" while reading ${sourceUri.fsPath}: ${detail}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const { data: identity } = this.parseIdentityFromMarkdown(noteContent);
    const links = identity?.links ?? [];
    const valid: { id: string; uri: Uri }[] = [];
    const broken: string[] = [];

    for (const linkId of links) {
      if (typeof linkId !== 'string' || !linkId.trim()) {
        continue;
      }
      const id = linkId.trim();
      const linkedUri = validation.index.get(id);
      if (linkedUri) {
        valid.push({ id, uri: linkedUri });
      } else {
        broken.push(id);
      }
    }

    return { valid, broken };
  }

  /**
   * Orchestrates backlink resolution: full note discovery and link parsing per call.
   *
   * Constraints:
   * - Uses the existing note discovery pipeline and frontmatter parser only.
   * - Reads backlinks from declared `links` values; no markdown body inference.
   *
   * @throws When discovery fails or when every candidate note file fails to read (cannot evaluate backlinks reliably).
   */
  async getBacklinks(
    targetId: string,
    operationCtx?: OperationContext,
  ): Promise<{
    sources: { id: string; uri: Uri; title?: string }[];
  }> {
    const ctx = operationCtx ?? {};
    const trimmedTargetId = targetId.trim();
    if (!trimmedTargetId) {
      return { sources: [] };
    }

    const discoveredNoteUris =
      await this.discoverNoteFileUrisThroughContext(ctx);
    const sources: { id: string; uri: Uri; title?: string }[] = [];
    const contents = await Promise.all(
      discoveredNoteUris.map(
        async (
          noteUri,
        ): Promise<{
          noteUri: Uri;
          content?: string;
          readError?: unknown;
        }> => {
          try {
            const content = await readFileContent(noteUri);
            return { noteUri, content };
          } catch (readError) {
            return { noteUri, readError };
          }
        },
      ),
    );

    if (
      discoveredNoteUris.length > 0 &&
      contents.every((entry) => entry.content === undefined)
    ) {
      const cause =
        contents.find((entry) => entry.readError !== undefined)?.readError ??
        new Error('Unknown read failure');
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Failed to resolve backlinks for note "${trimmedTargetId}": no readable notes among ${discoveredNoteUris.length} candidate file(s): ${detail}`,
        { cause: cause instanceof Error ? cause : undefined },
      );
    }

    for (const { noteUri, content } of contents) {
      if (content === undefined) {
        continue;
      }

      const { data: identity } = this.parseIdentityFromMarkdown(content);
      const id = identity?.id;
      const links = identity?.links ?? [];
      if (!id || !links.includes(trimmedTargetId)) {
        continue;
      }

      sources.push({
        id,
        uri: noteUri,
        title: identity?.title,
      });
    }

    return { sources };
  }

  /**
   * Resolves `references` declared in frontmatter for the note identified by `noteId`.
   *
   * @remarks
   * Resolution is derived, never written back: a reference whose code moved is reported at its
   * current location and the note on disk is left untouched. Paths are resolved relative to
   * {@link getWorkspaceFolderUri} for the note file (multi-root aware) and absolute `file`
   * paths are taken literally.
   *
   * References that cannot be located without guessing between candidates are returned as
   * unresolved rather than pointed at whichever candidate came first.
   *
   * @throws When identity validation fails irrecoverably or when the source note cannot be read.
   */
  async getResolvedReferences(
    noteId: string,
    operationCtx?: OperationContext,
  ): Promise<{
    resolved: Extract<ReferenceResolution, { status: 'resolved' }>[];
    unresolved: UnresolvedReference[];
  }> {
    const ctx = operationCtx ?? {};
    const trimmedNoteId = noteId.trim();
    if (!trimmedNoteId) {
      return { resolved: [], unresolved: [] };
    }

    const validation = await this.validateNotesIdentityCore(ctx);
    const duplicate = validation.errors.some(
      (e) => e.type === 'duplicated-id' && e.id === trimmedNoteId,
    );
    if (duplicate) {
      return { resolved: [], unresolved: [] };
    }

    const sourceUri = validation.index.get(trimmedNoteId);
    if (!sourceUri) {
      return { resolved: [], unresolved: [] };
    }

    const rootFolderUri = getWorkspaceFolderUri(this.config, sourceUri);
    if (!rootFolderUri) {
      return { resolved: [], unresolved: [] };
    }

    let noteMarkdown = '';
    try {
      noteMarkdown = await readFileContent(sourceUri);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to resolve references for note "${trimmedNoteId}" while reading ${sourceUri.fsPath}: ${detail}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const declarations = parseDeclaredReferencesFromFrontmatter(
      this.extractFrontmatter(noteMarkdown),
    );

    const resolutions = await Promise.all(
      declarations.map((ref) =>
        resolveDeclaredReference(ref, {
          workspaceRoot: rootFolderUri,
          notesDir: this.notesDir,
        }),
      ),
    );

    return {
      resolved: resolutions.filter(
        (r): r is Extract<ReferenceResolution, { status: 'resolved' }> =>
          r.status === 'resolved',
      ),
      unresolved: resolutions.filter(
        (r): r is UnresolvedReference => r.status === 'unresolved',
      ),
    };
  }

  /** Extracts the raw YAML frontmatter body from note markdown (empty string when absent). */
  private extractFrontmatter(markdown: string): string {
    const normalized = String(markdown ?? '').replace(/\r\n/g, '\n');

    if (!normalized.startsWith('---\n')) {
      return '';
    }

    const endIndex = normalized.indexOf('\n---\n', 4);
    return endIndex === -1 ? '' : normalized.slice(4, endIndex);
  }

  /**
   * Returns every note whose frontmatter `references` include the given workspace file (by declared path or resolved URI).
   */
  async getNotesByFileReference(fileUri: Uri): Promise<{
    notes: { id: string; uri: Uri; title?: string }[];
  }> {
    const targetPaths = this.getReferenceTargetPaths(fileUri);

    const noteUris = await this.discoverNoteFileUrisThroughContext();
    const notes: { id: string; uri: Uri; title?: string }[] = [];
    const seenPaths = new Set<string>();

    for (const noteUri of noteUris) {
      const note = await this.getNote(noteUri);
      if (!note) {
        continue;
      }

      const references = note.references ?? [];
      if (references.length === 0) {
        continue;
      }

      const rootFolderUri = getWorkspaceFolderUri(this.config, noteUri);
      if (!rootFolderUri) {
        continue;
      }

      let matched = false;
      for (const ref of references) {
        if (this.referenceDeclaresTarget(ref, rootFolderUri, targetPaths)) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        continue;
      }

      const dedupeKey = toPosixPath(noteUri.fsPath);
      if (seenPaths.has(dedupeKey)) {
        continue;
      }
      seenPaths.add(dedupeKey);

      const id =
        note.id?.trim() ||
        basenameFromFsPath(noteUri.fsPath).replace(/\.md$/i, '');
      const titleTrim = note.title?.trim();
      notes.push({
        id,
        uri: noteUri,
        ...(titleTrim ? { title: titleTrim } : {}),
      });
    }

    return { notes };
  }

  /**
   * Resolves every declared reference that targets `fileUri` to its current position.
   *
   * @remarks
   * This is the single scan behind decorations, line context and the context pickers: one pass
   * over the notes, one open document, and one resolution per reference. Entries that could not
   * be located keep their note and carry the reason, so the caller can report a conflict instead
   * of pretending the reference points somewhere.
   */
  async getContextEntriesForFile(fileUri: Uri): Promise<FileContextEntry[]> {
    const targetPaths = this.getReferenceTargetPaths(fileUri);
    const noteUris = await this.discoverNoteFileUrisThroughContext();

    let document: TextDocument | undefined;
    try {
      document = await workspace.openTextDocument(fileUri);
    } catch {
      document = undefined;
    }

    const entries: FileContextEntry[] = [];

    for (const noteUri of noteUris) {
      const note = await this.getNote(noteUri);
      if (!note) {
        continue;
      }

      const references = note.references ?? [];
      if (references.length === 0) {
        continue;
      }

      const rootFolderUri = getWorkspaceFolderUri(this.config, noteUri);
      if (!rootFolderUri) {
        continue;
      }

      const id =
        note.id?.trim() ||
        basenameFromFsPath(noteUri.fsPath).replace(/\.md$/i, '');
      const titleTrim = note.title?.trim();
      const noteRef = {
        id,
        uri: noteUri,
        ...(titleTrim ? { title: titleTrim } : {}),
      };

      for (const ref of references) {
        if (!this.referenceDeclaresTarget(ref, rootFolderUri, targetPaths)) {
          continue;
        }

        if (!document) {
          // The file could not be opened (binary, removed mid-scan): keep the declaration.
          entries.push({ note: noteRef, ref, issue: 'file-not-found' });
          continue;
        }

        const resolution = await resolveDeclaredReferenceInDocument(
          ref,
          document,
        );

        entries.push(
          resolution.status === 'resolved'
            ? {
                note: noteRef,
                ref,
                startLine: resolution.startLine,
                endLine: resolution.endLine,
                strategy: resolution.strategy,
                ...(resolution.movedFromLine !== undefined
                  ? { movedFromLine: resolution.movedFromLine }
                  : {}),
              }
            : { note: noteRef, ref, issue: resolution.issue },
        );
      }
    }

    return entries;
  }

  /**
   * Returns unique 1-based line numbers where context should be surfaced for `fileUri`.
   *
   * @remarks
   * Lines are the *resolved* ones, so a note whose code moved marks where that code is now.
   * File-level references surface at line `1`. References that could not be located are not
   * marked at all rather than marked in the wrong place. Sorted ascending.
   */
  async getContextDecorationLinesForFile(fileUri: Uri): Promise<number[]> {
    const entries = await this.getContextEntriesForFile(fileUri);
    const lines = new Set<number>();

    for (const entry of entries) {
      if (entry.startLine !== undefined) {
        lines.add(entry.startLine);
      }
    }

    return [...lines].sort((a, b) => a - b);
  }

  /**
   * Returns notes grouped by resolved 1-based line for `fileUri` (only keys in `oneBasedLines`).
   */
  async getNotesForFileGroupedByReferenceLine(
    fileUri: Uri,
    oneBasedLines: readonly number[],
  ): Promise<Map<number, { id: string; uri: Uri; title?: string }[]>> {
    const interest = new Set(oneBasedLines.filter((l) => l >= 1));
    const out = new Map<number, { id: string; uri: Uri; title?: string }[]>();

    if (interest.size === 0) {
      return out;
    }

    const buckets = new Map<
      number,
      Map<string, { id: string; uri: Uri; title?: string }>
    >();
    for (const line of interest) {
      buckets.set(line, new Map());
    }

    for (const entry of await this.getContextEntriesForFile(fileUri)) {
      if (entry.startLine === undefined || !interest.has(entry.startLine)) {
        continue;
      }

      const bucket = buckets.get(entry.startLine);
      if (!bucket) {
        continue;
      }

      const dedupeKey = toPosixPath(entry.note.uri.fsPath);
      if (!bucket.has(dedupeKey)) {
        bucket.set(dedupeKey, entry.note);
      }
    }

    for (const line of interest) {
      const arr = Array.from(buckets.get(line)?.values() ?? []);
      arr.sort((a, b) => {
        const aLabel = (a.title ?? a.id).toLowerCase();
        const bLabel = (b.title ?? b.id).toLowerCase();
        return aLabel.localeCompare(bLabel);
      });
      out.set(line, arr);
    }

    return out;
  }

  /**
   * Notes whose references cover `fileUri` at the given 1-based line.
   *
   * @remarks
   * A range reference matches every line it spans, not just its first, so context attached to a
   * function is found from anywhere inside it.
   */
  async getNotesByFileReferenceAtLine(
    fileUri: Uri,
    line: number,
  ): Promise<{ notes: { id: string; uri: Uri; title?: string }[] }> {
    const notesByPath = new Map<
      string,
      { id: string; uri: Uri; title?: string }
    >();

    for (const entry of await this.getContextEntriesForFile(fileUri)) {
      if (entry.startLine === undefined) {
        continue;
      }

      const endLine = entry.endLine ?? entry.startLine;
      if (line < entry.startLine || line > endLine) {
        continue;
      }

      const dedupeKey = toPosixPath(entry.note.uri.fsPath);
      if (!notesByPath.has(dedupeKey)) {
        notesByPath.set(dedupeKey, entry.note);
      }
    }

    const notes = Array.from(notesByPath.values()).sort((a, b) => {
      const aLabel = (a.title ?? a.id).toLowerCase();
      const bLabel = (b.title ?? b.id).toLowerCase();
      return aLabel.localeCompare(bLabel);
    });

    return { notes };
  }

  /**
   * Creates a new note file from a title, optional body, and optional tags. Returns `null` if there is no workspace or writing fails.
   */
  async createNote(
    title: string,
    content = '',
    tags?: string[],
  ): Promise<Note | null> {
    if (!this.notesDir) {
      return null;
    }

    const filename = title
      .replace(/[<>:"/\|?*]/g, '-')
      .replace(/\s+/g, '_')
      .replace(/-+/g, '-')
      .toLowerCase();
    const note: Note = {
      id: filename,
      title,
      content,
      filePath: Uri.joinPath(this.notesDir, `${filename}.md`).fsPath,
      ...(tags !== undefined ? { tags } : {}),
    };

    const fileUri = Uri.file(note.filePath);
    const directoryUri = Uri.joinPath(fileUri, '..');
    const frontmatterSections: string[] = [
      `id: ${note.id}\n`,
      `title: ${note.title}\n`,
    ];

    if (Object.prototype.hasOwnProperty.call(note, 'tags')) {
      if (note.tags && note.tags.length > 0) {
        frontmatterSections.push(`tags: [${note.tags.join(', ')}]\n`);
      } else {
        frontmatterSections.push('tags: []\n');
      }
    }

    const frontmatterBody = frontmatterSections.join('');
    const normalizedFrontmatter = frontmatterBody.endsWith('\n')
      ? frontmatterBody
      : `${frontmatterBody}\n`;

    try {
      await workspace.fs.createDirectory(directoryUri);
      const fileContent = `---\n${normalizedFrontmatter}---\n\n${note.content}`;
      await workspace.fs.writeFile(
        fileUri,
        new TextEncoder().encode(fileContent),
      );

      const snapshot = this.captureFrontmatterSnapshot(normalizedFrontmatter);
      this.frontmatterCache.set(note.filePath, snapshot);

      return note;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create note file: ${detail}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Loads a single note from disk using the file URI. Returns `null` if the file is missing or unreadable.
   */
  async getNote(fileUri: Uri): Promise<Note | null> {
    try {
      await workspace.fs.stat(fileUri);
    } catch {
      return null;
    }

    try {
      const content = await readFileContent(fileUri);

      const frontmatterMatch = content.match(this.frontmatterRegex);
      const frontmatter = frontmatterMatch?.[1] ?? '';
      const parsed = parseFrontmatterDialect(frontmatter, {
        listKeys: ['tags', 'links'],
      });
      const fields = parsed.scalars;
      const noteContent = frontmatterMatch
        ? content.slice(frontmatterMatch.index! + frontmatterMatch[0].length)
        : content;

      if (frontmatterMatch) {
        const snapshot = this.captureFrontmatterSnapshot(frontmatter);
        this.frontmatterCache.set(fileUri.fsPath, snapshot);
      }

      const fileName = basenameFromFsPath(fileUri.fsPath).replace(/\.md$/i, '');

      const references = parseDeclaredReferencesFromFrontmatter(frontmatter);

      if (parsed.warnings.length > 0) {
        for (const warning of parsed.warnings) {
          console.warn(
            `[CodeContext+] Frontmatter warning in ${fileUri.fsPath}: ${warning}`,
          );
        }
      }

      let tags: string[] | undefined;
      if (Object.prototype.hasOwnProperty.call(parsed.lists, 'tags')) {
        tags = parsed.lists.tags;
      } else if (fields.tags) {
        const trimmedTags = fields.tags.trim();
        if (trimmedTags.startsWith('[') && trimmedTags.endsWith(']')) {
          const tagsInner = trimmedTags.slice(1, -1).trim();
          tags = tagsInner
            ? tagsInner
                .split(',')
                .map((listEntry) => listEntry.trim())
                .filter((listEntry) => listEntry.length > 0)
            : [];
        } else {
          tags = [trimmedTags];
        }
      }

      let links: string[] | undefined;
      if (Object.prototype.hasOwnProperty.call(parsed.lists, 'links')) {
        links = parsed.lists.links;
      } else if (fields.links) {
        const trimmedLinks = fields.links.trim();
        if (trimmedLinks.startsWith('[') && trimmedLinks.endsWith(']')) {
          const linksInner = trimmedLinks.slice(1, -1).trim();
          links = linksInner
            ? linksInner
                .split(',')
                .map((listEntry) => listEntry.trim())
                .filter((listEntry) => listEntry.length > 0)
            : [];
        } else {
          links = [trimmedLinks];
        }
      }

      return {
        id: fields.id ?? '',
        title: fields.title ?? fileName,
        content: noteContent,
        filePath: fileUri.fsPath,
        type: fields.type,
        tags,
        links,
        references: references.length > 0 ? references : undefined,
        summary: fields.summary,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read note (${fileUri.fsPath}): ${detail}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Deletes a note file permanently (not sent to trash).
   *
   * @returns `false` when the file does not exist.
   * @throws When the file exists but deletion fails, or when presence cannot be verified for reasons other than not-found.
   */
  async deleteNote(filePath: string): Promise<boolean> {
    const fileUri = Uri.file(filePath);

    try {
      await workspace.fs.stat(fileUri);
    } catch (error) {
      if (error instanceof FileSystemError && error.code === 'FileNotFound') {
        return false;
      }
      throw new Error(`Cannot verify note exists before delete: ${filePath}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }

    try {
      await workspace.fs.delete(fileUri, { useTrash: false });
      return true;
    } catch (error) {
      throw new Error(`Failed to delete note at ${filePath}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async addLinkToNote(
    note: Note,
    targetNoteId: string,
  ): Promise<'added' | 'duplicate'> {
    const trimmedTargetId = targetNoteId.trim();
    if (!trimmedTargetId) {
      throw new Error(
        `Cannot add related note: missing target note id for ${note.filePath}`,
      );
    }

    const existingLinks = note.links ?? [];
    const normalizedLinks = existingLinks
      .map((linkId) => linkId.trim())
      .filter((linkId) => linkId.length > 0);

    if (normalizedLinks.includes(trimmedTargetId)) {
      return 'duplicate';
    }

    const nextLinks = [...existingLinks, trimmedTargetId];
    await this.patchFrontmatterSection(
      note.filePath,
      'links',
      (existingEntry) => this.mergeLinksSection(existingEntry, nextLinks),
    );

    note.links = nextLinks;
    return 'added';
  }

  /**
   * Appends a code reference to a note, preserving the note's existing frontmatter style.
   *
   * @param note Target note.
   * @param targetFileUri File the reference points at.
   * @param location Position and identity evidence captured from the editor.
   */
  async addReferenceForLocation(
    note: Note,
    targetFileUri: Uri,
    location?: DeclaredReferenceLocation,
  ): Promise<'added' | 'duplicate'> {
    const candidateReference = this.buildDeclaredReference(
      targetFileUri,
      location,
    );
    const existingReferences = note.references ?? [];

    const alreadyDeclared = existingReferences.some((ref) =>
      this.areDeclaredReferencesEqual(ref, candidateReference),
    );

    if (alreadyDeclared) {
      return 'duplicate';
    }

    const nextReferences = [...existingReferences, candidateReference];
    await this.patchFrontmatterSection(
      note.filePath,
      'references',
      (existingEntry) =>
        this.mergeReferencesSection(existingEntry, nextReferences),
    );

    note.references = nextReferences;
    return 'added';
  }

  private buildDeclaredReference(
    fileUri: Uri,
    location?: DeclaredReferenceLocation,
  ): DeclaredReference {
    const candidate: DeclaredReference = {
      file: this.getReferencePathForUri(fileUri),
      ...(location ?? {}),
    };

    const normalized = normalizeDeclaredReference(candidate);

    if (!normalized) {
      throw new Error(
        `Unable to build a reference for ${fileUri.fsPath}: normalization failed`,
      );
    }

    return normalized;
  }

  private getReferencePathForUri(fileUri: Uri): string {
    const relativePath = workspace.asRelativePath(fileUri, false);
    if (relativePath && relativePath.trim().length > 0) {
      const normalizedRelative = normalizeReferencePath(relativePath);
      if (normalizedRelative) {
        return normalizedRelative;
      }
    }

    const normalizedAbsolute = normalizeReferencePath(
      toPosixPath(fileUri.fsPath),
    );
    if (!normalizedAbsolute) {
      throw new Error(
        `Unable to build reference path for ${fileUri.fsPath}: normalization failed`,
      );
    }
    return normalizedAbsolute;
  }

  /**
   * Whether two references denote the same declaration.
   *
   * @remarks
   * Identity is literal - same file, same span, same symbol - so that adding a reference to a
   * line already covered by a range is recorded rather than silently swallowed. Anchors are
   * excluded: they describe the code, not which declaration this is.
   */
  private areDeclaredReferencesEqual(
    left: DeclaredReference,
    right: DeclaredReference,
  ): boolean {
    const leftPath = normalizeReferencePath(left.file);
    const rightPath = normalizeReferencePath(right.file);
    if (!leftPath || !rightPath) {
      return false;
    }

    if (leftPath !== rightPath) {
      return false;
    }

    const sameNumber = (a: unknown, b: unknown) =>
      normalizeReferenceLine(a) === normalizeReferenceLine(b);

    return (
      sameNumber(left.line, right.line) &&
      sameNumber(left.endLine, right.endLine) &&
      sameNumber(left.column, right.column) &&
      (left.symbol ?? '') === (right.symbol ?? '')
    );
  }

  private async patchFrontmatterSection(
    filePath: string,
    key: 'links' | 'references',
    buildSection: (existingEntry: string | undefined) => string,
  ): Promise<void> {
    const fileUri = Uri.file(filePath);
    let snapshot = await this.ensureFrontmatterSnapshot(fileUri);
    if (!snapshot) {
      throw new Error(
        `Cannot patch frontmatter for ${filePath}: missing snapshot`,
      );
    }

    const existingEntry = this.getFrontmatterEntryText(snapshot, key);
    const nextEntry = buildSection(existingEntry);

    const fileContent = await readFileContent(fileUri);
    const match = fileContent.match(this.frontmatterRegex);
    if (!match || match.index === undefined) {
      throw new Error(
        `Cannot patch frontmatter for ${filePath}: delimiters missing`,
      );
    }

    const nextFrontmatterBody = this.replaceFrontmatterSection(
      snapshot,
      key,
      nextEntry,
    );

    const prefix = fileContent.slice(0, match.index);
    const remainder = fileContent.slice(match.index + match[0].length);
    const updatedContent = `${prefix}---\n${nextFrontmatterBody}---\n${remainder}`;

    await workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode(updatedContent),
    );

    snapshot = this.captureFrontmatterSnapshot(nextFrontmatterBody);
    this.frontmatterCache.set(filePath, snapshot);
  }

  private replaceFrontmatterSection(
    snapshot: FrontmatterSnapshot,
    key: 'links' | 'references',
    replacement: string,
  ): string {
    const entry = snapshot.entries.find((candidate) => candidate.key === key);
    if (!entry) {
      if (snapshot.raw.length === 0) {
        return replacement;
      }
      const needsSeparator = !snapshot.raw.endsWith('\n');
      const separator = needsSeparator ? '\n' : '';
      return `${snapshot.raw}${separator}${replacement}`;
    }

    const before = snapshot.raw.slice(0, entry.start);
    const after = snapshot.raw.slice(entry.end);
    return `${before}${replacement}${after}`;
  }

  private getFrontmatterEntryText(
    snapshot: FrontmatterSnapshot,
    key: string,
  ): string | undefined {
    const entry = snapshot.entries.find((candidate) => candidate.key === key);
    if (!entry) {
      return undefined;
    }
    return snapshot.raw.slice(entry.start, entry.end);
  }

  private mergeLinksSection(
    existingEntry: string | undefined,
    links: string[],
  ): string {
    if (!existingEntry) {
      return this.buildInlineLinksSection(links);
    }

    if (existingEntry.includes('[')) {
      return this.appendInlineLinks(existingEntry, links);
    }

    return this.appendBlockLinks(existingEntry, links);
  }

  private appendInlineLinks(entryText: string, links: string[]): string {
    const open = entryText.indexOf('[');
    const close = entryText.lastIndexOf(']');
    if (open === -1 || close === -1 || close <= open) {
      return this.buildInlineLinksSection(links);
    }
    const inside = entryText.slice(open + 1, close);
    const existingCount = this.countCommaSeparatedItems(inside);
    const additions = links.slice(existingCount);
    if (additions.length === 0) {
      return entryText;
    }

    const needsComma = inside.trim().length > 0;
    const insertion = `${needsComma ? ', ' : ''}${additions.join(', ')}`;
    return `${entryText.slice(0, close)}${insertion}${entryText.slice(close)}`;
  }

  private appendBlockLinks(entryText: string, links: string[]): string {
    const bulletRegex = /^\s*-\s/gm;
    const existingCount = (entryText.match(bulletRegex) ?? []).length;
    const additions = links.slice(existingCount);
    if (additions.length === 0) {
      return entryText;
    }

    const indentMatch = entryText.match(/\n(\s+)-/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    const trimmed = entryText.endsWith('\n')
      ? entryText.slice(0, -1)
      : entryText;
    const extra = additions.map((link) => `\n${indent}- ${link}`).join('');
    return `${trimmed}${extra}\n`;
  }

  private buildInlineLinksSection(links: string[]): string {
    return `links: [${links.join(', ')}]\n`;
  }

  private mergeReferencesSection(
    existingEntry: string | undefined,
    references: DeclaredReference[],
  ): string {
    if (!existingEntry) {
      return this.buildStructuredReferences(references);
    }

    if (existingEntry.includes('file:')) {
      return this.appendStructuredReferences(existingEntry, references);
    }

    if (existingEntry.includes('[')) {
      return this.appendInlineReferences(existingEntry, references);
    }

    return this.appendCompactReferences(existingEntry, references);
  }

  private appendInlineReferences(
    entryText: string,
    references: DeclaredReference[],
  ): string {
    const open = entryText.indexOf('[');
    const close = entryText.lastIndexOf(']');
    if (open === -1 || close === -1 || close <= open) {
      return this.buildStructuredReferences(references);
    }
    const inside = entryText.slice(open + 1, close);
    const existingCount = this.countCommaSeparatedItems(inside);
    const additions = references.slice(existingCount);
    if (additions.length === 0) {
      return entryText;
    }

    const formatted = additions.map((ref) => this.formatCompactReference(ref));
    const needsComma = inside.trim().length > 0;
    const insertion = `${needsComma ? ', ' : ''}${formatted.join(', ')}`;
    return `${entryText.slice(0, close)}${insertion}${entryText.slice(close)}`;
  }

  private appendCompactReferences(
    entryText: string,
    references: DeclaredReference[],
  ): string {
    const bulletRegex = /^\s*-\s/gm;
    const existingCount = (entryText.match(bulletRegex) ?? []).length;
    const additions = references.slice(existingCount);
    if (additions.length === 0) {
      return entryText;
    }

    const indentMatch = entryText.match(/\n(\s+)-/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    const trimmed = entryText.endsWith('\n')
      ? entryText.slice(0, -1)
      : entryText;
    const extra = additions
      .map((ref) => `\n${indent}- ${this.formatCompactReference(ref)}`)
      .join('');
    return `${trimmed}${extra}\n`;
  }

  private appendStructuredReferences(
    entryText: string,
    references: DeclaredReference[],
  ): string {
    const existingCount = (entryText.match(/-\s*file:/g) ?? []).length;
    const additions = references.slice(existingCount);
    if (additions.length === 0) {
      return entryText;
    }

    const indentMatch = entryText.match(/\n(\s+)-\s*file:/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    const trimmed = entryText.endsWith('\n')
      ? entryText.slice(0, -1)
      : entryText;

    const extra = additions
      .map((ref) => this.buildStructuredReferenceRow(ref, indent).join('\n'))
      .join('\n');

    return `${trimmed}\n${extra}\n`;
  }

  private buildStructuredReferences(references: DeclaredReference[]): string {
    const lines = ['references:'];
    for (const ref of references) {
      lines.push(...this.buildStructuredReferenceRow(ref, '  '));
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * Serializes one reference as a structured YAML row.
   *
   * @remarks
   * Field order is fixed (path, position, identity) so that appending a reference never
   * reshuffles what is already on disk. Only fields the reference actually carries are
   * written: nothing is normalized into existence.
   */
  private buildStructuredReferenceRow(
    ref: DeclaredReference,
    indent: string,
  ): string[] {
    const detailIndent = `${indent}  `;
    const rows = [`${indent}- file: ${ref.file}`];

    const numericDetails: [string, number | undefined][] = [
      ['line', ref.line],
      ['endLine', ref.endLine],
      ['column', ref.column],
      ['endColumn', ref.endColumn],
    ];

    for (const [key, value] of numericDetails) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        rows.push(`${detailIndent}${key}: ${value}`);
      }
    }

    if (ref.symbol) {
      rows.push(`${detailIndent}symbol: ${quoteYamlScalar(ref.symbol)}`);
    }

    if (ref.anchor) {
      rows.push(`${detailIndent}anchor: ${quoteYamlScalar(ref.anchor)}`);
    }

    return rows;
  }

  /**
   * Serializes a reference in compact form.
   *
   * @remarks
   * Used only when the note already writes its references compactly, so that appending never
   * rewrites the author's chosen style. The compact grammar cannot express an anchor, so
   * references appended to a compact list keep position and symbol evidence only - which is
   * why new `references:` blocks are written structured.
   */
  private formatCompactReference(ref: DeclaredReference): string {
    let value = ref.file;
    if (typeof ref.line === 'number' && Number.isFinite(ref.line)) {
      value += `#${ref.line}`;
      if (typeof ref.endLine === 'number' && Number.isFinite(ref.endLine)) {
        value += `:${ref.endLine}`;
      }
    }
    if (ref.symbol) {
      value += `@${ref.symbol}`;
    }
    return value;
  }

  private countCommaSeparatedItems(value: string): number {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }
    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0).length;
  }

  private async ensureFrontmatterSnapshot(
    fileUri: Uri,
  ): Promise<FrontmatterSnapshot | null> {
    const cached = this.frontmatterCache.get(fileUri.fsPath);
    if (cached) {
      return cached;
    }

    try {
      const content = await readFileContent(fileUri);
      const match = content.match(this.frontmatterRegex);
      if (!match) {
        return null;
      }
      const snapshot = this.captureFrontmatterSnapshot(match[1]);
      this.frontmatterCache.set(fileUri.fsPath, snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }

  private captureFrontmatterSnapshot(frontmatter: string): FrontmatterSnapshot {
    const entries: FrontmatterEntryRange[] = [];
    const keyRegex = /^([A-Za-z_][\w-]*)\s*:/gm;
    const positions: { key: string; index: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = keyRegex.exec(frontmatter)) !== null) {
      const key = match[1];
      const lineStart = frontmatter.lastIndexOf('\n', match.index - 1) + 1;
      const leadingSegment = frontmatter.slice(lineStart, match.index);
      if (leadingSegment.trim().length > 0) {
        continue;
      }
      positions.push({ key, index: lineStart });
    }

    for (let i = 0; i < positions.length; i++) {
      const current = positions[i];
      const next = positions[i + 1];
      entries.push({
        key: current.key,
        start: current.index,
        end: next ? next.index : frontmatter.length,
      });
    }

    return { raw: frontmatter, entries };
  }

  /**
   * Builds an in-memory `id -> Uri` index from note frontmatter, and returns basic validation output.
   */
  private async validateNotesIdentityCore(
    operationContext: OperationContext,
  ): Promise<NotesIdentityValidationResult> {
    const index = new Map<string, Uri>();
    const errors: NotesIdentityValidationError[] = [];
    const warnings: NotesIdentityValidationWarning[] = [];

    const duplicates = new Map<string, Uri[]>();

    const noteUris =
      await this.discoverNoteFileUrisThroughContext(operationContext);

    const fileReads = await Promise.all(
      noteUris.map(
        async (
          fileUri,
        ): Promise<{
          fileUri: Uri;
          content?: string;
          readError?: unknown;
        }> => {
          try {
            const content = await readFileContent(fileUri);
            return { fileUri, content };
          } catch (readError) {
            return { fileUri, readError };
          }
        },
      ),
    );

    if (
      noteUris.length > 0 &&
      fileReads.every((read) => read.content === undefined)
    ) {
      const cause =
        fileReads.find((read) => read.readError !== undefined)?.readError ??
        new Error('Unknown read failure');
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Failed to build notes identity index for ${noteUris.length} discovered note file(s): none could be read: ${detail}`,
        { cause: cause instanceof Error ? cause : undefined },
      );
    }

    for (const { fileUri, content } of fileReads) {
      if (content === undefined) {
        continue;
      }

      const { data: identity } = this.parseIdentityFromMarkdown(content);

      const id = identity?.id;

      if (!id) {
        errors.push({ type: 'missing-id', file: fileUri });
        continue;
      }

      const base = basenameFromFsPath(fileUri.fsPath).replace(/\.md$/i, '');
      if (base !== id) {
        warnings.push({
          type: 'filename-mismatch',
          id,
          file: fileUri,
          filenameBase: base,
        });
      }

      if (index.has(id)) {
        const existing = index.get(id);
        const list = duplicates.get(id) ?? (existing ? [existing] : []);
        list.push(fileUri);
        duplicates.set(id, list);
        continue;
      }

      index.set(id, fileUri);
    }

    for (const [id, files] of duplicates.entries()) {
      errors.push({ type: 'duplicated-id', id, files });
    }

    return { index, errors, warnings };
  }

  /**
   * Extracts `id`, `title`, and `links` fields from note frontmatter YAML.
   */
  private parseIdentityFromMarkdown(
    markdown: string,
  ): SafeParseResult<FrontmatterIdentity> {
    const errors: string[] = [];
    try {
      if (typeof markdown !== 'string') {
        return {
          data: { links: [] },
          errors: ['markdown must be a string'],
        };
      }

      const normalized = markdown.replace(/\r\n/g, '\n');
      if (!normalized.startsWith('---\n')) {
        return { data: { links: [] }, errors };
      }

      const endIndex = normalized.indexOf('\n---\n', 4);
      if (endIndex === -1) {
        errors.push('frontmatter: missing closing delimiter');
        return { data: { links: [] }, errors };
      }

      const frontmatter = normalized.slice(4, endIndex);
      const parsed = parseFrontmatterDialect(frontmatter, {
        listKeys: ['links'],
      });
      const id = parsed.scalars.id
        ? stripYamlQuotes(parsed.scalars.id)
        : undefined;
      const title = parsed.scalars.title
        ? stripYamlQuotes(parsed.scalars.title)
        : undefined;
      let rawLinks: string[] | undefined;
      if (Object.prototype.hasOwnProperty.call(parsed.lists, 'links')) {
        rawLinks = parsed.lists.links;
      } else {
        const value = parsed.scalars.links;
        if (Array.isArray(value)) {
          const sanitized = value
            .filter((l): l is string => typeof l === 'string')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          rawLinks = Array.from(new Set(sanitized));
        } else if (typeof value !== 'string') {
          if (value !== undefined) {
            errors.push('links: expected string or array form');
          }
          rawLinks = [];
        } else {
          const trimmed = value.trim();
          if (!trimmed) {
            rawLinks = [];
          } else if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
            errors.push('links: expected bracket list');
            rawLinks = [];
          } else {
            const inner = trimmed.slice(1, -1).trim();
            if (!inner) {
              rawLinks = [];
            } else {
              const parsedInner = inner
                .split(',')
                .map((s) => s.trim())
                .map((s) => {
                  if (
                    (s.startsWith('"') && s.endsWith('"')) ||
                    (s.startsWith("'") && s.endsWith("'"))
                  ) {
                    return s.slice(1, -1).trim();
                  }
                  return s;
                })
                .filter((s) => s.length > 0);
              rawLinks = Array.from(new Set(parsedInner));
            }
          }
        }
      }

      const links = Array.from(
        new Set(
          (rawLinks ?? [])
            .filter((l): l is string => typeof l === 'string')
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        ),
      );

      if (parsed.warnings.length > 0) {
        errors.push(...parsed.warnings);
      }

      const data: FrontmatterIdentity = {
        id,
        title,
        links: links ?? [],
      };
      return { data, errors };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: { links: [] }, errors: [message] };
    }
  }

  /**
   * Whether a frontmatter reference row points at the given file (declared path or resolved URI).
   */
  private referenceDeclaresTarget(
    ref: DeclaredReference,
    rootFolderUri: Uri,
    targetPaths: readonly string[],
  ): boolean {
    const decl = normalizeReferencePath(ref.file);
    const normalizedTargets = targetPaths.map((p) => normalizeReferencePath(p));
    if (decl) {
      if (normalizedTargets.includes(decl)) {
        return true;
      }
    }

    return this.resolveWorkspaceReferenceUris(rootFolderUri, ref.file).some(
      (resolved) => {
        const rp = normalizeReferencePath(toPosixPath(resolved.fsPath));
        return (
          targetPaths.includes(toPosixPath(resolved.fsPath)) ||
          normalizedTargets.includes(rp)
        );
      },
    );
  }

  /**
   * Resolves a reference path to candidate absolute `Uri`s without checking file existence.
   */
  private resolveWorkspaceReferenceUris(
    workspaceRoot: Uri,
    fileRef: string,
  ): Uri[] {
    return resolveReferenceFileCandidates(
      workspaceRoot,
      this.notesDir,
      fileRef,
    );
  }

  /**
   * Returns the absolute and relative target paths that may identify a file reference.
   */
  private getReferenceTargetPaths(fileUri: Uri): string[] {
    const targetPaths = new Set<string>();
    const absolutePath = toPosixPath(fileUri.fsPath);

    targetPaths.add(absolutePath);
    targetPaths.add(toPosixPath(workspace.asRelativePath(fileUri, false)));

    if (this.notesDir) {
      const notesDirPath = toPosixPath(this.notesDir.fsPath).replace(/\/$/, '');

      if (
        absolutePath === notesDirPath ||
        absolutePath.startsWith(`${notesDirPath}/`)
      ) {
        targetPaths.add(absolutePath.slice(notesDirPath.length + 1));
      }
    }

    return [...targetPaths];
  }
}
