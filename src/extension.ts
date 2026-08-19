import * as vscode from 'vscode';
import { ViceDebugSession } from './viceDebugSession';

export function activate(context: vscode.ExtensionContext) {
	// Register dynamic configuration provider
	const provider = new ViceConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('vice', provider));

	// Register inline debug adapter factory
	const factory = new ViceDebugAdapterFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('vice', factory));
}

export function deactivate() {
	// Clean up resources if needed
}

class ViceConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		// If launch.json is missing or empty, provide defaults
		if (!config.type && !config.request && !config.name) {
			config.type = 'vice';
			config.name = 'VICE: Launch & Debug';
			config.request = 'launch';
			config.program = '${file}';
			config.stopOnEntry = true;
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
