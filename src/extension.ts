import * as vscode from 'vscode';
import { ViceDebugSession } from './viceDebugSession';

export function activate(context: vscode.ExtensionContext) {
	// Register configuration provider
	const provider = new ViceConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('vice', provider));

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
				name: 'VICE: Launch & Debug',
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
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		// If launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			config.type = 'vice';
			config.name = 'VICE: Launch & Debug';
			config.request = 'launch';
			config.program = '${file}';
			config.viceExecutable = 'x64sc';
			config.stopOnDebug = true;
		}

		if (config.viceExecutable === undefined) {
			config.viceExecutable = 'x64sc';
		}

		if (config.stopOnDebug === undefined) {
			config.stopOnDebug = true;
		}

		return config;
	}
}

class ViceDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(
		_session: vscode.DebugSession
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new ViceDebugSession());
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
