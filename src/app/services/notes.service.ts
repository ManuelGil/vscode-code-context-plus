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
  DeclaredReference,
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
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to resolve references for note "${trimmedNoteId}" while reading ${sourceUri.fsPath}: ${detail}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const normalizedMarkdown = noteMarkdown.replace(/\r\n/g, '\n');
    let frontmatter = '';
    if (normalizedMarkdown.startsWith('---\n')) {
      const frontmatterEndIndex = normalizedMarkdown.indexOf('\n---\n', 4);
      if (frontmatterEndIndex !== -1) {
        frontmatter = normalizedMarkdown.slice(4, frontmatterEndIndex);
      }
    }
    const declarations = parseDeclaredReferencesFromFrontmatter(frontmatter);

    const resolutionResults = await Promise.all(
      declarations.map(async (ref) => {
        const candidateUris = this.resolveWorkspaceReferenceUris(
          rootFolderUri,
          ref.file,
        );
        let uri = candidateUris[0] ?? null;

        for (const candidateUri of candidateUris) {
          try {
            await workspace.fs.stat(candidateUri);
            uri = candidateUri;
            break;
          } catch {
            // Try the next candidate.
          }
        }

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
   * Returns unique 1-based line numbers from frontmatter `references` that target `fileUri`.
   * References without a line imply line `1` (file-level context). Sorted ascending.
   */
  async getContextDecorationLinesForFile(fileUri: Uri): Promise<number[]> {
    const targetPaths = this.getReferenceTargetPaths(fileUri);

    const noteUris = await this.discoverNoteFileUrisThroughContext();
    const lines = new Set<number>();

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

      for (const ref of references) {
        if (!this.referenceDeclaresTarget(ref, rootFolderUri, targetPaths)) {
          continue;
        }

        const referenceLine =
          typeof ref.line === 'number' &&
          Number.isInteger(ref.line) &&
          ref.line >= 1
            ? ref.line
            : 1;
        lines.add(referenceLine);
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

      for (const ref of references) {
        if (!this.referenceDeclaresTarget(ref, rootFolderUri, targetPaths)) {
          continue;
        }

        const effectiveLine =
          typeof ref.line === 'number' &&
          Number.isInteger(ref.line) &&
          ref.line >= 1
            ? ref.line
            : 1;
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
    const targetPaths = this.getReferenceTargetPaths(fileUri);
    const noteUris = await this.discoverNoteFileUrisThroughContext();
    const notesByPath = new Map<
      string,
      { id: string; uri: Uri; title?: string }
    >();

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

      for (const ref of references) {
        if (!this.referenceDeclaresTarget(ref, rootFolderUri, targetPaths)) {
          continue;
        }

        const effectiveLine =
          typeof ref.line === 'number' &&
          Number.isInteger(ref.line) &&
          ref.line >= 1
            ? ref.line
            : 1;
        if (effectiveLine !== line) {
          continue;
        }

        const dedupeKey = toPosixPath(noteUri.fsPath);
        if (notesByPath.has(dedupeKey)) {
          continue;
        }

        notesByPath.set(dedupeKey, {
          id,
          uri: noteUri,
          ...(titleTrim ? { title: titleTrim } : {}),
        });
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

  async addReferenceForLocation(
    note: Note,
    targetFileUri: Uri,
    line?: number,
  ): Promise<'added' | 'duplicate'> {
    const candidateReference = this.buildDeclaredReference(targetFileUri, line);
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
    line?: number,
  ): DeclaredReference {
    const referencePath = this.getReferencePathForUri(fileUri);
    const normalizedLine =
      typeof line === 'number' && Number.isInteger(line) && line > 0
        ? line
        : undefined;

    return {
      file: referencePath,
      ...(normalizedLine ? { line: normalizedLine } : {}),
    };
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

  private areDeclaredReferencesEqual(
    left: DeclaredReference,
    right: DeclaredReference,
  ): boolean {
    const leftPath = normalizeReferencePath(left.file);
    const rightPath = normalizeReferencePath(right.file);
    if (!leftPath || !rightPath) {
      return false;
    }

    const leftLine =
      typeof left.line === 'number' &&
      Number.isInteger(left.line) &&
      left.line > 0
        ? left.line
        : undefined;
    const rightLine =
      typeof right.line === 'number' &&
      Number.isInteger(right.line) &&
      right.line > 0
        ? right.line
        : undefined;

    return leftPath === rightPath && leftLine === rightLine;
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
    const detailIndent = `${indent}  `;
    const trimmed = entryText.endsWith('\n')
      ? entryText.slice(0, -1)
      : entryText;
    let result = trimmed;
    for (const ref of additions) {
      result += `\n${indent}- file: ${ref.file}`;
      if (typeof ref.line === 'number' && Number.isFinite(ref.line)) {
        result += `\n${detailIndent}line: ${ref.line}`;
      }
      if (typeof ref.endLine === 'number' && Number.isFinite(ref.endLine)) {
        result += `\n${detailIndent}endLine: ${ref.endLine}`;
      }
      if (ref.symbol) {
        result += `\n${detailIndent}symbol: ${ref.symbol}`;
      }
    }
    return `${result}\n`;
  }

  private buildStructuredReferences(references: DeclaredReference[]): string {
    const lines = ['references:'];
    for (const ref of references) {
      lines.push(`  - file: ${ref.file}`);
      if (typeof ref.line === 'number' && Number.isFinite(ref.line)) {
        lines.push(`    line: ${ref.line}`);
      }
      if (typeof ref.endLine === 'number' && Number.isFinite(ref.endLine)) {
        lines.push(`    endLine: ${ref.endLine}`);
      }
      if (ref.symbol) {
        lines.push(`    symbol: ${ref.symbol}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

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
