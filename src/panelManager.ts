import * as vscode from 'vscode';
import { IViceDebuggerServices } from './sessionRegistry';
import { ViceWebviewPanel } from './webview/basePanel';
import { RegistersPanel } from './webview/registersPanel';
import { MemoryPanel } from './webview/memoryPanel';
import { ScreenPanel } from './webview/screenPanel';
import { DisassemblyPanel } from './webview/disassemblyPanel';

const MAX_MEMORY_PANELS_PER_SESSION = 8;

/**
 * Owns the set of open webview panels per debug session.
 *
 * Keying rules:
 *  - Registers: one instance per session (key: "<session>:registers").
 *  - Memory: multiple instances per session (key: "<session>:mem:<tag>").
 *    "Show Memory Window" reveals the existing default instance or creates
 *    it; "New Memory Window" always creates a fresh instance.
 */
export class VicePanelManager {
	private _panels = new Map<string, ViceWebviewPanel>();
	private _memoryCounter = 0;

	public showRegisters(sessionId: string, services: IViceDebuggerServices): void {
		const key = `${sessionId}:registers`;
		let panel = this._panels.get(key);
		if (!panel) {
			panel = new RegistersPanel(services);
			this._panels.set(key, panel);
		}
		panel.reveal();
	}

	public showScreen(sessionId: string, services: IViceDebuggerServices): void {
		const key = `${sessionId}:screen`;
		let panel = this._panels.get(key);
		if (!panel) {
			panel = new ScreenPanel(services);
			this._panels.set(key, panel);
		}
		panel.reveal();
	}

	public showDisassembly(sessionId: string, services: IViceDebuggerServices): void {
		const key = `${sessionId}:disassembly`;
		let panel = this._panels.get(key);
		if (!panel) {
			panel = new DisassemblyPanel(services);
			this._panels.set(key, panel);
		}
		panel.reveal();
	}

	public showMemory(sessionId: string, services: IViceDebuggerServices, options?: { newWindow?: boolean; startAddress?: number }): void {
		const newWindow = options?.newWindow === true;
		let key = `${sessionId}:mem:default`;

		if (newWindow) {
			if (this._countMemoryPanels(sessionId) >= MAX_MEMORY_PANELS_PER_SESSION) {
				vscode.window.showWarningMessage(`At most ${MAX_MEMORY_PANELS_PER_SESSION} memory windows may be open per debug session.`);
				return;
			}
			this._memoryCounter++;
			key = `${sessionId}:mem:#${this._memoryCounter}`;
		}

		let panel = this._panels.get(key);
		if (!panel) {
			const title = key.endsWith(':default')
				? 'Memory'
				: `Memory (${key.slice(key.lastIndexOf(':') + 1)})`;
			panel = new MemoryPanel(services, title, options?.startAddress);
			this._panels.set(key, panel);
		}
		panel.reveal();
	}

	/** Dispose every panel belonging to a debug session. */
	public closeSession(sessionId: string): void {
		const prefix = `${sessionId}:`;
		for (const [key, panel] of this._panels) {
			if (key.startsWith(prefix)) {
				this._panels.delete(key);
				panel.dispose();
			}
		}
	}

	private _countMemoryPanels(sessionId: string): number {
		const prefix = `${sessionId}:mem:`;
		let count = 0;
		for (const key of this._panels.keys()) {
			if (key.startsWith(prefix)) { count++; }
		}
		return count;
	}
}