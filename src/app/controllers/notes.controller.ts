/**
 * UI command handlers for project notes operations.
 *
 * Implements VS Code command handlers for create, open, insert link, and navigation flows.
 * Delegates note I/O to NotesService; manages user interaction flows via QuickPick.
 *
 * Assumes NotesService is configured for the active workspace folder and uses the standard text editor flow.
 */

import {
  l10n,
  Position,
  type QuickPickItem,
  Range,
  Selection,
  type TextEditor,
  Uri,
  window,
  workspace,
} from 'vscode';

import { EXTENSION_DISPLAY_NAME, ExtensionConfig } from '../configs';
import { showNoWorkspaceFolderError } from '../helpers/error-message.helper';
import { openDocument } from '../helpers/open-document.helper';
import type { Note } from '../models/note.model';
import { NotesService } from '../services/notes.service';

/**
 * Handles VS Code UI flows for project notes (commands: create, open, insert link).
 *
 * Assumes {@link NotesService} is configured for the active workspace folder and opens notes with the workspace API.
 */
export class NotesController {
  /**
   * Initializes the controller with the extension configuration and notes service.
   */
  constructor(
    readonly config: ExtensionConfig,
    private readonly notesService: NotesService,
  ) {}

  /**
   * Prompts for title and optional tags, creates the note file, and opens it in an editor with the cursor after frontmatter.
   */
  public async createProjectNote(): Promise<void> {
    try {
      const title = await window.showInputBox({
        prompt: l10n.t('Enter a title for the new note'),
        placeHolder: l10n.t('Note title'),
        validateInput: (value) => {
          return value && value.trim().length > 0
            ? null
            : l10n.t('Title cannot be empty');
        },
      });

      if (!title) {
        return;
      }

      const tagsInput = await window.showInputBox({
        prompt: l10n.t('Enter tags (comma separated)'),
        placeHolder: l10n.t('tag1, tag2, tag3'),
      });

      const tags = tagsInput
        ? tagsInput
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0)
        : [];

      const note = await this.notesService.createNote(title, '', tags);

      if (note) {
        await this.openNoteFile(note.filePath);

        const editor = window.activeTextEditor;
        if (editor) {
          const text = editor.document.getText();
          const frontmatterEnd = text.indexOf('---\n\n');

          if (frontmatterEnd > -1) {
            const position = editor.document.positionAt(frontmatterEnd + 5);
            editor.selection = new Selection(position, position);
            editor.revealRange(new Range(position, position));
          }
        }

        window.showInformationMessage(l10n.t('Note "{0}" created', title));
      } else {
        window.showErrorMessage(l10n.t('Failed to create note'));
      }
    } catch (error) {
      console.error('Error creating note:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while creating the note'),
      );
    }
  }

  /**
   * Lists existing notes in a QuickPick and opens the selection.
   */
  public async openProjectNote(): Promise<void> {
    try {
      const notes = await this.notesService.getAllNotes();

      if (await this.handleEmptyNotesAndMaybeCreate(notes)) {
        return;
      }

      const items = this.toNoteQuickPickItems(notes);

      const selected = await window.showQuickPick(items, {
        placeHolder: l10n.t('Select a note to open'),
      });

      if (selected) {
        await this.openNoteFile(selected.note.filePath);
      }
    } catch (error) {
      console.error('Error opening note:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening the note'),
      );
    }
  }

  /**
   * Inserts a Markdown link to a chosen note at the current cursor in the active editor.
   */
  public async insertNoteLink(): Promise<void> {
    try {
      const activeEditor = this.getActiveEditorOrWarn();
      if (!activeEditor) {
        return;
      }

      const notes = await this.notesService.getAllNotes();

      if (await this.handleEmptyNotesAndMaybeCreate(notes)) {
        return;
      }

      const items = this.toNoteQuickPickItems(notes);

      const selected = await window.showQuickPick(items, {
        placeHolder: l10n.t('Select a note to link'),
      });

      if (!selected) {
        return;
      }

      const currentFilePath = activeEditor.document.uri.fsPath;
      const currentPosition = activeEditor.selection.active.line;

      const noteLink = this.notesService.createNoteLink(
        selected.note,
        currentFilePath,
        currentPosition,
      );

      const markdownLink = this.notesService.formatNoteLinkMarkdown(noteLink);

      activeEditor.edit((editBuilder) => {
        editBuilder.insert(activeEditor.selection.active, markdownLink);
      });
    } catch (error) {
      console.error('Error inserting note link:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while inserting the note link'),
      );
    }
  }

  /**
   * Prompts for a note ID and opens the matching note file (using the identity index built from frontmatter).
   *
   * Constraints:
   * - If duplicate IDs exist, this command refuses to pick a winner and shows an error.
   */
  public async goToNoteById(): Promise<void> {
    try {
      const validation = await this.notesService.validateNotesIdentity();

      const duplicateErrors = validation.errors.filter(
        (e) => e.type === 'duplicated-id',
      );
      if (duplicateErrors.length > 0) {
        window.showErrorMessage(
          l10n.t(
            'Duplicate note IDs detected ({0}). Fix duplicates to enable ID navigation',
            String(duplicateErrors.length),
          ),
        );
        return;
      }

      const ids = Array.from(validation.index.keys()).sort((a, b) =>
        a.localeCompare(b),
      );
      if (ids.length === 0) {
        window.showWarningMessage(l10n.t('No notes with valid IDs found'));
        return;
      }

      const selectedId = await window.showQuickPick(ids, {
        placeHolder: l10n.t('Select a note ID'),
      });
      if (!selectedId) {
        return;
      }

      const note = await this.notesService.getNoteById(selectedId);
      if (!note) {
        window.showErrorMessage(
          l10n.t('Unable to find note for ID: {0}', selectedId),
        );
        return;
      }

      await this.openNoteFile(note.filePath);
    } catch (error) {
      console.error('Error going to note by id:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening the note'),
      );
    }
  }

  /**
   * Resolves frontmatter links for the current note and opens a selected linked note.
   *
   * Constraints:
   * - Current note ID is read from current note frontmatter (`id`).
   * - Broken links are shown in the list but are not opened.
   */
  public async openLinkedNote(): Promise<void> {
    try {
      const activeEditor = this.getActiveEditorOrWarn();
      if (!activeEditor) {
        return;
      }

      const currentNoteId =
        await this.getCurrentActiveNoteIdOrWarn(activeEditor);
      if (!currentNoteId) {
        return;
      }

      const resolved = await this.notesService.getResolvedLinks(currentNoteId);
      const hasValid = resolved.valid.length > 0;
      const hasBroken = resolved.broken.length > 0;

      if (!hasValid && !hasBroken) {
        window.showInformationMessage(
          l10n.t('Current note has no declared links'),
        );
        return;
      }

      if (!hasValid && hasBroken) {
        window.showWarningMessage(l10n.t('All declared links are broken'));
      }

      const items: (QuickPickItem & { uri?: Uri; isBroken: boolean })[] = [
        ...resolved.valid.map((link) => ({
          label: `$(check) ${link.id}`,
          description: l10n.t('Linked note'),
          uri: link.uri,
          isBroken: false,
        })),
        ...resolved.broken.map((id) => ({
          label: `$(warning) ${id}`,
          description: l10n.t('Broken link'),
          detail: l10n.t('No note found for this ID'),
          isBroken: true,
        })),
      ];

      const selected = await window.showQuickPick(items, {
        placeHolder: l10n.t('Select a linked note'),
      });
      if (!selected) {
        return;
      }

      if (selected.isBroken || !selected.uri) {
        window.showWarningMessage(l10n.t('Cannot open broken link'));
        return;
      }

      await openDocument(selected.uri);
    } catch (error) {
      console.error('Error opening linked note:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening linked note'),
      );
    }
  }

  /**
   * Resolves frontmatter code references for the active note and opens the chosen file (optional line).
   *
   * Constraints:
   * - Reads `references` only from YAML frontmatter.
   * - Broken targets are listed but cannot be opened.
   */
  public async openReference(): Promise<void> {
    try {
      const activeEditor = this.getActiveEditorOrWarn();
      if (!activeEditor) {
        return;
      }

      const currentNoteId =
        await this.getCurrentActiveNoteIdOrWarn(activeEditor);
      if (!currentNoteId) {
        return;
      }

      const resolved =
        await this.notesService.getResolvedReferences(currentNoteId);
      const hasValid = resolved.valid.length > 0;
      const hasBroken = resolved.broken.length > 0;

      if (!hasValid && !hasBroken) {
        window.showInformationMessage(
          l10n.t('Current note has no declared references'),
        );
        return;
      }

      if (!hasValid && hasBroken) {
        window.showWarningMessage(l10n.t('All declared references are broken'));
      }

      type RefPick = QuickPickItem & {
        uri?: Uri;
        targetLine?: number;
        isBroken: boolean;
      };

      const items: RefPick[] = [
        ...resolved.valid.map((ref): RefPick => {
          const rel = workspace.asRelativePath(ref.uri, false);
          const lineLabel =
            ref.line !== undefined
              ? l10n.t('Line {0}', String(ref.line))
              : l10n.t('Top of file');
          return {
            label: `$(check) ${rel}`,
            description: lineLabel,
            uri: ref.uri,
            targetLine: ref.line,
            isBroken: false,
          };
        }),
        ...resolved.broken.map(
          (b): RefPick => ({
            label: `$(warning) ${b.file}`,
            description: l10n.t('Broken reference'),
            detail: b.reason,
            isBroken: true,
          }),
        ),
      ];

      const selected = await window.showQuickPick(items, {
        placeHolder: l10n.t('Select a code reference'),
      });
      if (!selected) {
        return;
      }

      if (selected.isBroken || !selected.uri) {
        window.showWarningMessage(l10n.t('Cannot open broken reference'));
        return;
      }

      const doc = await workspace.openTextDocument(selected.uri);
      let reveal: Selection | undefined;
      const ln = selected.targetLine;
      if (ln !== undefined && ln >= 1) {
        const zero = ln - 1;
        if (zero < doc.lineCount) {
          reveal = new Selection(new Position(zero, 0), new Position(zero, 0));
        }
      }

      await openDocument(doc, reveal ? { selection: reveal } : undefined);
    } catch (error) {
      console.error('Error opening reference:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening reference'),
      );
    }
  }

  /**
   * Opens a note that links to the active note (reverse links from frontmatter `links`).
   */
  public async openBacklinks(): Promise<void> {
    try {
      const activeEditor = this.getActiveEditorOrWarn();
      if (!activeEditor) {
        return;
      }

      const currentNoteId =
        await this.getCurrentActiveNoteIdOrWarn(activeEditor);
      if (!currentNoteId) {
        return;
      }

      const backlinks = await this.notesService.getBacklinks(currentNoteId);
      if (backlinks.sources.length === 0) {
        window.showInformationMessage(l10n.t('No backlinks found'));
        return;
      }

      const sorted = [...backlinks.sources].sort((a, b) => {
        const aLabel = (a.title ?? a.id).toLowerCase();
        const bLabel = (b.title ?? b.id).toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      const items = sorted.map((source) => ({
        label: source.title?.trim() ? source.title : source.id,
        description: workspace.asRelativePath(source.uri, false),
        uri: source.uri,
      }));

      const selected = await window.showQuickPick(items, {
        placeHolder: l10n.t('Backlinks'),
      });
      if (!selected) {
        return;
      }

      await openDocument(selected.uri);
    } catch (error) {
      console.error('Error opening backlinks:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening linked note'),
      );
    }
  }

  /**
   * Shows outgoing links + incoming backlinks in one unified list and opens the selected related note.
   *
   * Rules:
   * - Related notes are built from existing service methods only.
   * - If the same note appears as outgoing and incoming, outgoing takes priority.
   */
  public async openRelatedNotes(): Promise<void> {
    try {
      const activeEditor = this.getActiveEditorOrWarn();
      if (!activeEditor) {
        return;
      }

      const currentNoteId =
        await this.getCurrentActiveNoteIdOrWarn(activeEditor);
      if (!currentNoteId) {
        return;
      }

      const links = await this.notesService.getResolvedLinks(currentNoteId);
      const backlinks = await this.notesService.getBacklinks(currentNoteId);

      const outgoing = await Promise.all(
        links.valid.map(async (link) => {
          const note = await this.notesService.getNote(link.uri);
          return {
            id: link.id,
            uri: link.uri,
            title: note?.title,
            type: 'outgoing' as const,
          };
        }),
      );

      const incoming = backlinks.sources.map((source) => ({
        id: source.id,
        uri: source.uri,
        title: source.title,
        type: 'incoming' as const,
      }));

      const dedup = new Map<
        string,
        { id: string; uri: Uri; title?: string; type: 'outgoing' | 'incoming' }
      >();

      for (const note of outgoing) {
        dedup.set(note.id, note);
      }

      for (const note of incoming) {
        if (!dedup.has(note.id)) {
          dedup.set(note.id, note);
        }
      }

      const related = Array.from(dedup.values()).sort((a, b) => {
        const aLabel = (a.title ?? a.id).toLowerCase();
        const bLabel = (b.title ?? b.id).toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      if (related.length === 0) {
        window.showInformationMessage(l10n.t('No related notes found'));
        return;
      }

      const items = related.map((note) => ({
        label: note.title?.trim() ? note.title : note.id,
        description: workspace.asRelativePath(note.uri, false),
        detail:
          note.type === 'outgoing' ? l10n.t('Outgoing') : l10n.t('Incoming'),
        uri: note.uri,
      }));

      const selected = await window.showQuickPick(items, {
        placeHolder: l10n.t('Related notes'),
      });
      if (!selected) {
        return;
      }

      await openDocument(selected.uri);
    } catch (error) {
      console.error('Error opening related notes:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening linked note'),
      );
    }
  }

  /**
   * Lists notes that reference the active editor file (frontmatter `references`) and opens the selection.
   */
  public async openContextForFile(): Promise<void> {
    try {
      const activeEditor = this.getActiveEditorOrWarn();
      if (!activeEditor) {
        return;
      }

      if (!workspace.workspaceFolders?.length) {
        showNoWorkspaceFolderError(EXTENSION_DISPLAY_NAME);
        return;
      }

      const fileUri = activeEditor.document.uri;
      const result = await this.notesService.getNotesByFileReference(fileUri);

      if (result.notes.length === 0) {
        window.showInformationMessage(l10n.t('No context found for this file'));
        return;
      }

      const sorted = [...result.notes].sort((a, b) => {
        const aLabel = (a.title ?? a.id).toLowerCase();
        const bLabel = (b.title ?? b.id).toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      const items = sorted.map((note) => ({
        label: note.title?.trim() ? note.title : note.id,
        description: workspace.asRelativePath(note.uri, false),
        uri: note.uri,
      }));

      const selected = await window.showQuickPick(items, {
        placeHolder: l10n.t('Context for this file'),
      });
      if (!selected) {
        return;
      }

      await openDocument(selected.uri);
    } catch (error) {
      console.error('Error opening context for file:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening context for this file'),
      );
    }
  }

  /**
   * Opens notes that reference the given file at a 1-based line (QuickPick); falls back to any file-level references.
   */
  public async openContextForLine(
    uriArg?: unknown,
    line?: number,
  ): Promise<void> {
    try {
      const fileUri = this.parseCommandUri(uriArg);
      if (
        !fileUri ||
        typeof line !== 'number' ||
        !Number.isInteger(line) ||
        line < 1
      ) {
        return;
      }

      if (!workspace.workspaceFolders?.length) {
        showNoWorkspaceFolderError(EXTENSION_DISPLAY_NAME);
        return;
      }

      const atLine = await this.notesService.getNotesByFileReferenceAtLine(
        fileUri,
        line,
      );
      let notes = atLine.notes;
      const usedLineContext = notes.length > 0;
      if (!usedLineContext) {
        notes = (await this.notesService.getNotesByFileReference(fileUri))
          .notes;
      }

      if (notes.length === 0) {
        window.showInformationMessage(l10n.t('No context found for this file'));
        return;
      }

      const sorted = [...notes].sort((a, b) => {
        const aLabel = (a.title ?? a.id).toLowerCase();
        const bLabel = (b.title ?? b.id).toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      const items = sorted.map((note) => ({
        label: note.title?.trim() ? note.title : note.id,
        description: workspace.asRelativePath(note.uri, false),
        uri: note.uri,
      }));

      const placeHolder = usedLineContext
        ? l10n.t('Context for line {0}', String(line))
        : l10n.t('Context for this file');

      const selected = await window.showQuickPick(items, {
        placeHolder,
      });
      if (!selected) {
        return;
      }

      await openDocument(selected.uri);
    } catch (error) {
      console.error('Error opening context for line:', error);
      window.showErrorMessage(
        l10n.t('An error occurred while opening context for this line'),
      );
    }
  }

  /**
   * Formats a date for user-facing UI (locale-aware, includes time).
   * @private
   */
  private formatDate(date: Date): string {
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Opens a note file by path in the default editor view.
   * @private
   */
  private async openNoteFile(filePath: string): Promise<void> {
    await openDocument(filePath);
  }

  /**
   * Restores a workspace file URI from VS Code command arguments (including serialized JSON).
   * @private
   */
  private parseCommandUri(value: unknown): Uri | undefined {
    if (value instanceof Uri) {
      return value;
    }
    if (typeof value === 'string' && value.length > 0) {
      return Uri.file(value);
    }
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o.fsPath === 'string' && o.fsPath.length > 0) {
        return Uri.file(o.fsPath);
      }
      if (typeof o.scheme === 'string' && typeof o.path === 'string') {
        try {
          return Uri.from({
            scheme: String(o.scheme),
            authority: typeof o.authority === 'string' ? o.authority : '',
            path: String(o.path),
            query: typeof o.query === 'string' ? o.query : '',
            fragment: typeof o.fragment === 'string' ? o.fragment : '',
          });
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  /**
   * Returns the active editor, showing the standard warning when there is none.
   * @private
   */
  private getActiveEditorOrWarn(): TextEditor | undefined {
    const activeEditor = window.activeTextEditor;
    if (!activeEditor) {
      window.showWarningMessage(l10n.t('No active editor available!'));
      return undefined;
    }
    return activeEditor;
  }

  /**
   * Resolves and validates the current note ID from the active editor document.
   * Returns empty string when missing and shows the existing warning.
   * @private
   */
  private async getCurrentActiveNoteIdOrWarn(
    activeEditor: TextEditor,
  ): Promise<string> {
    const currentNote = await this.notesService.getNote(
      activeEditor.document.uri,
    );
    const currentNoteId = currentNote?.id?.trim() ?? '';
    if (!currentNoteId) {
      window.showWarningMessage(l10n.t('Current note does not define an ID'));
    }
    return currentNoteId;
  }

  /**
   * If notes list is empty, prompts the user to create a new note.
   * Returns `true` if the list was empty (user was prompted), `false` otherwise.
   * @private
   */
  private async handleEmptyNotesAndMaybeCreate(
    notes: Note[],
  ): Promise<boolean> {
    if (notes.length > 0) {
      return false;
    }

    const yes = l10n.t('Yes');
    const no = l10n.t('No');
    const createNew = await window.showInformationMessage(
      l10n.t('No notes found. Create a new one?'),
      yes,
      no,
    );

    if (createNew === yes) {
      await this.createProjectNote();
    }

    return true;
  }

  /**
   * Converts a list of notes into QuickPick items with formatted labels, descriptions, and tag details.
   * @private
   */
  private toNoteQuickPickItems(notes: Note[]) {
    return notes.map((note) => ({
      label: note.title,
      description: l10n.t('Last updated: {0}', this.formatDate(note.updatedAt)),
      detail: note.tags?.length
        ? l10n.t('Tags: {0}', note.tags.join(', '))
        : undefined,
      note,
    }));
  }
}
