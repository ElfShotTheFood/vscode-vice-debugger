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
		super(services, DisassemblyPanel.VIEW_TYPE, 'Disassembly');
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
			// { useCurrentPc: boolean, address?: number|string }
			this._useCurrentPc = payload?.useCurrentPc !== false;
			if (!this._useCurrentPc && payload?.address !== undefined) {
				// The edit box commits a numeric value; accept numbers
				// directly and only parse raw strings as hex.
				const raw = payload.address;
				const address = typeof raw === 'number' ? raw : this._parseNumber(String(raw));
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
	<style>
		/* The document itself never scrolls: the toolbar is a fixed flex row
		   and only the instruction area scrolls, so the controls cannot move
		   at all while scrolling. */
		html, body { height: 100%; }
		body { overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; }
		.disToolbar { flex: 0 0 auto; padding-bottom: 8px; }
		.disRow { margin-bottom: 4px; }
		.disScroll { flex: 1 1 auto; overflow-y: auto; }
	</style>
	<div class="disToolbar">
		<div class="disRow">
			<label><input type="radio" name="disMode" id="modePc" value="pc" checked> Current PC</label>
		</div>
		<div class="disRow">
			<label><input type="radio" name="disMode" id="modeAddr" value="addr"> Address</label>
			<input id="addrInput" size="4" maxLength="4" style="margin-left:12px">
		</div>
	</div>
	<div class="disScroll">
		<table id="disTable"></table>
	</div>`;
		const script = `
	var vscodeApi = acquireVsCodeApi();
	var running = false;
	var usePc = true;

	function post(type, payload) { vscodeApi.postMessage({ type: type, payload: payload }); }

	function hexAddr(value) { return '$' + (value & 0xffff).toString(16).toUpperCase().padStart(4, '0'); }

	function setBanner(text, isError) {
		var banner = document.getElementById('banner');
		banner.textContent = text;
		banner.className = isError ? 'error' : 'muted';
		banner.style.display = text ? '' : 'none';
	}

	// The 4-digit address edit box uses the shared EditBox widget (same look
	// and behavior as the Registers and Memory windows).
	var addrEditBox = new EditBox(document.getElementById('addrInput'), {
		width: 4,
		valueKind: EDIT_VALUE_KIND.HEX,
		overstrike: true,
		onCommit: function (v) { post('setMode', { useCurrentPc: false, address: v }); }
	});

	function setModeControls(usePc, address) {
		usePc = usePc !== false;
		document.getElementById('modePc').checked = usePc;
		document.getElementById('modeAddr').checked = !usePc;
		var input = document.getElementById('addrInput');
		input.disabled = usePc || running;
		if (!usePc && typeof address === 'number') {
			addrEditBox.setValue(address);
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

	document.getElementById('modePc').addEventListener('change', function () {
		if (this.checked) {
			usePc = true;
			document.getElementById('addrInput').disabled = true;
			post('setMode', { useCurrentPc: true });
		}
	});
	document.getElementById('modeAddr').addEventListener('change', function () {
		if (this.checked) {
			usePc = false;
			document.getElementById('addrInput').disabled = running;
			// Seed the edit box with the last-known start so Enter alone
			// re-issues the same region.
			post('setMode', { useCurrentPc: false, address: addrEditBox.getValue() !== null ? addrEditBox.getValue() : 0 });
		}
	});

	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.type === 'disassembly') { render(msg.payload); }
		else if (msg.type === 'state') {
			running = !!msg.payload.running;
			setBanner(msg.payload.connected ? '' : 'Not connected to the VICE monitor.', false);
			setModeControls(usePc, null);
		}
		else if (msg.type === 'error') { setBanner('Error: ' + msg.payload.message, true); }
	});

	post('refresh');`;
		return this._wrapHtml(_webview, body, script);
	}
}

