/**
 * Workspace configuration for the extension.
 */

import { WorkspaceConfiguration } from 'vscode';

import {
  DEFAULT_ENABLE_SETTING,
  DEFAULT_NOTES_FOLDER,
} from './constants.config';

export class ExtensionConfig {
  /** Whether the extension is enabled. */
  enable: boolean;

  /** Selected workspace folder path. */
  workspaceSelection: string | undefined;

  /** Notes directory name. */
  notesFolder: string;

  /** Creates configuration from workspace settings. */
  constructor(readonly config: WorkspaceConfiguration) {
    this.enable = config.get<boolean>('enable', DEFAULT_ENABLE_SETTING);
    this.workspaceSelection = config.get<string>('workspaceSelection');
    this.notesFolder = config.get<string>(
      'notes.notesFolder',
      DEFAULT_NOTES_FOLDER,
    );
  }

  /** Refreshes cached settings from VS Code configuration. */
  update(config: WorkspaceConfiguration): void {
    this.enable = config.get<boolean>('enable', this.enable);
    this.workspaceSelection = config.get<string>('workspaceSelection');
    this.notesFolder = config.get<string>(
      'notes.notesFolder',
      this.notesFolder,
    );
  }
}
