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
import { debounce } from '../helpers/debounce.helper';
import { NotesService } from '../services/notes.service';

type ClickableAfterAttachment = ThemableDecorationAttachmentRenderOptions & {
  command?: Command;
};

function escapeMarkdownInline(text: string): string {
  return text
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
   * Computes reference lines for the editor file and applies whole-line trailing 💡 markers with hover and click.
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

    let lines: number[];
    try {
      lines = await this.notesService.getContextDecorationLinesForFile(fileUri);
    } catch (error) {
      console.error('ContextDecorationProvider:', error);
      editor.setDecorations(this.decorationType, []);
      return;
    }

    if (editor.document.version !== docVersion) {
      return;
    }

    const lineCount = editor.document.lineCount;
    const validLines = lines.filter((line) => line >= 1 && line <= lineCount);

    let byLine: Map<number, { id: string; uri: Uri; title?: string }[]>;
    try {
      byLine = await this.notesService.getNotesForFileGroupedByReferenceLine(
        fileUri,
        validLines,
      );
    } catch (error) {
      console.error('ContextDecorationProvider:', error);
      editor.setDecorations(this.decorationType, []);
      return;
    }

    if (editor.document.version !== docVersion) {
      return;
    }

    const decorations: DecorationOptions[] = [];

    for (const line of validLines) {
      const notes = byLine.get(line);
      if (!notes?.length) {
        continue;
      }

      const labels = notes.map((n) => (n.title?.trim() ? n.title : n.id));
      const hoverMessage = this.buildContextHoverMarkdown(
        labels,
        fileUri,
        line,
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

  private buildContextHoverMarkdown(
    labels: readonly string[],
    fileUri: Uri,
    line: number,
  ): MarkdownString {
    const sorted = [...labels].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );

    const maxItems = 5;
    const shown = sorted.slice(0, maxItems);
    const more = sorted.length - shown.length;
    const total = sorted.length;

    const md = new MarkdownString(undefined, true);
    md.isTrusted = true;

    md.appendMarkdown(
      `💡 **${l10n.t('{0} {1} reference this line', total, total === 1 ? 'note' : 'notes')}**\n\n`,
    );

    for (const name of shown) {
      md.appendMarkdown(`\n• ${escapeMarkdownInline(name)}\n`);
    }

    if (more > 0) {
      md.appendMarkdown(`\n_${l10n.t('{0} more...', more)}_\n`);
    }

    md.appendMarkdown(`\n\n---\n\n`);

    const args = encodeURIComponent(JSON.stringify([fileUri.toJSON(), line]));

    md.appendMarkdown(
      `🔎 [Open context for this line](command:${this.openContextCommandId}?${args})`,
    );

    return md;
  }

  private async refreshVisibleEditors(): Promise<void> {
    await Promise.all(
      window.visibleTextEditors.map((ed) => this.updateDecorations(ed)),
    );
  }
}
