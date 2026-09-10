/**
 * Inline editor hints for lines (or whole file) that have linked project notes via frontmatter `references`.
 */

import {
  type Command,
  type DecorationOptions,
  Disposable,
  type ExtensionContext,
  l10n,
  MarkdownString,
  Range,
  type TextEditor,
  type ThemableDecorationAttachmentRenderOptions,
  ThemeColor,
  type Uri,
  window,
  workspace,
} from 'vscode';

import { CommandIds, EXTENSION_ID, type ExtensionConfig } from '../configs';
import { debounce, getMostRecentType, getRecencyIndex } from '../helpers';
import type { FileContextEntry } from '../models';
import { NotesService } from '../services';

type ClickableAfterAttachment = ThemableDecorationAttachmentRenderOptions & {
  command?: Command;
};

/** One note as rendered inside a decoration hover. */
type HoverEntry = {
  label: string;
  summary?: string;
  refs?: number;
  uri: Uri;
  id: string;
  type?: string;
  /** Declared line, present only when the reference had to move to stay correct. */
  movedFromLine?: number;
};

function escapeMarkdownInline(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`');
}

export class ContextDecorationProvider {
  private readonly decorationType = window.createTextEditorDecorationType({
    isWholeLine: true,
  });

  private readonly debouncedRefresh = debounce(() => {
    void this.refreshVisibleEditors();
  }, 320);

  private readonly openContextCommandId =
    `${EXTENSION_ID}.${CommandIds.OpenContextForLine}`;

  constructor(
    private readonly notesService: NotesService,
    private readonly config: ExtensionConfig,
  ) {}

  /**
   * Subscribes to editor lifecycle; clears decorations on dispose.
   */
  register(context: ExtensionContext): void {
    context.subscriptions.push(this.decorationType);

    context.subscriptions.push(
      window.onDidChangeActiveTextEditor(() => {
        void this.refreshVisibleEditors();
      }),
    );

    context.subscriptions.push(
      workspace.onDidChangeTextDocument(() => {
        this.debouncedRefresh();
      }),
    );

    context.subscriptions.push(
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${EXTENSION_ID}.enable`)) {
          void this.refreshVisibleEditors();
        }
      }),
    );

    context.subscriptions.push(
      new Disposable(() => {
        for (const editor of window.visibleTextEditors) {
          editor.setDecorations(this.decorationType, []);
        }
      }),
    );

    void this.refreshVisibleEditors();
  }

  /**
   * Marks the lines of `editor` that carry context, resolving each reference first.
   *
   * @remarks
   * Markers sit on *resolved* lines, so a note whose code moved marks where the code is now,
   * and a reference that could not be located without guessing is not marked at all.
   */
  async updateDecorations(editor: TextEditor): Promise<void> {
    if (!this.config.enable) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    if (editor.document.uri.scheme !== 'file') {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const docVersion = editor.document.version;
    const fileUri = editor.document.uri;

    let entries: FileContextEntry[];
    try {
      entries = await this.notesService.getContextEntriesForFile(fileUri);
    } catch (error) {
      console.error('ContextDecorationProvider:', error);
      editor.setDecorations(this.decorationType, []);
      return;
    }

    if (editor.document.version !== docVersion) {
      return;
    }

    const lineCount = editor.document.lineCount;
    const byLine = new Map<number, FileContextEntry[]>();

    for (const entry of entries) {
      const line = entry.startLine;
      if (line === undefined || line < 1 || line > lineCount) {
        continue;
      }

      const bucket = byLine.get(line);
      if (bucket) {
        bucket.push(entry);
      } else {
        byLine.set(line, [entry]);
      }
    }

    // Contextual density throttling: limit decorations to nearest lines when many
    const MaxDecorations = 30;
    let validLines = [...byLine.keys()].sort((a, b) => a - b);
    if (validLines.length > MaxDecorations) {
      const current = editor.selection?.active.line ?? 0;
      validLines = validLines
        .map((l) => ({ l, d: Math.abs(l - (current + 1)) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MaxDecorations)
        .map((x) => x.l)
        .sort((a, b) => a - b);
    }

    const decorations: DecorationOptions[] = [];

    for (const line of validLines) {
      const lineEntries = byLine.get(line);
      if (!lineEntries?.length) {
        continue;
      }

      // Build richer preview for hover: include summary and reference counts (bounded)
      const maxItems = 5;
      const enrichedAll: HoverEntry[] = [];
      const seenNotes = new Set<string>();

      for (const entry of lineEntries) {
        const noteKey = entry.note.uri.toString();
        if (seenNotes.has(noteKey)) {
          continue;
        }
        seenNotes.add(noteKey);

        const label = entry.note.title?.trim()
          ? entry.note.title
          : entry.note.id;

        try {
          const note = await this.notesService.getNote(entry.note.uri);
          enrichedAll.push({
            label,
            summary: note?.summary?.trim(),
            refs: note?.references?.length,
            uri: entry.note.uri,
            id: entry.note.id,
            type: note?.type,
            movedFromLine: entry.movedFromLine,
          });
        } catch {
          enrichedAll.push({
            label,
            uri: entry.note.uri,
            id: entry.note.id,
            movedFromLine: entry.movedFromLine,
          });
        }
      }

      // Deterministic prioritization: recency, operational type preference, alphabetical
      const lastType = getMostRecentType();
      enrichedAll.sort((a, b) => {
        const ra = getRecencyIndex(a.uri);
        const rb = getRecencyIndex(b.uri);
        if (ra !== rb) {
          return ra - rb;
        }
        const ta = a.type === lastType ? 0 : 1;
        const tb = b.type === lastType ? 0 : 1;
        if (ta !== tb) {
          return ta - tb;
        }
        return a.label.localeCompare(b.label, undefined, {
          sensitivity: 'base',
        });
      });

      const shown = enrichedAll.slice(0, maxItems);

      const hoverMessage = this.buildContextHoverMarkdownFromNotes(
        shown,
        fileUri,
        line,
        enrichedAll.length,
      );

      const z = line - 1;

      const after: ClickableAfterAttachment = {
        contentText: '💡',
        margin: '0 0 0 1rem',
        color: new ThemeColor('editorCodeLens.foreground'),
      };

      decorations.push({
        range: new Range(z, 0, z, 0),
        hoverMessage,
        renderOptions: { after },
      });
    }

    editor.setDecorations(this.decorationType, decorations);
  }

  private buildContextHoverMarkdownFromNotes(
    notes: readonly HoverEntry[],
    fileUri: Uri,
    line: number,
    total: number,
  ): MarkdownString {
    const md = new MarkdownString(undefined, true);
    md.isTrusted = true;

    const headline =
      total === 1
        ? l10n.t('1 note references this line')
        : l10n.t('{0} notes reference this line', String(total));

    md.appendMarkdown(`💡 **${headline}**\n\n`);

    for (const n of notes) {
      md.appendMarkdown(`\n• **${escapeMarkdownInline(n.label)}**`);
      if (n.refs !== undefined) {
        md.appendMarkdown(` - ${l10n.t('{0} references', String(n.refs))}`);
      }
      if (n.movedFromLine !== undefined) {
        md.appendMarkdown(
          `  \n  $(arrow-right) _${l10n.t('moved from line {0}', String(n.movedFromLine))}_`,
        );
      }
      if (n.summary) {
        md.appendMarkdown(`  \n  _${escapeMarkdownInline(n.summary)}_`);
      }
      md.appendMarkdown('\n');
    }

    if (total > notes.length) {
      md.appendMarkdown(
        `\n_${l10n.t('{0} more...', String(total - notes.length))}_\n`,
      );
    }

    md.appendMarkdown(`\n\n---\n\n`);

    const openArgs = encodeURIComponent(
      JSON.stringify([fileUri.toJSON(), line]),
    );

    md.appendMarkdown(
      `🔍 [Open context for this line](command:${this.openContextCommandId}?${openArgs})`,
    );

    return md;
  }

  private async refreshVisibleEditors(): Promise<void> {
    await Promise.all(
      window.visibleTextEditors.map((ed) => this.updateDecorations(ed)),
    );
  }
}
