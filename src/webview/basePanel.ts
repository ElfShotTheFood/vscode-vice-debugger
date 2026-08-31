import * as vscode from 'vscode';
import { IViceDebuggerServices } from '../sessionRegistry';
import { EDIT_BOX_SCRIPT } from './widgets/editBox';

/**
 * Common base for all VICE debugger webview panels.
 *
 * Handles panel lifecycle (create/reveal/dispose), the message envelope
 * ({ type, payload } in both directions), CSP nonce handling, and automatic
 * refresh on debugger lifecycle events. Subclasses supply their HTML body,
 * their message handlers, and a refresh() implementation.
 */
export abstract class ViceWebviewPanel {
	protected _panel: vscode.WebviewPanel | undefined;
	private _panelDisposables: vscode.Disposable[] = [];
	private _eventSubscription: { dispose(): void } | undefined;

	protected constructor(
		protected readonly _services: IViceDebuggerServices,
		private readonly _viewType: string,
		private readonly _title: string
	) {
		this._eventSubscription = this._services.onDebuggerEvent((event, payload) =>
			this._onDebuggerEvent(event, payload));
	}

	/** Create the panel if needed and bring it to the front. */
	public reveal(column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
		if (this._panel) {
			this._panel.reveal(column, true);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			this._viewType,
			this._title,
			{ viewColumn: column, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);
		this._panel = panel;

		panel.webview.html = this._getHtml(panel.webview);

		panel.onDidDispose(() => {
			this._panel = undefined;
			this._panelDisposables.forEach(d => d.dispose());
			this._panelDisposables = [];
			this._onPanelClosed();
		}, null, this._panelDisposables);

		panel.webview.onDidReceiveMessage(
			(message: { type: string; payload?: any }) => {
				try {
					this._onWebviewMessage(message.type, message.payload);
				} catch (err: any) {
					this.post('error', { message: err?.message || String(err) });
				}
			},
			null,
			this._panelDisposables
		);

		this.post('state', { connected: this._services.isConnected });
		void this.refresh();
	}

	public get isVisible(): boolean {
		return this._panel !== undefined;
	}

	public dispose(): void {
		this._eventSubscription?.dispose();
		this._eventSubscription = undefined;
		this._panel?.dispose();
		this._panel = undefined;
	}

	/** Send an envelope message to the webview (no-op when the panel is closed). */
	protected post(type: string, payload?: unknown): void {
		if (this._panel) {
			void this._panel.webview.postMessage({ type, payload });
		}
	}

	/** Fetch current data from the debug session and post it to the webview. */
	protected abstract refresh(): Promise<void>;

	/** Build the full HTML document for the webview. */
	protected abstract _getHtml(webview: vscode.Webview): string;

	/** Handle a message arriving from the webview. */
	protected abstract _onWebviewMessage(type: string, payload: any): void;

	/** Called when the underlying WebviewPanel is closed by the user/VS Code. */
	protected _onPanelClosed(): void {
		// Default: nothing extra. The manager removes it from its registry.
	}

	/** Refresh on lifecycle events so panels always show post-stop state. */
	protected _onDebuggerEvent(event: string, _payload: any): void {
		if (event === 'stopped' || event === 'jam' || event === 'registers') {
			void this.refresh();
		} else if (event === 'resumed') {
			this.post('state', { connected: this._services.isConnected, running: true });
		} else if (event === 'disconnected') {
			this.post('state', { connected: false });
		}
	}

	/** Standard CSP-safe HTML document shell with the shared stylesheet. */
	protected _wrapHtml(webview: vscode.Webview, body: string, script: string): string {
		const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		body { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 13px); padding: 8px; color: var(--vscode-foreground); }
		table { border-collapse: collapse; }
		td, th { padding: 2px 10px 2px 0; text-align: left; }
		th { color: var(--vscode-descriptionForeground); font-weight: normal; }
		input, button, select {
			font-family: var(--vscode-editor-font-family);
			font-size: inherit;
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, transparent);
			padding: 1px 4px;
		}
		input:focus, button:focus { outline: 1px solid var(--vscode-focusBorder); }
		button { cursor: pointer; }
		button:disabled, input:disabled { opacity: 0.5; cursor: default; }
		.muted { color: var(--vscode-descriptionForeground); }
		.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
		.banner { margin-bottom: 8px; }
		/* Match how the editor highlights the current line. */
		.current td { background: var(--vscode-editor-lineHighlightBackground); }
		.current td:first-child { border-left: 2px solid var(--vscode-focusBorder); }
	</style>
</head>
<body>
	<div class="banner" id="banner"></div>
	${body}
	<script nonce="${nonce}">
	${EDIT_BOX_SCRIPT}
	${script}
	</script>
</body>
</html>`;
	}
}