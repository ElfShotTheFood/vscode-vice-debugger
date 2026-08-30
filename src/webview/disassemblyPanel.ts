import * as vscode from 'vscode';
import { ViceWebviewPanel } from './basePanel';
import { IViceDebuggerServices } from '../sessionRegistry';
import { disassemble, IDisassembledInstruction } from '../disassembler';

const INSTRUCTION_WINDOW = 0x100;   // bytes of memory disassembled per view
const PC_BACK_OFFSET = 0x40;        // when following the PC, start this far before it

interface IDisassemblyRow {
	address: number;
	size: number;
	bytes: string;
	text: string;
}

/**
 * Disassembly panel: shows decoded 6502 instructions and highlights the
 * instruction containing the current PC. Refreshes automatically every time
 * the debugger stops (including all step forms), via the base class.
 *
 * UI contract:
 *  - "Use current PC" checkbox (checked by default): the view follows the PC
 *    on every stop. When unchecked, the address edit box selects the region.
 */
export class DisassemblyPanel extends ViceWebviewPanel {
	public static readonly VIEW_TYPE = 'viceDisassembly';
	public static readonly PANEL_KEY = 'disassembly';

	private _useCurrentPc = true;
	private _manualAddress = 0x0800;

	public constructor(services: IViceDebuggerServices) {
		super(services, DisassemblyPanel.VIEW_TYPE, 'VICE Disassembly');
	}

	protected async refresh(): Promise<void> {
		if (!this._services.isConnected) {
			this.post('state', { connected: false });
			return;
		}
		try {
			const registers = await this._services.getRegisters();
			const pc = registers.pc & 0xffff;

			let startAddress: number;
			if (this._useCurrentPc) {
				startAddress = Math.max(0, pc - PC_BACK_OFFSET);
			} else {
				startAddress = this._manualAddress;
			}

			// Fetch a window of memory and decode it linearly. Note: linear
			// disassembly from an arbitrary start may misalign on data bytes
			// embedded in code; the PC highlight corrects itself as soon as the
			// containing instruction decodes at its true address.
			const end = (startAddress + INSTRUCTION_WINDOW - 1) & 0xffff;
			const data = await this._services.getMemory(startAddress, end);

			const instructions: IDisassembledInstruction[] = disassemble(data, startAddress);
			const rows: IDisassemblyRow[] = instructions.map(instruction => ({
				address: instruction.address,
				size: instruction.size,
				bytes: instruction.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
				text: instruction.text
			}));

			this.post('disassembly', {
				rows,
				pcAddress: pc,
				startAddress,
				useCurrentPc: this._useCurrentPc,
				manualAddress: this._manualAddress
			});
			this.post('state', { connected: true, running: false });
		} catch (err: any) {
			this.post('error', { message: err?.message || String(err) });
		}
	}

	protected _onWebviewMessage(type: string, payload: any): void {
		if (type === 'refresh') {
			void this.refresh();
		} else if (type === 'setMode') {
			// { useCurrentPc: boolean, address?: string }
			this._useCurrentPc = payload?.useCurrentPc !== false;
			if (!this._useCurrentPc && payload?.address !== undefined) {
				const address = this._parseNumber(String(payload.address));
				if (address !== null && address >= 0 && address <= 0xffff) {
					this._manualAddress = address;
				}
			}
			void this.refresh();
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
		<label><input type="checkbox" id="usePc" checked> Use current PC</label>
		<label style="margin-left:16px">Address: <input id="addrInput" size="8" disabled>
		<button id="goBtn" disabled>Go</button></label>
	</div>
	<table id="disTable"></table>`;
		const script = `
	var vscodeApi = acquireVsCodeApi();
	var running = false;

	function post(type, payload) { vscodeApi.postMessage({ type: type, payload: payload }); }

	function hexAddr(value) { return '$' + (value & 0xffff).toString(16).toUpperCase().padStart(4, '0'); }

	function setBanner(text, isError) {
		var banner = document.getElementById('banner');
		banner.textContent = text;
		banner.className = isError ? 'error' : 'muted';
	}

	function setModeControls(usePc, address) {
		document.getElementById('usePc').checked = usePc;
		document.getElementById('addrInput').disabled = usePc || running;
		document.getElementById('goBtn').disabled = usePc || running;
		if (!usePc && typeof address === 'number') {
			document.getElementById('addrInput').value = hexAddr(address);
		}
	}

	function render(data) {
		setModeControls(data.useCurrentPc, data.manualAddress);
		var table = document.getElementById('disTable');
		table.innerHTML = '';
		var rows = data.rows;
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			var tr = document.createElement('tr');
			var isPc = data.pcAddress >= row.address && data.pcAddress < row.address + row.size;
			if (isPc) { tr.className = 'current'; }

			var addrTd = document.createElement('td');
			addrTd.className = 'muted';
			addrTd.textContent = hexAddr(row.address);
			tr.appendChild(addrTd);

			var bytesTd = document.createElement('td');
			bytesTd.className = 'muted';
			bytesTd.textContent = row.bytes;
			tr.appendChild(bytesTd);

			var textTd = document.createElement('td');
			textTd.textContent = row.text;
			tr.appendChild(textTd);

			table.appendChild(tr);
		}
	}

	document.getElementById('usePc').addEventListener('change', function () {
		post('setMode', { useCurrentPc: this.checked, address: document.getElementById('addrInput').value });
	});
	document.getElementById('goBtn').addEventListener('click', function () {
		post('setMode', { useCurrentPc: false, address: document.getElementById('addrInput').value });
	});
	document.getElementById('addrInput').addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { post('setMode', { useCurrentPc: false, address: this.value }); }
	});

	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.type === 'disassembly') { render(msg.payload); }
		else if (msg.type === 'state') {
			running = !!msg.payload.running;
			setBanner(msg.payload.connected
				? (running ? 'Target running - waiting for next stop.' : 'Highlighted line contains the current PC.')
				: 'Not connected to the VICE monitor.', false);
		}
		else if (msg.type === 'error') { setBanner('Error: ' + msg.payload.message, true); }
	});

	post('refresh');`;
		return this._wrapHtml(_webview, body, script);
	}
}

