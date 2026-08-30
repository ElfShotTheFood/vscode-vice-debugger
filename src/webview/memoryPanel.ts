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
	<table id="memTable" style="margin-top: 8px; line-height: 2.1;"></table>`;
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
		var input = document.createElement('input');
		input.value = hexByte(current);
		input.size = 2;
		span.textContent = '';
		span.appendChild(input);
		input.focus();
		input.select();

		function done() { post('refresh'); }
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				var value = parseInt(input.value.trim(), 16);
				if (!isNaN(value) && value >= 0 && value <= 0xff) {
					post('setByte', { address: address, value: value });
				} else { done(); }
			} else if (e.key === 'Escape') { done(); }
		});
		input.addEventListener('blur', done);
	}

	// Overstrike typing for the address box: printable hex characters replace
	// the character under the cursor; anything else is ignored.
	document.getElementById('addrInput').addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { post('navigate', { address: document.getElementById('addrInput').value }); }
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
		if (e.key === 'Enter') { post('setBytesPerLine', { count: this.value }); }
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