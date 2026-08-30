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
	<style>
		/* Shift the whole register table right by ~2 characters. */
		#regTable { margin-left: 16px; }
		/* Halve the shared cell padding between labels and edit boxes. */
		#regTable td { padding-right: 5px; }
		/* Extra gap between the left and right register columns. */
		#regTable td:nth-child(3) { padding-left: 30px; }
	</style>
	<table id="regTable"></table>`;
		const script = `
	var vscodeApi = acquireVsCodeApi();
	var running = false;
	var LEFT_COLUMN = ['PC', 'A', 'X', 'Y', 'SP', '', '00', '01', 'LIN', 'CYC'];
	var FLAG_NAMES = ['N', 'V', '-', 'B', 'D', 'I', 'Z', 'C'];

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
		var digits = Math.ceil(row.size / 4);
		input.value = hex(row.value, row.size);
		input.size = digits + 1;
		input.maxLength = digits;
		input.disabled = running;
		// Overstrike mode: a printable character replaces the character under
		// the cursor instead of being inserted. Non-hex characters are ignored.
		input.addEventListener('keydown', function (e) {
			if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) { return; }
			if (!/^[0-9a-fA-F]$/.test(e.key)) { e.preventDefault(); return; }
			var start = input.selectionStart;
			var end = input.selectionEnd;
			if (start !== null && start === end && start < input.value.length) {
				e.preventDefault();
				var v = input.value.substring(0, start) + e.key.toUpperCase() + input.value.substring(start + 1);
				input.value = v;
				input.setSelectionRange(start + 1, start + 1);
			}
		});
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { commit(input, row); }
			else if (e.key === 'Escape') {
				// Discard edits and restore the register's original value.
				input.value = hex(row.value, row.size);
				input.blur();
			}
		});
		input.addEventListener('blur', function () { input.value = hex(row.value, row.size); });
		td.appendChild(input);
		return td;
	}

	function makeFlagCell(flagsRow, flagName, bit) {
		var td = document.createElement('td');
		var label = document.createElement('td');
		label.textContent = flagName;
		var input = document.createElement('input');
		var flagValue = function () { return (flagsRow.value & (1 << bit)) !== 0 ? '1' : '0'; };
		input.value = flagValue();
		input.size = 1;
		input.maxLength = 1;
		input.disabled = running;
		// Accept only 0 or 1; the typed digit replaces the existing one.
		input.addEventListener('keydown', function (e) {
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
				if (e.key !== '0' && e.key !== '1') { e.preventDefault(); return; }
				e.preventDefault();
				input.value = e.key;
				input.setSelectionRange(1, 1);
			}
		});
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { commitFlag(input, flagsRow, bit); }
			else if (e.key === 'Escape') {
				// Discard edits and restore the flag's original value.
				input.value = flagValue();
				input.blur();
			}
		});
		input.addEventListener('blur', function () { input.value = flagValue(); });
		td.appendChild(input);
		return { labelTd: label, valueTd: td };
	}

	function render(rows) {
		var table = document.getElementById('regTable');
		table.innerHTML = '';

		// Left column: main CPU registers in fixed order ('' = blank row).
		// Right column: the P register followed by one row per status flag.
		var left = [];
		LEFT_COLUMN.forEach(function (name) {
			left.push(name ? findRow(rows, name) : null);
		});
		var flagsRow = findRow(rows, 'P');

		var FLAG_NAMES = ['N', 'V', '-', 'B', 'D', 'I', 'Z', 'C'];

		var rowCount = Math.max(left.length, 1 + 8); // left rows vs P + 8 flags
		for (var i = 0; i < rowCount; i++) {
			var tr = document.createElement('tr');
			var leftRow = left[i];

			// Left column
			if (leftRow) {
				tr.appendChild(makeNameCell(leftRow.name));
				tr.appendChild(makeRegisterCell(leftRow));
			} else {
				tr.appendChild(makeNameCell(''));
				tr.appendChild(document.createElement('td'));
			}

			// Right column
			var rightCells = null;
			if (i === 0) {
				if (flagsRow) { tr.appendChild(makeNameCell('P')); }
				else { tr.appendChild(document.createElement('td')); }
				tr.appendChild(flagsRow ? makeRegisterCell(flagsRow) : document.createElement('td'));
			} else if (flagsRow) {
				var flagIndex = i - 1; // 0..7
				var flagName = FLAG_NAMES[flagIndex];
				var bit = 7 - flagIndex;
				if (flagName) {
					var cells = makeFlagCell(flagsRow, flagName, bit);
					tr.appendChild(cells.labelTd);
					tr.appendChild(cells.valueTd);
				}
			}

			table.appendChild(tr);
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

	function commitFlag(input, flagsRow, bit) {
		var digit = input.value.trim();
		if (digit !== '0' && digit !== '1') {
			input.value = (flagsRow.value & (1 << bit)) !== 0 ? '1' : '0';
			return;
		}
		var newValue = digit === '1'
			? (flagsRow.value | (1 << bit))
			: (flagsRow.value & ~(1 << bit));
		post('setRegister', { name: flagsRow.name, value: newValue & 0xff });
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