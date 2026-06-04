import {
  Event,
  EventEmitter,
  FileSystemWatcher,
  l10n,
  RelativePattern,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  window,
  workspace,
} from 'vscode';
import type {
  Note,
  NotesTreeNode,
  NoteTreeNode,
  RelatedNoteTreeNode,
  RelationGroupTreeNode,
} from '../models/note.model';

import { NotesService } from '../services/notes.service';

/**
 * Supplies the "Project notes" explorer view with one leaf per Markdown note.
 *
 * Lists `.md` notes recursively, and refreshes when notes change on disk.
 */
export class NotesTreeProvider implements TreeDataProvider<NotesTreeNode> {
  private readonly _onDidChangeTreeData = new EventEmitter<void>();
  readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

  private watcher: FileSystemWatcher | undefined;

  constructor(private readonly notesService: NotesService) {}

  /**
   * Subscribes to filesystem changes under the notes directory so the tree stays in sync.
   */
  startWatching(): void {
    void (async () => {
      try {
        await this.attachWatcher();
      } catch (error) {
        console.error('NotesTreeProvider attach watcher:', error);
        window.showErrorMessage(
          l10n.t(
            'Could not watch the notes folder. See the developer console for details.',
          ),
        );
      }
    })();
  }

  /**
   * Triggers a refresh of the entire tree view.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Releases the filesystem watcher.
   */
  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Attaches a filesystem watcher to the notes directory so the tree refreshes when `.md` files change.
   * @private
   */
  private async attachWatcher(): Promise<void> {
    this.watcher?.dispose();
    this.watcher = undefined;

    const dir = this.notesService.getNotesDirectoryUri();
    if (!dir) {
      return;
    }

    this.watcher = workspace.createFileSystemWatcher(
      new RelativePattern(dir, '**/*.md'),
    );
    const fire = () => this._onDidChangeTreeData.fire();
    this.watcher.onDidChange(fire);
    this.watcher.onDidCreate(fire);
    this.watcher.onDidDelete(fire);
  }

  getTreeItem(element: NotesTreeNode): TreeItem {
    if (element.type === 'note') {
      const item = new TreeItem(
        this.getNodeDisplayLabel(element.title, element.id),
        TreeItemCollapsibleState.Collapsed,
      );
      item.resourceUri = element.uri;
      item.iconPath = new ThemeIcon('file');
      return item;
    }

    if (element.type === 'group') {
      const item = new TreeItem(
        element.relation === 'links' ? l10n.t('Links') : l10n.t('Backlinks'),
        TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new ThemeIcon(
        element.relation === 'links' ? 'arrow-right' : 'arrow-left',
      );
      return item;
    }

    const item = new TreeItem(
      this.getNodeDisplayLabel(element.title, element.id),
      TreeItemCollapsibleState.None,
    );
    item.description = workspace.asRelativePath(element.uri, false);
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [element.uri],
    };
    return item;
  }

  async getChildren(element?: NotesTreeNode): Promise<NotesTreeNode[]> {
    try {
      if (!element) {
        const notes = await this.notesService.getAllNotes();
        return this.toSortedRootNodes(notes);
      }

      if (element.type === 'note') {
        return await this.getRelationGroups(element);
      }

      if (element.type === 'group') {
        return await this.getRelatedNotes(element);
      }

      return [];
    } catch (error) {
      console.error('NotesTreeProvider getChildren:', error);
      window.showErrorMessage(
        l10n.t(
          'Could not load project notes in the explorer. See the developer console for details.',
        ),
      );
      return [];
    }
  }

  getParent(): undefined {
    return undefined;
  }

  /**
   * Converts a note list into root tree nodes with sorting and title resolution.
   * @private
   */
  private toSortedRootNodes(notes: Note[]): NoteTreeNode[] {
    const nodes = notes.map((note) => ({
      type: 'note' as const,
      id: note.id,
      uri: Uri.file(note.filePath),
      title: note.title,
    }));

    return nodes.sort((a, b) => {
      const aLabel = this.getNodeDisplayLabel(a.title, a.id).toLowerCase();
      const bLabel = this.getNodeDisplayLabel(b.title, b.id).toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  }

  /**
   * Builds a list of relation groups (links and backlinks) for a note.
   * Returns empty list if the note has no outgoing links or incoming backlinks.
   * @private
   */
  private async getRelationGroups(
    noteNode: NoteTreeNode,
  ): Promise<RelationGroupTreeNode[]> {
    const groups: RelationGroupTreeNode[] = [];

    const links = await this.notesService.getResolvedLinks(noteNode.id);
    if (links.valid.length > 0 || links.broken.length > 0) {
      groups.push({
        type: 'group',
        relation: 'links',
        parentId: noteNode.id,
        parentUri: noteNode.uri,
      });
    }

    const backlinks = await this.notesService.getBacklinks(noteNode.id);
    if (backlinks.sources.length > 0) {
      groups.push({
        type: 'group',
        relation: 'backlinks',
        parentId: noteNode.id,
        parentUri: noteNode.uri,
      });
    }

    return groups;
  }

  /**
   * Resolves child nodes for a relation group (outgoing links or incoming backlinks).
   * Returns a sorted list of related note leaves.
   * @private
   */
  private async getRelatedNotes(
    groupNode: RelationGroupTreeNode,
  ): Promise<RelatedNoteTreeNode[]> {
    if (groupNode.relation === 'links') {
      const links = await this.notesService.getResolvedLinks(
        groupNode.parentId,
      );
      const related: RelatedNoteTreeNode[] = await Promise.all(
        links.valid.map(async (link) => {
          const note = await this.notesService.getNote(link.uri);
          return {
            type: 'related',
            id: link.id,
            uri: link.uri,
            title: note?.title,
            relation: 'links',
          };
        }),
      );
      return this.sortRelated(related);
    }

    const backlinks = await this.notesService.getBacklinks(groupNode.parentId);
    const related: RelatedNoteTreeNode[] = backlinks.sources.map((source) => ({
      type: 'related',
      id: source.id,
      uri: source.uri,
      title: source.title,
      relation: 'backlinks',
    }));
    return this.sortRelated(related);
  }

  /**
   * Sorts a list of related note nodes alphabetically by title or ID (case-insensitive).
   * @private
   */
  private sortRelated(nodes: RelatedNoteTreeNode[]): RelatedNoteTreeNode[] {
    return [...nodes].sort((nodeA, nodeB) => {
      const labelA = this.getNodeDisplayLabel(
        nodeA.title,
        nodeA.id,
      ).toLowerCase();
      const labelB = this.getNodeDisplayLabel(
        nodeB.title,
        nodeB.id,
      ).toLowerCase();
      return labelA.localeCompare(labelB);
    });
  }

  /**
   * Chooses the user-facing label for tree nodes, preferring non-empty titles.
   * @private
   */
  private getNodeDisplayLabel(title: string | undefined, id: string): string {
    return title?.trim() ? title : id;
  }
}
