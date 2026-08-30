import * as vscode from 'vscode';
import { ViceWebviewPanel } from './basePanel';
import { IViceDebuggerServices } from '../sessionRegistry';

interface IRegisterRow {
	name: string;
	size: number;
	value: number;
}

/**
 * Registers panel: view and edit CPU registers outside the Variables pane.
 * Two-column layout (main CPU registers left, chip registers right) with the
 * P status flags displayed under the P register. Editing is only enabled
 * while the target is stopped (VICE requirement).
 */
export class RegistersPanel extends ViceWebviewPanel {
	public static readonly VIEW_TYPE = 'viceRegisters';
	public static readonly PANEL_KEY = 'registers';

	public constructor(services: IViceDebuggerServices) {
		super(services, RegistersPanel.VIEW_TYPE, 'Registers');
	}

	protected async refresh(): Promise<void> {
		if (!this._services.isConnected) {
			this.post('state', { connected: false });
			return;
		}
		try {
			const registers = await this._services.getRegisters();
			const definitions = this._services.getRegisterDefinitions();
			const rows: IRegisterRow[] = definitions.map(def => ({
				name: def.name,
				size: def.size,
				value: registers.namedMap.get(def.name)?.value ?? 0
			}));
			this.post('registers', { rows });
			this.post('state', { connected: true, running: false });
		} catch (err: any) {
			this.post('error', { message: err?.message || String(err) });
		}
	}

	protected _onWebviewMessage(type: string, payload: any): void {
		if (type === 'refresh') {
			void this.refresh();
		} else if (type === 'setRegister') {
			const name = String(payload?.name ?? '');
			const value = Number(payload?.value ?? 0);
			if (!name || !Number.isFinite(value)) {
				this.post('error', { message: 'Invalid register edit.' });
				return;
			}
			void this._services.setRegisterByName(name, value)
				.then(() => this.refresh())
				.catch((err: any) => this.post('error', { message: err?.message || String(err) }));
		}
	}

	protected _getHtml(_webview: vscode.Webview): string {
		const body = `
	<table id="regTable"></table>`;
		const script = `
	var vscodeApi = acquireVsCodeApi();
	var running = false;
	var LEFT_COLUMN = ['PC', 'A', 'X', 'Y', 'SP', 'P'];
	var RIGHT_COLUMN = ['00', '01', 'LIN', 'CYC'];

	function post(type, payload) { vscodeApi.postMessage({ type: type, payload: payload }); }

	function hex(value, size) {
		var digits = Math.ceil(size / 4);
		return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
	}

	function setBanner(text, isError) {
		var banner = document.getElementById('banner');
		banner.textContent = text;
		banner.className = isError ? 'error' : 'muted';
		banner.style.display = text ? '' : 'none';
	}

	function findRow(rows, name) {
		for (var i = 0; i < rows.length; i++) {
			if (rows[i].name.toUpperCase() === name) { return rows[i]; }
		}
		return null;
	}

	function makeNameCell(name) {
		var td = document.createElement('td');
		td.textContent = name;
		return td;
	}

	function makeRegisterCell(row) {
		var td = document.createElement('td');
		var input = document.createElement('input');
		input.value = hex(row.value, row.size);
		input.size = 6;
		input.disabled = running;
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { commit(input, row); }
		});
		input.addEventListener('blur', function () { input.value = hex(row.value, row.size); });
		td.appendChild(input);
		return td;
	}

	function appendFlagsRow(table, row) {
		var flagTr = document.createElement('tr');
		var flagTd = document.createElement('td');
		flagTd.colSpan = 4;
		['N', 'V', '-', 'B', 'D', 'I', 'Z', 'C'].forEach(function (flagName, index) {
			var bit = 7 - index;
			var label = document.createElement('label');
			label.style.marginRight = '10px';
			var checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.disabled = running;
			checkbox.checked = (row.value & (1 << bit)) !== 0;
			checkbox.addEventListener('change', function () {
				var newValue = checkbox.checked ? (row.value | (1 << bit)) : (row.value & ~(1 << bit));
				post('setRegister', { name: row.name, value: newValue & 0xff });
			});
			label.appendChild(checkbox);
			label.appendChild(document.createTextNode(' ' + flagName));
			flagTd.appendChild(label);
		});
		flagTr.appendChild(flagTd);
		table.appendChild(flagTr);
	}

	function render(rows) {
		var table = document.getElementById('regTable');
		table.innerHTML = '';

		// Left column: main CPU registers in fixed order. Right column: chip
		// registers, plus anything not covered by the fixed lists.
		var left = [];
		LEFT_COLUMN.forEach(function (name) {
			var row = findRow(rows, name);
			if (row) { left.push(row); }
		});
		var right = [];
		RIGHT_COLUMN.forEach(function (name) {
			var row = findRow(rows, name);
			if (row) { right.push(row); }
		});
		rows.forEach(function (row) {
			if (left.indexOf(row) === -1 && right.indexOf(row) === -1) { right.push(row); }
		});

		var rowCount = Math.max(left.length, right.length);
		for (var i = 0; i < rowCount; i++) {
			var tr = document.createElement('tr');
			var leftRow = left[i];
			var rightRow = right[i];

			tr.appendChild(makeNameCell(leftRow ? leftRow.name : ''));
			tr.appendChild(leftRow ? makeRegisterCell(leftRow) : document.createElement('td'));
			tr.appendChild(makeNameCell(rightRow ? rightRow.name : ''));
			tr.appendChild(rightRow ? makeRegisterCell(rightRow) : document.createElement('td'));

			table.appendChild(tr);

			if (leftRow && /^(P|FL|FLAGS|STATUS)$/i.test(leftRow.name)) {
				appendFlagsRow(table, leftRow);
			}
		}
	}

	function commit(input, row) {
		var text = input.value.trim();
		var value = NaN;
		if (text.charAt(0) === '$') { value = parseInt(text.slice(1), 16); }
		else if (/^0x/i.test(text)) { value = parseInt(text.slice(2), 16); }
		else { value = parseInt(text, 16); } // default: hex, the 6502 convention
		if (isNaN(value) || value < 0) {
			input.value = hex(row.value, row.size);
			return;
		}
		var mask = (1 << row.size) - 1;
		post('setRegister', { name: row.name, value: value & mask });
	}

	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.type === 'registers') { render(msg.payload.rows); }
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