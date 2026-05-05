/**
 * Resolves a directory URI for file operations.
 */

import { FileType, Uri, window, workspace } from 'vscode';

import { listWorkspaceFolders } from './workspace-root.helper';

/**
 * Resolves the target folder URI from the current command context.
 */
export const resolveFolderResource = async (
  inputUri?: Uri,
): Promise<Uri | undefined> => {
  if (inputUri) {
    return asDirectoryUri(inputUri);
  }

  const activeFileUri = window.activeTextEditor?.document.uri;
  if (activeFileUri) {
    return asDirectoryUri(activeFileUri);
  }

  const availableWorkspaceFolders = listWorkspaceFolders();

  if (!availableWorkspaceFolders.length) {
    return undefined;
  }

  if (availableWorkspaceFolders.length === 1) {
    return availableWorkspaceFolders.at(0)?.uri;
  }

  const selectedFolder = await window.showWorkspaceFolderPick({
    placeHolder: 'Select a workspace folder to use',
  });

  return selectedFolder?.uri;
};

/**
 * Returns a directory URI for the given resource.
 */
export const asDirectoryUri = async (uri: Uri): Promise<Uri> => {
  try {
    const resourceStat = await workspace.fs.stat(uri);

    if ((resourceStat.type & FileType.Directory) !== 0) {
      return uri;
    }

    return Uri.joinPath(uri, '..');
  } catch {
    return uri;
  }
};
