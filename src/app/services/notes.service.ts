import { FileSystemError, Uri, workspace } from 'vscode';

import { ExtensionConfig } from '../configs';
import {
  basenameFromFsPath,
  findFiles,
  getWorkspaceFolderUri,
  normalizeReferencePath,
  parseDeclaredReferencesFromFrontmatter,
  parseFrontmatterDialect,
  readFileContent,
  stripYamlQuotes,
  toPosixPath,
} from '../helpers';
import type {
  BacklinkSourcesResult,
  DeclaredReference,
  FrontmatterIdentity,
  Note,
  NoteLink,
  NoteReference,
  NotesIdentityValidationError,
  NotesIdentityValidationResult,
  NotesIdentityValidationWarning,
  OperationContext,
  ResolvedLinksResult,
  ResolvedReferencesResult,
  SafeParseResult,
} from '../models/note.model';

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
  private notesDir: Uri | null = null;

  private readonly frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;

  private notesInitialized = false;

  /**
   * Initializes configuration only; filesystem access begins when a method is invoked.
   */
  constructor(readonly config: ExtensionConfig) {}

  /**
   * Surfaces IO/read failures at domain boundaries instead of returning empty success-shaped values.
   */
  private failReading(operationDescription: string, cause: unknown): never {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${operationDescription}: ${detail}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }

  /**
   * Ensures `notesDir` is set once when a workspace folder exists. Safe to call repeatedly.
   */
  public async ensureNotesDirectoryExists(): Promise<void> {
    if (this.notesInitialized) {
      return;
    }

    const rootFolderUri = getWorkspaceFolderUri(this.config);
    if (!rootFolderUri) {
      return;
    }

    this.notesDir = Uri.joinPath(rootFolderUri, this.config.notesFolder);

    this.notesInitialized = true;
  }

  /**
   * Returns the resolved notes directory after {@link ensureNotesDirectoryExists}, or `null` if unavailable.
   */
  getNotesDirectoryUri(): Uri | null {
    return this.notesDir;
  }

  /**
   * Ensures the in-memory notes path is initialized (does not create the folder on disk until a write).
   */
  async initializeNotesDirectory(): Promise<void> {
    await this.ensureNotesDirectoryExists();
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
    const uris = await this.discoverNoteFileUris();
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
    const notePromises = noteUris.map((uri) => this.readNote(uri));
    const notes = await Promise.all(notePromises);
    return notes.filter((note): note is Note => note !== null);
  }

  /**
   * Sorted absolute paths to `.md` note files under the notes folder.
   * Does not read file contents.
   */
  async listNoteFilePaths(): Promise<string[]> {
    return this.collectMarkdownNotePaths();
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
    return this.resolveOutboundLinks(noteId, validation, ctx);
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
    return this.resolveBacklinkSources(targetId, ctx);
  }

  /**
   * Resolves `references` declared in frontmatter for the note identified by `noteId`.
   *
   * Constraints:
   * - Paths are resolved relative to {@link getWorkspaceFolderUri} for the note file (multi-root aware).
   * - Absolute `file` paths use `Uri.file` only (no alias or glob resolution).
   *
   * @throws When identity validation fails irrecoverably or when the source note cannot be read.
   */
  async getResolvedReferences(
    noteId: string,
    operationCtx?: OperationContext,
  ): Promise<{
    valid: { file: string; uri: Uri; line?: number }[];
    broken: { file: string; reason: string }[];
  }> {
    const ctx = operationCtx ?? {};
    return this.resolveDeclaredReferences(noteId, ctx);
  }

  /**
   * Returns every note whose frontmatter `references` include the given workspace file (by declared path or resolved URI).
   */
  async getNotesByFileReference(fileUri: Uri): Promise<{
    notes: { id: string; uri: Uri; title?: string }[];
  }> {
    await this.ensureNotesDirectoryExists();

    const targetPaths = this.getReferenceTargetPaths(fileUri);

    const noteUris = await this.discoverNoteFileUrisThroughContext();
    const notes: { id: string; uri: Uri; title?: string }[] = [];
    const seenPaths = new Set<string>();

    for (const noteUri of noteUris) {
      const note = await this.readNote(noteUri);
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
   * Returns unique 1-based line numbers from frontmatter `references` that target `fileUri`.
   * References without a line imply line `1` (file-level context). Sorted ascending.
   */
  async getContextDecorationLinesForFile(fileUri: Uri): Promise<number[]> {
    await this.ensureNotesDirectoryExists();

    const targetPaths = this.getReferenceTargetPaths(fileUri);

    const noteUris = await this.discoverNoteFileUrisThroughContext();
    const lines = new Set<number>();

    for (const noteUri of noteUris) {
      const note = await this.readNote(noteUri);
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

      for (const ref of references) {
        if (!this.referenceDeclaresTarget(ref, rootFolderUri, targetPaths)) {
          continue;
        }

        lines.add(this.effectiveReferenceLine(ref));
      }
    }

    return [...lines].sort((a, b) => a - b);
  }

  /**
   * Returns notes grouped by 1-based reference line for `fileUri` (only keys in `oneBasedLines`).
   * File-level references (no line) count as line `1`.
   */
  async getNotesForFileGroupedByReferenceLine(
    fileUri: Uri,
    oneBasedLines: readonly number[],
  ): Promise<Map<number, { id: string; uri: Uri; title?: string }[]>> {
    await this.ensureNotesDirectoryExists();

    const interest = new Set(oneBasedLines.filter((l) => l >= 1));
    const buckets = new Map<
      number,
      Map<string, { id: string; uri: Uri; title?: string }>
    >();
    for (const line of interest) {
      buckets.set(line, new Map());
    }

    const out = new Map<number, { id: string; uri: Uri; title?: string }[]>();
    if (interest.size === 0) {
      return out;
    }

    const targetPaths = this.getReferenceTargetPaths(fileUri);

    const noteUris = await this.discoverNoteFileUrisThroughContext();

    for (const noteUri of noteUris) {
      const note = await this.readNote(noteUri);
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

      for (const ref of references) {
        if (!this.referenceDeclaresTarget(ref, rootFolderUri, targetPaths)) {
          continue;
        }

        const effectiveLine = this.effectiveReferenceLine(ref);
        if (!interest.has(effectiveLine)) {
          continue;
        }

        const bucket = buckets.get(effectiveLine);
        if (!bucket) {
          continue;
        }

        const dedupeKey = toPosixPath(noteUri.fsPath);
        if (bucket.has(dedupeKey)) {
          continue;
        }

        bucket.set(dedupeKey, {
          id,
          uri: noteUri,
          ...(titleTrim ? { title: titleTrim } : {}),
        });
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
   * Notes whose frontmatter references target `fileUri` at the given 1-based line (or file-level at line 1).
   */
  async getNotesByFileReferenceAtLine(
    fileUri: Uri,
    line: number,
  ): Promise<{ notes: { id: string; uri: Uri; title?: string }[] }> {
    const map = await this.getNotesForFileGroupedByReferenceLine(fileUri, [
      line,
    ]);
    return { notes: map.get(line) ?? [] };
  }

  /**
   * Creates a new note file from a title, optional body, and optional tags. Returns `null` if there is no workspace or writing fails.
   */
  async createNote(
    title: string,
    content = '',
    tags?: string[],
  ): Promise<Note | null> {
    await this.ensureNotesDirectoryExists();
    if (!this.notesDir) {
      return null;
    }

    const now = new Date();
    const note: Note = {
      id: this.sanitizeFilename(title),
      title,
      content,
      filePath: Uri.joinPath(
        this.notesDir,
        `${this.sanitizeFilename(title)}.md`,
      ).fsPath,
      createdAt: now,
      updatedAt: now,
      ...(tags !== undefined ? { tags } : {}),
    };

    try {
      await this.saveNote(note);
      return note;
    } catch (error) {
      this.failReading('Failed to create note file', error);
    }
  }

  /**
   * Loads a single note from disk using the file URI. Returns `null` if the file is missing or unreadable.
   */
  async getNote(fileUri: Uri): Promise<Note | null> {
    await this.ensureNotesDirectoryExists();
    return this.readNote(fileUri);
  }

  /**
   * Persists `note` with an updated `updatedAt` timestamp. Returns `null` if the file does not exist.
   */
  async updateNote(note: Note): Promise<Note | null> {
    try {
      await workspace.fs.stat(Uri.file(note.filePath));
    } catch {
      return null;
    }

    const updatedNote: Note = {
      ...note,
      updatedAt: new Date(),
    };

    try {
      await this.saveNote(updatedNote);
      return updatedNote;
    } catch (error) {
      this.failReading(`Failed to save note (${updatedNote.filePath})`, error);
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

  /**
   * Builds a small struct describing a link from a note to a code location (used when inserting Markdown links).
   */
  createNoteLink(
    note: Note,
    targetFilePath: string,
    targetLine: number,
  ): NoteLink {
    return {
      notePath: note.filePath,
      noteTitle: note.title,
      targetFilePath,
      targetLine,
    };
  }

  /**
   * Renders a Markdown link to the note using a workspace-relative path.
   */
  formatNoteLinkMarkdown(link: NoteLink): string {
    const relPath = workspace.asRelativePath(Uri.file(link.notePath), false);
    return `[${link.noteTitle}](${relPath})`;
  }

  /**
   * Discovers all `.md` note files under the notes directory.
   * Sorted by filepath for deterministic ordering.
   * @private
   */
  private async discoverNoteFileUris(): Promise<Uri[]> {
    if (!this.notesDir) {
      await this.ensureNotesDirectoryExists();
      if (!this.notesDir) {
        return [];
      }
    }

    const files = await findFiles({
      baseDirectoryPath: this.notesDir.fsPath,
      baseDirectoryUri: this.notesDir,
      includeFilePatterns: ['**/*.md'],
      includeDotfiles: true,
    });

    const sorted = [...files].sort((fileUriA, fileUriB) =>
      fileUriA.fsPath.localeCompare(fileUriB.fsPath),
    );

    return sorted;
  }

  /**
   * Returns sorted absolute file paths to all discovered note files.
   * @private
   */
  private async collectMarkdownNotePaths(): Promise<string[]> {
    const ctx: OperationContext = {};
    const noteUris = await this.discoverNoteFileUrisThroughContext(ctx);
    return noteUris.map((uri) => uri.fsPath);
  }

  /**
   * Reads and parses a single note file from disk.
   * Returns `null` only when the path does not exist. Throws when the file exists but cannot be read or parsed into a note payload.
   * @private
   */
  private async readNote(fileUri: Uri): Promise<Note | null> {
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
        ? content.replace(frontmatterMatch[0], '').trim()
        : content.trim();

      const fileName = basenameFromFsPath(fileUri.fsPath).replace(/\.md$/i, '');
      const createdAt = fields.created ? new Date(fields.created) : new Date(0);
      const updatedAt = fields.updated ? new Date(fields.updated) : new Date(0);

      const references = parseDeclaredReferencesFromFrontmatter(frontmatter);

      if (parsed.warnings.length > 0) {
        for (const warning of parsed.warnings) {
          console.warn(
            `[CodeContext+] Frontmatter warning in ${fileUri.fsPath}: ${warning}`,
          );
        }
      }

      return {
        id: fields.id ?? '',
        title: fields.title ?? fileName,
        content: noteContent,
        filePath: fileUri.fsPath,
        createdAt,
        updatedAt,
        type: fields.type,
        tags: Object.prototype.hasOwnProperty.call(parsed.lists, 'tags')
          ? parsed.lists.tags
          : this.parseListField(fields.tags),
        links: Object.prototype.hasOwnProperty.call(parsed.lists, 'links')
          ? parsed.lists.links
          : this.parseListField(fields.links),
        references: references.length > 0 ? references : undefined,
        summary: fields.summary,
      };
    } catch (error) {
      this.failReading(`Failed to read note (${fileUri.fsPath})`, error);
    }
  }

  /**
   * Converts a note object into Markdown with YAML frontmatter.
   * @private
   */
  private generateMarkdownContent(note: Note): string {
    let content = '---\n';
    content += `id: ${note.id}\n`;
    content += `title: ${note.title}\n`;
    content += `created: ${note.createdAt.toISOString()}\n`;
    content += `updated: ${note.updatedAt.toISOString()}\n`;
    // Preserve explicit empty-list semantics: write `tags: []` only when the
    // `tags` property is present on the `note` object. Omit entirely when
    // `tags` is `undefined` to represent absent metadata.
    if (Object.prototype.hasOwnProperty.call(note, 'tags')) {
      if (note.tags && note.tags.length > 0) {
        content += `tags: [${note.tags.join(', ')}]\n`;
      } else {
        content += `tags: []\n`;
      }
    }
    if (note.links && note.links.length > 0) {
      content += `links: [${note.links.join(', ')}]\n`;
    }
    if (note.references && note.references.length > 0) {
      content += 'references:\n';
      for (const ref of note.references) {
        content += `  - file: ${ref.file}\n`;
        if (ref.line !== undefined) {
          content += `    line: ${ref.line}\n`;
        }
      }
    }
    if (note.summary) {
      content += `summary: ${note.summary}\n`;
    }
    content += '---\n\n';
    content += note.content;
    return content;
  }

  /**
   * Writes frontmatter and body to `note.filePath`, creating parent directories as needed.
   */
  async saveNote(note: Note): Promise<void> {
    await this.ensureNotesDirectoryExists();

    const fileUri = Uri.file(note.filePath);
    await workspace.fs.createDirectory(Uri.joinPath(fileUri, '..'));

    const fileContent = this.generateMarkdownContent(note);
    await workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode(fileContent),
    );
  }

  /**
   * Parses frontmatter list syntax `[item1, item2]` into a string array.
   * Handles quoted items and normalizes whitespace.
   * @private
   */
  private parseListField(value?: string): string[] | undefined {
    if (!value) {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      return [trimmed];
    }

    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    return inner
      .split(',')
      .map((listEntry) => listEntry.trim())
      .filter((listEntry) => listEntry.length > 0);
  }

  /**
   * Converts a note title into a safe filesystem filename.
   * Removes special characters, lowercases, and normalizes spacing.
   * @private
   */
  private sanitizeFilename(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, '-') // Replace invalid chars with dash
      .replace(/\s+/g, '_') // Replace spaces with underscore
      .replace(/-+/g, '-') // Remove duplicate dashes
      .toLowerCase(); // Convert to lowercase
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
      this.failReading(
        `Failed to build notes identity index for ${noteUris.length} discovered note file(s): none could be read`,
        cause,
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
      const rawLinks = Object.prototype.hasOwnProperty.call(
        parsed.lists,
        'links',
      )
        ? parsed.lists.links
        : this.parseLinksFromFrontmatterField(parsed.scalars.links, errors);
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
   * Parses the YAML `links` field value (`[id1, id2]`) or a homogeneous string array into note ids.
   */
  private parseLinksFromFrontmatterField(
    value: unknown,
    errors?: string[],
  ): string[] {
    if (Array.isArray(value)) {
      const sanitized = value
        .filter((l): l is string => typeof l === 'string')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return Array.from(new Set(sanitized));
    }

    if (typeof value !== 'string') {
      errors?.push('links: expected string or array form');
      return [];
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      if (trimmed.length > 0) {
        errors?.push('links: expected bracket list');
      }
      return [];
    }

    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    const parsed = inner
      .split(',')
      .map((linkSegment) => linkSegment.trim())
      .map((linkSegment) => {
        if (
          (linkSegment.startsWith('"') && linkSegment.endsWith('"')) ||
          (linkSegment.startsWith("'") && linkSegment.endsWith("'"))
        ) {
          return linkSegment.slice(1, -1).trim();
        }
        return linkSegment;
      })
      .filter(
        (linkSegment) =>
          typeof linkSegment === 'string' && linkSegment.length > 0,
      );

    return Array.from(new Set(parsed));
  }

  /**
   * Resolves `links` declared in frontmatter for the note identified by `noteId`.
   *
   * @throws When the source markdown cannot be read — outbound links cannot be derived without it.
   */
  private async resolveOutboundLinks(
    noteId: string,
    validation: NotesIdentityValidationResult,
    _operationCtx?: OperationContext,
  ): Promise<ResolvedLinksResult> {
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
      this.failReading(
        `Failed to resolve outbound links for note "${trimmed}" while reading ${sourceUri.fsPath}`,
        error,
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
   * Resolves reverse links: notes that declare `targetId` inside their frontmatter `links`.
   *
   * @throws When every candidate note fails to read while backlinks must be evaluated across the note set.
   */
  private async resolveBacklinkSources(
    targetId: string,
    ctx: OperationContext,
  ): Promise<BacklinkSourcesResult> {
    const trimmedTargetId = targetId.trim();
    if (!trimmedTargetId) {
      return { sources: [] };
    }

    const discoveredNoteUris =
      await this.discoverNoteFileUrisThroughContext(ctx);

    const sources: NoteReference[] = [];

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
      this.failReading(
        `Failed to resolve backlinks for note "${trimmedTargetId}": no readable notes among ${discoveredNoteUris.length} candidate file(s)`,
        cause,
      );
    }

    for (const { noteUri, content } of contents) {
      if (content === undefined) {
        continue;
      }

      const { data: identity } = this.parseIdentityFromMarkdown(content);

      const id = identity?.id;
      const links = identity?.links ?? [];
      if (!id) {
        continue;
      }

      if (!links.includes(trimmedTargetId)) {
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
   * @throws When the source note cannot be read — references cannot be extracted without frontmatter access.
   */
  private async resolveDeclaredReferences(
    noteId: string,
    ctx: OperationContext,
  ): Promise<ResolvedReferencesResult> {
    const trimmedNoteId = noteId.trim();
    if (!trimmedNoteId) {
      return { valid: [], broken: [] };
    }

    const validation = await this.validateNotesIdentityCore(ctx);
    const duplicate = validation.errors.some(
      (e) => e.type === 'duplicated-id' && e.id === trimmedNoteId,
    );
    if (duplicate) {
      return { valid: [], broken: [] };
    }

    const sourceUri = validation.index.get(trimmedNoteId);
    if (!sourceUri) {
      return { valid: [], broken: [] };
    }

    const rootFolderUri = getWorkspaceFolderUri(this.config, sourceUri);
    if (!rootFolderUri) {
      return { valid: [], broken: [] };
    }

    let noteMarkdown = '';
    try {
      noteMarkdown = await readFileContent(sourceUri);
    } catch (error) {
      this.failReading(
        `Failed to resolve references for note "${trimmedNoteId}" while reading ${sourceUri.fsPath}`,
        error,
      );
    }

    const frontmatter = this.extractReferencesFrontmatterBlock(noteMarkdown);
    const declarations = parseDeclaredReferencesFromFrontmatter(frontmatter);

    const resolutionResults = await Promise.all(
      declarations.map(async (ref) => {
        const uri = await this.resolveDeclaredReferenceUri(
          rootFolderUri,
          ref.file,
        );
        if (!uri) {
          return {
            ref,
            outcome: 'invalid' as const,
          };
        }

        try {
          await workspace.fs.stat(uri);
          const line =
            ref.line !== undefined &&
            Number.isInteger(ref.line) &&
            ref.line >= 1
              ? ref.line
              : undefined;
          return {
            ref,
            outcome: 'ok' as const,
            uri,
            line,
          };
        } catch {
          return {
            ref,
            outcome: 'missing' as const,
          };
        }
      }),
    );

    const valid: { file: string; uri: Uri; line?: number }[] = [];
    const broken: { file: string; reason: string }[] = [];

    for (const result of resolutionResults) {
      if (result.outcome === 'ok') {
        valid.push({
          file: result.ref.file,
          uri: result.uri,
          line: result.line,
        });
      } else if (result.outcome === 'invalid') {
        broken.push({ file: result.ref.file, reason: 'Invalid path' });
      } else {
        broken.push({ file: result.ref.file, reason: 'File not found' });
      }
    }

    return { valid, broken };
  }

  /**
   * Extracts the YAML frontmatter content (between `---` markers) from a Markdown file.
   */
  private extractReferencesFrontmatterBlock(markdown: string): string {
    const normalized = markdown.replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) {
      return '';
    }

    const endIndex = normalized.indexOf('\n---\n', 4);
    if (endIndex === -1) {
      return '';
    }

    return normalized.slice(4, endIndex);
  }

  /**
   * Removes surrounding YAML quote characters (`"` or `'`) if present.
   */

  /**
   * 1-based line from a reference row; missing or invalid line means file-level (`1`).
   */
  private effectiveReferenceLine(ref: DeclaredReference): number {
    const ln = ref.line;
    if (typeof ln === 'number' && Number.isInteger(ln) && ln >= 1) {
      return ln;
    }
    return 1;
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
    const trimmedRaw = fileRef.trim();
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

    try {
      let uri = workspaceRoot;
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

    if (this.notesDir) {
      try {
        let uri = this.notesDir;
        for (const segment of segments) {
          uri =
            segment === '..'
              ? Uri.joinPath(uri, '..')
              : Uri.joinPath(uri, segment);
        }
        candidates.push(uri);
      } catch {
        // Ignore resolution failures for the notes directory base.
      }
    }

    return candidates;
  }

  /**
   * Resolves a reference path to the first existing absolute `Uri`, preferring the workspace root.
   */
  private async resolveDeclaredReferenceUri(
    workspaceRoot: Uri,
    fileRef: string,
  ): Promise<Uri | null> {
    const candidates = this.resolveWorkspaceReferenceUris(
      workspaceRoot,
      fileRef,
    );

    for (const candidate of candidates) {
      try {
        await workspace.fs.stat(candidate);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }

    return candidates[0] ?? null;
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
