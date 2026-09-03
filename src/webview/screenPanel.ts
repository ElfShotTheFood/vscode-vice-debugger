import * as vscode from 'vscode';
import { ViceWebviewPanel } from './basePanel';
import { IViceDebuggerServices } from '../sessionRegistry';

export const SCREEN_START = 0x8000;
export const SCREEN_WIDTH = 40;
export const SCREEN_HEIGHT = 25;
export const SCREEN_BYTES = SCREEN_WIDTH * SCREEN_HEIGHT; // 1000

/**
 * Convert a Commodore screen code (character ROM index) to its PETSCII code.
 *
 * The four linear ranges of the character ROM:
 *   $00-$1F -> $40-$5F (+$40)   @, A-Z
 *   $20-$3F -> $20-$3F (same)   punctuation, digits
 *   $40-$5F -> $60-$7F (+$20)
 *   $60-$7F -> $A0-$BF (+$40)   shifted graphics
 * Note: screen codes $80-$FF are the reverse-video glyphs.  They have no
 * distinct PETSCII values (PETSCII reverse space/digits are done with the
 * RVS-ON control code), so this function is only meaningful for $00-$7F.
 */
export function screenCodeToPetscii(screenCode: number): number {
	const sc = screenCode & 0x7f;
	if (sc < 0x20) { return sc + 0x40; }
	if (sc < 0x40) { return sc; }
	if (sc < 0x60) { return sc + 0x20; }
	return sc + 0x40;
}

/**
 * Convert a screen code to the Style64 font's Unicode code point using the
 * "Screencode/CharROM" Private Use Area mapping: U+EE00 + screen code.  The
 * U+EE00 block is indexed by character-ROM position, so the reverse-video
 * glyphs ($80-$FF) are simply U+EE80-U+EEFF — no PETSCII detour and no CSS
 * is needed for reverse video.  (Per the Style64 PETSCII reference, the
 * *direct PETSCII* mapping lives at U+E000 instead.)
 */
export function screenCodeToStyle64(screenCode: number): number {
	return 0xee00 + (screenCode & 0xff);
}

/**
 * Screen panel: renders the 1000-byte PET text screen at $8000 as a 40x25
 * matrix of Style64 glyphs.  Refreshes automatically every time the debugger
 * stops (including all step forms), via the base class.
 */
export class ScreenPanel extends ViceWebviewPanel {
	public static readonly VIEW_TYPE = 'viceScreen';
	public static readonly PANEL_KEY = 'screen';

	public constructor(services: IViceDebuggerServices) {
		super(services, ScreenPanel.VIEW_TYPE, 'Screen');
	}

	protected async refresh(): Promise<void> {
		if (!this._services.isConnected) {
			this.post('state', { connected: false });
			return;
		}
		try {
			const end = (SCREEN_START + SCREEN_BYTES - 1) & 0xffff;
			const data = await this._services.getMemory(SCREEN_START, end);
			const lines: string[] = [];
			for (let row = 0; row < SCREEN_HEIGHT; row++) {
				let line = '';
				for (let col = 0; col < SCREEN_WIDTH; col++) {
					const screenCode = data[row * SCREEN_WIDTH + col] ?? 0x20;
					line += String.fromCharCode(screenCodeToStyle64(screenCode));
				}
				lines.push(line);
			}
			this.post('screen', { lines, startAddress: SCREEN_START, width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
			this.post('state', { connected: true, running: false });
		} catch (err: any) {
			this.post('error', { message: err?.message || String(err) });
		}
	}

	protected _onWebviewMessage(type: string, _payload: any): void {
		if (type === 'refresh') {
			void this.refresh();
		}
	}

	protected _getHtml(_webview: vscode.Webview): string {
		const body = `
	<style>
		/* The Style64 font must be installed on the system (e.g. 'C64 Pro
		   Mono'); the PUA glyphs render PETSCII directly. */
		#screen {
			font-family: 'C64 Pro Mono', 'C64 Pro', 'Style', monospace;
			font-size: 16px;
			line-height: 1.05;
			white-space: pre;
			margin: 0;
		}
	</style>
	<pre id="screen"></pre>`;
		const script = `
	var vscodeApi = acquireVsCodeApi();

	function setBanner(text, isError) {
		var banner = document.getElementById('banner');
		banner.textContent = text;
		banner.className = isError ? 'error' : 'muted';
		banner.style.display = text ? '' : 'none';
	}

	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.type === 'screen') {
			document.getElementById('screen').textContent = msg.payload.lines.join('\\n');
		}
		else if (msg.type === 'state') {
			setBanner(msg.payload.connected ? '' : 'Not connected to the VICE monitor.', false);
		}
		else if (msg.type === 'error') { setBanner('Error: ' + msg.payload.message, true); }
	});

	vscodeApi.postMessage({ type: 'refresh', payload: null });`;
		return this._wrapHtml(_webview, body, script);
	}
}
