import * as vscode from 'vscode';
import { ViceWebviewPanel } from './basePanel';
import { IViceDebuggerServices } from '../sessionRegistry';

const BYTES_PER_VIEW = 128;   // 8 rows of 16 bytes

/**
 * Memory panel: view and edit emulated memory. Multiple instances are
 * supported (each instance navigates its own address range); the panel
 * manager keys instances by tag.
 */
export class MemoryPanel extends ViceWebviewPanel {
	public static readonly VIEW_TYPE = 'viceMemory';

	private _startAddress = 0x0000;
	private _bytesPerLine = 16;

	public constructor(services: IViceDebuggerServices, title: string, startAddress?: number) {
		super(services, MemoryPanel.VIEW_TYPE, title);
		if (startAddress !== undefined) {
			this._startAddress = startAddress & 0xffff;
		}
	}

	public get startAddress(): number {
		return this._startAddress;
	}

	protected async refresh(): Promise<void> {
		if (!this._services.isConnected) {
			this.post('state', { connected: false });
			return;
		}
		try {
			const start = this._startAddress;
			const end = (start + BYTES_PER_VIEW - 1) & 0xffff;
			const data = await this._services.getMemory(start, end);
			this.post('memory', {
				start,
				bytes: Array.from(data.subarray(0, BYTES_PER_VIEW)),
				bytesPerLine: this._bytesPerLine
			});
			this.post('state', { connected: true, running: false });
		} catch (err: any) {
			this.post('error', { message: err?.message || String(err) });
		}
	}

	protected _onWebviewMessage(type: string, payload: any): void {
		if (type === 'refresh') {
			void this.refresh();
		} else if (type === 'navigate') {
			const address = this._parseHexAddress(String(payload?.address ?? ''));
			if (address === null || address < 0 || address > 0xffff) {
				this.post('error', { message: 'Invalid hex address.' });
				return;
			}
			this._startAddress = address;
			void this.refresh();
		} else if (type === 'setBytesPerLine') {
			// The edit box is decimal.
			const count = Number(payload?.count ?? 0);
			if (!Number.isInteger(count) || count < 1 || count > 64) {
				this.post('error', { message: 'Bytes per row must be between 1 and 64.' });
				return;
			}
			this._bytesPerLine = count;
			void this.refresh();
		} else if (type === 'setByte') {
			const address = Number(payload?.address ?? -1);
			const value = Number(payload?.value ?? -1);
			if (!Number.isInteger(address) || address < 0 || address > 0xffff ||
				!Number.isInteger(value) || value < 0 || value > 0xff) {
				this.post('error', { message: 'Invalid memory edit.' });
				return;
			}
			void this._services.setMemory(address, Buffer.from([value]))
				.then(() => this.refresh())
				.catch((err: any) => this.post('error', { message: err?.message || String(err) }));
		}
	}

	private _parseHexAddress(text: string): number | null {
		const trimmed = text.trim().replace(/^\$|^0x/i, '');
		if (!/^[0-9a-f]{1,4}$/i.test(trimmed)) { return null; }
		const value = parseInt(trimmed, 16);
		return Number.isNaN(value) ? null : value;
	}

	protected _getHtml(_webview: vscode.Webview): string {
		const body = `
	<div>
		<label>Address: <input id="addrInput" size="4" maxLength="4"></label>
		<label style="margin-left:16px">Bytes per row: <input id="bytesInput" size="2" maxLength="2" value="16"></label>
	</div>
	<table id="memTable" style="margin-top: 8px; line-height: 1.6;"></table>
	<style>
		/* Labels (Address, Bytes per row) and hex addresses render in cyan. */
		div label, #memTable td:first-child { color: #00FFFF; }
		/* Suppress the browser focus rectangle on the byte editor spans;
		   the blinking block cursor is the focus indicator. */
		#memTable span:focus { outline: none; }
	</style>`;
		const script = `
	var vscodeApi = acquireVsCodeApi();
	var running = false;
	var currentStart = 0;

	function post(type, payload) { vscodeApi.postMessage({ type: type, payload: payload }); }

	function hexByte(value) { return (value & 0xff).toString(16).toUpperCase().padStart(2, '0'); }
	function hexAddr(value) { return (value & 0xffff).toString(16).toUpperCase().padStart(4, '0'); }

	function setBanner(text, isError) {
		var banner = document.getElementById('banner');
		banner.textContent = text;
		banner.className = isError ? 'error' : 'muted';
		banner.style.display = text ? '' : 'none';
	}

	function ascii(byte) { return (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : '.'; }

	function render(start, bytes, bytesPerLine) {
		currentStart = start;
		document.getElementById('addrInput').value = hexAddr(start);
		document.getElementById('bytesInput').value = bytesPerLine.toString(10);
		var table = document.getElementById('memTable');
		table.innerHTML = '';
		for (var rowStart = 0; rowStart < bytes.length; rowStart += bytesPerLine) {
			var tr = document.createElement('tr');

			var addrTd = document.createElement('td');
			addrTd.className = 'muted';
			addrTd.textContent = hexAddr((start + rowStart) & 0xffff);
			tr.appendChild(addrTd);

			for (var i = 0; i < bytesPerLine; i++) {
				var td = document.createElement('td');
				var address = (start + rowStart + i) & 0xffff;
				var byte = bytes[rowStart + i];
				if (byte === undefined) { td.textContent = '--'; }
				else {
					var span = document.createElement('span');
					span.textContent = hexByte(byte);
					span.title = hexAddr(address);
					span.style.cursor = running ? 'default' : 'pointer';
					span.addEventListener('click', function (addr, current) {
						return function () { editByte(this, addr, current); };
					}(address, byte));
					td.appendChild(span);
				}
				tr.appendChild(td);
			}

			var asciiTd = document.createElement('td');
			asciiTd.className = 'muted';
			var text = '';
			for (var j = 0; j < bytesPerLine && rowStart + j < bytes.length; j++) { text += ascii(bytes[rowStart + j]); }
			asciiTd.textContent = text;
			tr.appendChild(asciiTd);

			table.appendChild(tr);
		}
	}

	function editByte(span, address, current) {
		if (running) { return; }

		// Character-based edit control using the byte's own span: the display
		// element itself becomes the editor, so the digits occupy exactly the
		// same pixels before, during, and after editing (same element, font,
		// and layout — nothing is overlaid or repositioned).  The cursor is a
		// blinking block: the digit under the cursor is inverted.
		var original = hexByte(current);
		var digits = [original.charAt(0), original.charAt(1)];
		var cursor = 0;
		var blinkTimer = null;
		var blinkOn = true;

		function stopBlink() {
			if (blinkTimer !== null) { clearInterval(blinkTimer); blinkTimer = null; }
		}

		function renderText() {
			span.textContent = digits[0] + digits[1];
		}

		// Re-render the two characters, inverting (block cursor) the digit
		// currently under the cursor.  Called on every blink tick.
		function renderCursor() {
			var charSpans = [];
			for (var i = 0; i < 2; i++) {
				var c = document.createElement('span');
				c.textContent = digits[i];
				if (i === cursor && blinkOn) {
					c.style.background = 'var(--vscode-editor-foreground)';
					c.style.color = 'var(--vscode-editor-background)';
				}
				charSpans.push(c);
			}
			span.innerHTML = '';
			span.appendChild(charSpans[0]);
			span.appendChild(charSpans[1]);
		}

		function startEditing() {
			blinkOn = true;
			renderCursor();
			blinkTimer = setInterval(function () {
				blinkOn = !blinkOn;
				renderCursor();
			}, 350); // 50% faster than the original 530ms
		}

		function finish(redraw) {
			stopBlink();
			span.removeEventListener('keydown', onKey);
			span.removeEventListener('blur', onBlur);
			span.tabIndex = 0;
			renderText();
			if (redraw) { post('refresh'); }
		}

		function onKey(e) {
			if (e.key === 'Enter') {
				e.preventDefault();
				var value = parseInt(digits.join(''), 16);
				stopBlink();
				span.removeEventListener('keydown', onKey);
				span.removeEventListener('blur', onBlur);
				if (!isNaN(value) && value >= 0 && value <= 0xff) {
					// Show the committed value immediately, then refresh.
					span.textContent = value.toString(16).toUpperCase().padStart(2, '0');
					post('setByte', { address: address, value: value });
				} else { finish(true); }
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finish(true);
			} else if (e.key === 'ArrowLeft') {
				e.preventDefault();
				blinkOn = true;
				cursor = Math.max(0, cursor - 1);
				renderCursor();
			} else if (e.key === 'ArrowRight') {
				e.preventDefault();
				blinkOn = true;
				cursor = Math.min(1, cursor + 1);
				renderCursor();
			} else if (e.key === 'Home') {
				e.preventDefault();
				blinkOn = true;
				cursor = 0;
				renderCursor();
			} else if (e.key === 'End') {
				e.preventDefault();
				blinkOn = true;
				cursor = 1;
				renderCursor();
			} else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
				if (!/^[0-9a-fA-F]$/.test(e.key)) { e.preventDefault(); return; }
				e.preventDefault();
				digits[cursor] = e.key.toUpperCase();
				blinkOn = true;
				cursor = Math.min(1, cursor + 1);
				renderCursor();
			}
		}

		function onBlur() {
			finish(true);
		}

		span.addEventListener('keydown', onKey);
		span.addEventListener('blur', onBlur);
		span.tabIndex = 0;
		span.focus();
		startEditing();
	}

	// Overstrike typing for the address box: printable hex characters replace
	// the character under the cursor; anything else is ignored.
	document.getElementById('addrInput').addEventListener('keydown', function (e) {
		if (e.key === 'Enter') {
			document.getElementById('addrInput').blur(); // terminate editing
			post('navigate', { address: document.getElementById('addrInput').value });
		}
		else if (e.key === 'Escape') {
			// Restore the address the window is currently showing.
			document.getElementById('addrInput').value = hexAddr(currentStart);
			document.getElementById('addrInput').blur();
		}
		else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			if (!/^[0-9a-fA-F]$/.test(e.key)) { e.preventDefault(); return; }
			var input = e.target;
			var start = input.selectionStart;
			if (start !== null && input.selectionStart === input.selectionEnd && start < input.value.length) {
				e.preventDefault();
				input.value = input.value.substring(0, start) + e.key.toUpperCase() + input.value.substring(start + 1);
				input.setSelectionRange(start + 1, start + 1);
			}
		}
	});
	var bytesPerLineValue = 16;
	// Overstrike + decimal-only input for the bytes-per-row box.
	document.getElementById('bytesInput').addEventListener('keydown', function (e) {
		if (e.key === 'Enter') {
			this.blur(); // terminate editing immediately
			post('setBytesPerLine', { count: this.value });
		}
		else if (e.key === 'Escape') {
			this.value = bytesPerLineValue.toString(10);
			this.blur();
		}
		else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			if (!/^[0-9]$/.test(e.key)) { e.preventDefault(); return; }
			// With maxLength=2, typing replaces the whole value (overstrike).
			e.preventDefault();
			this.value = e.key;
			this.setSelectionRange(1, 1);
		}
	});

	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.type === 'memory') { bytesPerLineValue = msg.payload.bytesPerLine; render(msg.payload.start, msg.payload.bytes, msg.payload.bytesPerLine); }
		else if (msg.type === 'state') {
			running = !!msg.payload.running;
			setBanner('', false);
		}
		else if (msg.type === 'error') { setBanner('Error: ' + msg.payload.message, true); }
	});

	post('refresh');`;
		return this._wrapHtml(_webview, body, script);
	}
}