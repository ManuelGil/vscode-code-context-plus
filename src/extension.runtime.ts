import {
  commands,
  ExtensionContext,
  env,
  l10n,
  MessageItem,
  Uri,
  WorkspaceFolder,
  window,
  workspace,
} from 'vscode';
import { VSCodeMarketplaceClient } from 'vscode-marketplace-client';

import {
  EXTENSION_DISPLAY_NAME,
  EXTENSION_ID,
  EXTENSION_NAME,
  ExtensionConfig,
  REPOSITORY_URL,
  USER_PUBLISHER,
} from './app/configs';
import { CommandIds } from './app/configs/commands.config.js';
import { ContextKeys } from './app/configs/context.config.js';
import { NotesController } from './app/controllers';
import {
  listWorkspaceFolders,
  showNoWorkspaceFolderError,
} from './app/helpers';
import { ContextDecorationProvider, NotesTreeProvider } from './app/providers';
import { NotesService } from './app/services';

export class ExtensionRuntime {
  /**
   * Avoids repeated disabled-state notifications across command invocations.
   */
  private hasDisabledWarningBeenShown = false;

  /**
   * Current workspace-scoped extension configuration.
   */
  private config!: ExtensionConfig;

  private notesService: NotesService | undefined;
  private notesController: NotesController | undefined;

  constructor(public readonly context: ExtensionContext) {}

  async initialize(): Promise<boolean> {
    const workspaceFolder = await this.selectWorkspaceFolder();

    if (!workspaceFolder) {
      return false;
    }

    this.initializeConfiguration(workspaceFolder);

    if (!this.isExtensionEnabled()) {
      return false;
    }

    this.startVersionChecks();

    return true;
  }

  async start(): Promise<void> {
    this.registerWorkspaceCommands();
    this.registerNoteCommands();
  }

  /**
   * Runs non-blocking version checks after startup.
   */
  private startVersionChecks(): void {
    void this.handleLocalVersionNotifications();
    void this.checkMarketplaceVersion();
  }

  /**
   * Returns the extension version declared in package metadata.
   */
  private getCurrentVersion(): string {
    return this.context.extension.packageJSON?.version ?? '0.0.0';
  }

  /**
   * Handles first-run and local update notifications.
   */
  private async handleLocalVersionNotifications(): Promise<void> {
    const previousVersion = this.context.globalState.get<string>(
      ContextKeys.Version,
    );

    const currentVersion = this.getCurrentVersion();

    if (!previousVersion) {
      const welcomeMessage = l10n.t(
        'Welcome to {0} version {1}! The extension is now active',
        EXTENSION_DISPLAY_NAME,
        currentVersion,
      );

      window.showInformationMessage(welcomeMessage);

      await this.context.globalState.update(
        ContextKeys.Version,
        currentVersion,
      );

      return;
    }

    if (previousVersion !== currentVersion) {
      const actionReleaseNotes: MessageItem = {
        title: l10n.t('Release Notes'),
      };
      const actionDismiss: MessageItem = { title: l10n.t('Dismiss') };
      const availableActions = [actionReleaseNotes, actionDismiss];

      const updateMessage = l10n.t(
        "The {0} extension has been updated. Check out what's new in version {1}",
        EXTENSION_DISPLAY_NAME,
        currentVersion,
      );

      const userSelection = await window.showInformationMessage(
        updateMessage,
        ...availableActions,
      );

      if (userSelection?.title === actionReleaseNotes.title) {
        const changelogUrl = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`;
        env.openExternal(Uri.parse(changelogUrl));
      }

      await this.context.globalState.update(
        ContextKeys.Version,
        currentVersion,
      );
    }
  }

  /**
   * Checks Marketplace for a newer published extension version.
   */
  private async checkMarketplaceVersion(): Promise<void> {
    const currentVersion = this.getCurrentVersion();

    try {
      const latestVersion = await VSCodeMarketplaceClient.getLatestVersion(
        USER_PUBLISHER,
        EXTENSION_NAME,
      );

      if (latestVersion === currentVersion) {
        return;
      }

      const actionUpdateNow: MessageItem = { title: l10n.t('Update Now') };
      const actionDismiss: MessageItem = { title: l10n.t('Dismiss') };
      const availableActions = [actionUpdateNow, actionDismiss];

      const updateMessage = l10n.t(
        'A new version of {0} is available. Update to version {1} now',
        EXTENSION_DISPLAY_NAME,
        latestVersion,
      );

      const userSelection = await window.showInformationMessage(
        updateMessage,
        ...availableActions,
      );

      if (userSelection?.title === actionUpdateNow.title) {
        await commands.executeCommand(
          'workbench.extensions.action.install.anotherVersion',
          `${USER_PUBLISHER}.${EXTENSION_NAME}`,
        );
      }
    } catch (error) {
      console.error('Error retrieving extension version:', error);
    }
  }

  /**
   * Selects the workspace folder that scopes configuration and generation.
   */
  private async selectWorkspaceFolder(): Promise<WorkspaceFolder | undefined> {
    const availableWorkspaceFolders = listWorkspaceFolders();

    if (availableWorkspaceFolders.length === 0) {
      showNoWorkspaceFolderError(EXTENSION_DISPLAY_NAME);

      return undefined;
    }

    const previousFolderUriString = this.context.globalState.get<string>(
      ContextKeys.SelectedWorkspaceFolder,
    );
    let previousFolder: WorkspaceFolder | undefined;

    if (previousFolderUriString) {
      previousFolder = availableWorkspaceFolders.find(
        (folder) => folder.uri.toString() === previousFolderUriString,
      );
    }

    if (availableWorkspaceFolders.length === 1) {
      return availableWorkspaceFolders.at(0);
    }

    if (previousFolder) {
      window.showInformationMessage(
        l10n.t('Using workspace folder: {0}', previousFolder.name),
      );

      return previousFolder;
    }

    const pickerPlaceholder = l10n.t(
      '{0}: Select a workspace folder to use. This folder will be used to load workspace-specific configuration for the extension',
      EXTENSION_DISPLAY_NAME,
    );
    const selectedFolder = await window.showWorkspaceFolderPick({
      placeHolder: pickerPlaceholder,
    });

    if (selectedFolder) {
      this.context.globalState.update(
        ContextKeys.SelectedWorkspaceFolder,
        selectedFolder.uri.toString(),
      );
    }

    return selectedFolder;
  }

  /**
   * Initializes workspace configuration and registers configuration listeners.
   *
   * @param selectedWorkspaceFolder - The workspace folder used to load the configuration.
   */
  private initializeConfiguration(
    selectedWorkspaceFolder: WorkspaceFolder,
  ): void {
    this.config = new ExtensionConfig(
      workspace.getConfiguration(EXTENSION_ID, selectedWorkspaceFolder.uri),
    );

    this.config.workspaceSelection = selectedWorkspaceFolder.uri.fsPath;

    workspace.onDidChangeConfiguration((configurationChangeEvent) => {
      const updatedWorkspaceConfig = workspace.getConfiguration(
        EXTENSION_ID,
        selectedWorkspaceFolder.uri,
      );

      if (
        configurationChangeEvent.affectsConfiguration(
          `${EXTENSION_ID}.enable`,
          selectedWorkspaceFolder.uri,
        )
      ) {
        const isExtensionEnabled =
          updatedWorkspaceConfig.get<boolean>('enable');

        this.config.update(updatedWorkspaceConfig);

        if (isExtensionEnabled) {
          const enabledMessage = l10n.t(
            'The {0} extension is now enabled and ready to use',
            EXTENSION_DISPLAY_NAME,
          );
          window.showInformationMessage(enabledMessage);
        } else {
          const disabledMessage = l10n.t(
            'The {0} extension is now disabled',
            EXTENSION_DISPLAY_NAME,
          );
          window.showInformationMessage(disabledMessage);
        }
      }

      if (
        configurationChangeEvent.affectsConfiguration(
          EXTENSION_ID,
          selectedWorkspaceFolder.uri,
        )
      ) {
        this.config.update(updatedWorkspaceConfig);
      }
    });
  }

  /**
   * Returns whether commands should execute under current configuration.
   *
   * @remarks
   * Shows a disabled warning once until the extension is re-enabled.
   */
  private isExtensionEnabled(): boolean {
    const isEnabled = this.config.enable;

    if (isEnabled) {
      this.hasDisabledWarningBeenShown = false;
      return true;
    }

    if (!this.hasDisabledWarningBeenShown) {
      window.showErrorMessage(
        l10n.t(
          'The {0} extension is disabled in settings. Enable it to use its features',
          EXTENSION_DISPLAY_NAME,
        ),
      );
      this.hasDisabledWarningBeenShown = true;
    }

    return false;
  }

  /**
   * Registers workspace selection command for multi-root workspaces.
   */
  private registerWorkspaceCommands(): void {
    const disposableChangeWorkspace = commands.registerCommand(
      `${EXTENSION_ID}.${CommandIds.ChangeWorkspace}`,
      async () => {
        const pickerPlaceholder = l10n.t('Select a workspace folder to use');
        const selectedFolder = await window.showWorkspaceFolderPick({
          placeHolder: pickerPlaceholder,
        });

        if (selectedFolder) {
          this.context.globalState.update(
            ContextKeys.SelectedWorkspaceFolder,
            selectedFolder.uri.toString(),
          );

          const updatedWorkspaceConfig = workspace.getConfiguration(
            EXTENSION_ID,
            selectedFolder.uri,
          );
          this.config.update(updatedWorkspaceConfig);

          this.config.workspaceSelection = selectedFolder.uri.fsPath;

          window.showInformationMessage(
            l10n.t('Switched to workspace folder: {0}', selectedFolder.name),
          );
        }
      },
    );

    this.context.subscriptions.push(disposableChangeWorkspace);
  }

  /**
   * Registers note-related commands and the notes explorer tree view.
   */
  private registerNoteCommands(): void {
    this.notesService = new NotesService(this.config);
    this.notesController = new NotesController(this.config, this.notesService);

    const withEnabledGuard = (callback: () => Promise<void> | void) => {
      return () => {
        if (!this.isExtensionEnabled()) {
          return;
        }
        return callback();
      };
    };

    const noteCommands = [
      {
        id: CommandIds.CreateProjectNote,
        handler: withEnabledGuard(() =>
          this.notesController?.createProjectNote(),
        ),
      },
      {
        id: CommandIds.OpenProjectNote,
        handler: withEnabledGuard(() =>
          this.notesController?.openProjectNote(),
        ),
      },
      {
        id: CommandIds.InsertNoteLink,
        handler: withEnabledGuard(() => this.notesController?.insertNoteLink()),
      },
      {
        id: CommandIds.GoToNoteById,
        handler: withEnabledGuard(() => this.notesController?.goToNoteById()),
      },
      {
        id: CommandIds.OpenLinkedNote,
        handler: withEnabledGuard(() => this.notesController?.openLinkedNote()),
      },
      {
        id: CommandIds.OpenReference,
        handler: withEnabledGuard(() => this.notesController?.openReference()),
      },
      {
        id: CommandIds.OpenBacklinks,
        handler: withEnabledGuard(() => this.notesController?.openBacklinks()),
      },
      {
        id: CommandIds.OpenRelatedNotes,
        handler: withEnabledGuard(() =>
          this.notesController?.openRelatedNotes(),
        ),
      },
      {
        id: CommandIds.OpenContextForFile,
        handler: withEnabledGuard(() =>
          this.notesController?.openContextForFile(),
        ),
      },
    ];

    noteCommands.forEach(({ id, handler }) => {
      const disposable = commands.registerCommand(
        `${EXTENSION_ID}.${id}`,
        handler,
      );

      this.context.subscriptions.push(disposable);
    });

    const disposableOpenContextLine = commands.registerCommand(
      `${EXTENSION_ID}.${CommandIds.OpenContextForLine}`,
      (uriArg?: unknown, line?: unknown) => {
        if (!this.isExtensionEnabled()) {
          return;
        }
        return this.notesController?.openContextForLine(
          uriArg,
          typeof line === 'number' ? line : undefined,
        );
      },
    );
    this.context.subscriptions.push(disposableOpenContextLine);

    const notesTreeProvider = new NotesTreeProvider(this.notesService);
    notesTreeProvider.startWatching();

    const contextDecorationProvider = new ContextDecorationProvider(
      this.notesService,
      this.config,
    );
    contextDecorationProvider.register(this.context);

    const notesTreeView = window.createTreeView(
      'codeContextPlus.notesExplorer',
      {
        treeDataProvider: notesTreeProvider,
        showCollapseAll: true,
      },
    );

    this.context.subscriptions.push(notesTreeView, {
      dispose: () => notesTreeProvider.dispose(),
    });

    const disposableRefreshList = commands.registerCommand(
      `${EXTENSION_ID}.${CommandIds.RefreshNotesExplorer}`,
      async () => {
        if (!this.isExtensionEnabled()) {
          return;
        }

        await notesTreeProvider.refresh();
      },
    );

    this.context.subscriptions.push(disposableRefreshList);
  }
}
