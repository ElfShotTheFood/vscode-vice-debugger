import * as vscode from 'vscode';
import { ViceDebugSession } from './viceDebugSession';
import { registerDebuggerServices, unregisterDebuggerServices, getDebuggerServices } from './sessionRegistry';
import { VicePanelManager } from './panelManager';

export function activate(context: vscode.ExtensionContext) {
	// Register configuration provider
	const provider = new ViceConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('vice', provider));

	// Webview panel manager for the registers / memory windows
	const panelManager = new VicePanelManager();

	// Register dynamic configuration provider for VS Code menus
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(
			'vice',
			{
				provideDebugConfigurations(_folder: vscode.WorkspaceFolder | undefined): vscode.ProviderResult<vscode.DebugConfiguration[]> {
					return [
						{
							type: 'vice',
							request: 'launch',
							name: 'VICE: Launch & Debug (C64)',
							viceExecutable: 'x64sc',
							program: '${workspaceFolder}/main.prg',
							stopOnDebug: true
						},
						{
							type: 'vice',
							request: 'launch',
							name: 'VICE: Launch & Debug (PET)',
							viceExecutable: 'xpet',
							program: '${workspaceFolder}/main.prg',
							stopOnDebug: true
						}
					];
				}
			},
			vscode.DebugConfigurationProviderTriggerKind.Dynamic
		)
	);

	// Register inline debug adapter factory
	const factory = new ViceDebugAdapterFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('vice', factory));

	// Track session lifetime: register services for webview panels and clean
	// up panels when the session ends.
	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
		unregisterDebuggerServices(session.id);
		panelManager.closeSession(session.id);
	}));

	const withActiveSession = (run: (sessionId: string) => void): void => {
		const session = vscode.debug.activeDebugSession;
		if (!session || session.type !== 'vice') {
			vscode.window.showErrorMessage('No active VICE debug session. Start a debug session first.');
			return;
		}
		if (!getDebuggerServices(session.id)) {
			vscode.window.showErrorMessage('VICE debug services are not available for the active session yet.');
			return;
		}
		run(session.id);
	};

	context.subscriptions.push(vscode.commands.registerCommand('extension.vice-debugger.showRegisters', () => {
		withActiveSession(sessionId => {
			const services = getDebuggerServices(sessionId)!;
			panelManager.showRegisters(sessionId, services);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vice-debugger.showMemory', () => {
		withActiveSession(sessionId => {
			const services = getDebuggerServices(sessionId)!;
			panelManager.showMemory(sessionId, services);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vice-debugger.newMemoryWindow', () => {
		withActiveSession(sessionId => {
			const services = getDebuggerServices(sessionId)!;
			panelManager.showMemory(sessionId, services, { newWindow: true });
		});
	}));

	// Register command to explicitly generate / create launch.json for a 6502 project
	context.subscriptions.push(
		vscode.commands.registerCommand('extension.vice-debugger.createLaunchJson', async () => {
			await createLaunchJsonFile();
		})
	);
}

export function deactivate() {
	// Clean up resources if needed
}

class ViceConfigurationProvider implements vscode.DebugConfigurationProvider {
	/**
	 * Called by VS Code when generating initial launch.json configurations for this debugger.
	 */
	provideDebugConfigurations(
		_folder: vscode.WorkspaceFolder | undefined,
		_token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration[]> {
		return [
			{
				type: 'vice',
				request: 'launch',
				name: 'VICE: Launch & Debug (C64)',
				viceExecutable: 'x64sc',
				program: '${workspaceFolder}/main.prg',
				stopOnDebug: true
			}
		];
	}

	/**
	 * Massage a debug configuration just before a debug session is being launched.
	 */
	resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		// If launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			config.type = 'vice';
			config.name = 'VICE: Launch & Debug (C64)';
			config.request = 'launch';
			config.program = '${file}';
			config.viceExecutable = 'x64sc';
			config.stopOnDebug = true;
		}

		if (!config.viceExecutable) {
			config.viceExecutable = 'x64sc';
		}

		if (config.stopOnDebug === undefined) {
			config.stopOnDebug = true;
		}

		// Read VICE installation directory from VS Code workspace settings if not explicitly provided
		if (!config.viceDirectory) {
			const viceConfig = vscode.workspace.getConfiguration('vice', folder?.uri);
			const installDir = viceConfig.get<string>('installationDirectory');
			if (installDir && installDir.trim().length > 0) {
				config.viceDirectory = installDir.trim();
			}
		}

		return config;
	}
}

class ViceDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(
		session: vscode.DebugSession
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		const debugSession = new ViceDebugSession();
		// Expose the session's monitor-backed services to webview panels.
		registerDebuggerServices(session.id, debugSession.services);
		return new vscode.DebugAdapterInlineImplementation(debugSession);
	}
}

/**
 * Creates or updates .vscode/launch.json for a 6502 project in the current workspace.
 */
async function createLaunchJsonFile(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage('Cannot create launch.json: No workspace folder is currently open.');
		return;
	}

	let targetFolder = workspaceFolders[0];
	if (workspaceFolders.length > 1) {
		const selected = await vscode.window.showWorkspaceFolderPick({
			placeHolder: 'Select workspace folder to create launch.json in'
		});
		if (!selected) {
			return;
		}
		targetFolder = selected;
	}

	const viceExecutables = [
		{ label: 'x64sc', description: 'Commodore 64 (accurate)' },
		{ label: 'xpet', description: 'Commodore PET' },
		{ label: 'x128', description: 'Commodore 128' },
		{ label: 'xvic', description: 'Commodore VIC-20' },
		{ label: 'xplus4', description: 'Commodore Plus/4, C16' },
		{ label: 'xcbm2', description: 'Commodore CBM-II (6x0/7x0)' },
		{ label: 'x64', description: 'Commodore 64 (fast)' }
	];

	const chosen = await vscode.window.showQuickPick(viceExecutables, {
		placeHolder: 'Select the VICE emulator executable for this 6502 project',
		title: 'VICE Emulator Executable'
	});

	const viceExecutable = chosen ? chosen.label : 'x64sc';

	const launchConfig = {
		version: '0.2.0',
		configurations: [
			{
				type: 'vice',
				request: 'launch',
				name: `VICE: Launch & Debug (${viceExecutable})`,
				viceExecutable: viceExecutable,
				program: '${workspaceFolder}/main.prg',
				stopOnDebug: true
			}
		]
	};

	const vscodeDirUri = vscode.Uri.joinPath(targetFolder.uri, '.vscode');
	const launchJsonUri = vscode.Uri.joinPath(vscodeDirUri, 'launch.json');

	try {
		await vscode.workspace.fs.createDirectory(vscodeDirUri);
		const jsonString = JSON.stringify(launchConfig, null, '\t') + '\n';
		await vscode.workspace.fs.writeFile(launchJsonUri, new TextEncoder().encode(jsonString));

		const doc = await vscode.workspace.openTextDocument(launchJsonUri);
		await vscode.window.showTextDocument(doc);
		vscode.window.showInformationMessage(`Created .vscode/launch.json for 6502 project (VICE: ${viceExecutable}).`);
	} catch (error: any) {
		vscode.window.showErrorMessage(`Failed to create launch.json: ${error?.message || error}`);
	}
}
