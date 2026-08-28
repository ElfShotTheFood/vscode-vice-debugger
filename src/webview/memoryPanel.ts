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
				bytes: Array.from(data.subarray(0, BYTES_PER_VIEW))
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
			const address = this._parseNumber(String(payload?.address ?? ''));
			if (address === null || address < 0 || address > 0xffff) {
				this.post('error', { message: 'Invalid address.' });
				return;
			}
			this._startAddress = address;
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

	private _parseNumber(text: string): number | null {
		const trimmed = text.trim();
		if (trimmed.startsWith('$')) { return parseInt(trimmed.slice(1), 16); }
		if (/^0x/i.test(trimmed)) { return parseInt(trimmed.slice(2), 16); }
		if (/^[0-9]+$/.test(trimmed)) { return parseInt(trimmed, 10); }
		if (/^[0-9a-f]+$/i.test(trimmed)) { return parseInt(trimmed, 16); }
		return null;
	}

	protected _getHtml(_webview: vscode.Webview): string {
		const body = `
	<div>
		<label>Address: <input id="addrInput" size="8"> <button id="goBtn">Go</button>
		<button id="refreshBtn">Refresh</button></label>
	</div>
	<table id="memTable"></table>`;
		const script = `
	var vscodeApi = acquireVsCodeApi();
	var running = false;
	var currentStart = 0;

	function post(type, payload) { vscodeApi.postMessage({ type: type, payload: payload }); }

	function hexByte(value) { return (value & 0xff).toString(16).toUpperCase().padStart(2, '0'); }
	function hexAddr(value) { return '$' + (value & 0xffff).toString(16).toUpperCase().padStart(4, '0'); }

	function setBanner(text, isError) {
		var banner = document.getElementById('banner');
		banner.textContent = text;
		banner.className = isError ? 'error' : 'muted';
	}

	function ascii(byte) { return (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : '.'; }

	function render(start, bytes) {
		currentStart = start;
		document.getElementById('addrInput').value = hexAddr(start);
		var table = document.getElementById('memTable');
		table.innerHTML = '';
		for (var rowStart = 0; rowStart < bytes.length; rowStart += 16) {
			var tr = document.createElement('tr');

			var addrTd = document.createElement('td');
			addrTd.className = 'muted';
			addrTd.textContent = hexAddr((start + rowStart) & 0xffff);
			tr.appendChild(addrTd);

			for (var i = 0; i < 16; i++) {
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
			for (var j = 0; j < 16 && rowStart + j < bytes.length; j++) { text += ascii(bytes[rowStart + j]); }
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

	document.getElementById('goBtn').addEventListener('click', function () {
		post('navigate', { address: document.getElementById('addrInput').value });
	});
	document.getElementById('addrInput').addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { post('navigate', { address: document.getElementById('addrInput').value }); }
	});
	document.getElementById('refreshBtn').addEventListener('click', function () { post('refresh'); });

	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.type === 'memory') { render(msg.payload.start, msg.payload.bytes); }
		else if (msg.type === 'state') {
			running = !!msg.payload.running;
			setBanner(msg.payload.connected
				? (running ? 'Target running - editing disabled.' : 'Click a byte to edit it.')
				: 'Not connected to the VICE monitor.', false);
		}
		else if (msg.type === 'error') { setBanner('Error: ' + msg.payload.message, true); }
	});

	post('refresh');`;
		return this._wrapHtml(_webview, body, script);
	}
}