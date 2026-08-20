import * as fs from 'fs';
import * as path from 'path';

export interface IPrgInfo {
	loadAddress: number;
	entryAddress: number;
	hasBasicStub: boolean;
	details: string;
}

export interface IDebugLocation {
	file: string;
	line: number;
	address: number;
	endAddress: number;
}

export interface ICc65DebugInfo {
	locations: IDebugLocation[];
	files: Map<number, string>;
}

/**
 * Parses a Commodore 6502 PRG file to determine its load address and entry point.
 */
export function parsePrgHeader(filePath: string): IPrgInfo | null {
	try {
		if (!fs.existsSync(filePath)) {
			return null;
		}

		const buffer = fs.readFileSync(filePath);
		if (buffer.length < 2) {
			return null;
		}

		const loadAddress = buffer.readUInt16LE(0);
		const data = buffer.subarray(2);

		const rawHex = Array.from(buffer.subarray(0, Math.min(buffer.length, 16)))
			.map(b => b.toString(16).padStart(2, '0').toUpperCase())
			.join(' ');

		// Check for standard BASIC start addresses:
		// C64: $0801, C128: $1C01, VIC-20 unexpanded: $1001, VIC-20 expanded: $0401 / $1201, PET: $0401, Plus/4: $1001 / $1201
		const isCommonBasicStart = [0x0801, 0x0401, 0x1001, 0x1201, 0x1c01].includes(loadAddress);

		if (isCommonBasicStart && data.length >= 6) {
			const basicEntry = parseBasicSysAddress(data);
			if (basicEntry !== null) {
				return {
					loadAddress,
					entryAddress: basicEntry.address,
					hasBasicStub: true,
					details: `File size: ${buffer.length} bytes, First 16 bytes: [${rawHex}], BASIC Stub SYS target: ${basicEntry.rawSys} -> $${basicEntry.address.toString(16).padStart(4, '0').toUpperCase()}`
				};
			}
		}

		return {
			loadAddress,
			entryAddress: loadAddress,
			hasBasicStub: false,
			details: `File size: ${buffer.length} bytes, First 16 bytes: [${rawHex}], Raw load address: $${loadAddress.toString(16).padStart(4, '0').toUpperCase()}`
		};
	} catch (err: any) {
		return {
			loadAddress: 0x0801,
			entryAddress: 0x080d,
			hasBasicStub: false,
			details: `Failed to read PRG file: ${err?.message || err}`
		};
	}
}

/**
 * Finds a label in a VICE-style label file (for example, `al 00040E .initialization`).
 * Label files are commonly emitted beside the PRG, but may have any filename.
 */
export function findViceLabelAddress(programPath: string, labelName: string): number | null {
	try {
		const directory = path.dirname(programPath);
		const labelFiles = fs.readdirSync(directory)
			.filter(file => file.toLowerCase().endsWith('.lbl'));
		const wanted = labelName.startsWith('.') ? labelName : `.${labelName}`;
		const pattern = new RegExp(`^\\s*al\\s+([0-9a-fA-F]+)\\s+${escapeRegExp(wanted)}\\s*$`, 'i');

		for (const labelFile of labelFiles) {
			const contents = fs.readFileSync(path.join(directory, labelFile), 'utf8');
			for (const line of contents.split(/\r?\n/)) {
				const match = pattern.exec(line);
				if (match) {
					const address = parseInt(match[1], 16);
					if (address >= 0 && address <= 0xffff) {
						return address;
					}
				}
			}
		}
	} catch (_err) {
		// Label metadata is optional; the caller can fall back to the PRG address.
	}
	return null;
}

/**
 * Reads the line/span portion of a cc65 linker .dbg file.  cc65 uses records
 * such as `file id=1,name="foo.s"`, `span id=1,seg=0,start=...`, and
 * `line file=1,line=...,span=1`.  Unknown records are intentionally ignored.
 */
export function parseCc65DebugFile(filePath: string, baseDirectory = path.dirname(filePath)): ICc65DebugInfo | null {
	try {
		if (!fs.existsSync(filePath)) { return null; }
		const text = fs.readFileSync(filePath, 'utf8');
		const files = new Map<number, string>();
		const segments = new Map<number, number>();
		const spans = new Map<number, { seg: number; start: number; size: number }>();
		const lines: Array<{ file: number; line: number; span: number }> = [];

		for (const raw of text.split(/\r?\n/)) {
			const record = raw.trim();
			const kind = record.split(/\s+/, 1)[0];
			const fields = parseDbgFields(record);
			if (kind === 'file' && isNumber(fields.id) && typeof fields.name === 'string') {
				files.set(fields.id, resolveDebugPath(fields.name, baseDirectory));
			} else if (kind === 'seg' && isNumber(fields.id) && isNumber(fields.start)) {
				segments.set(fields.id, fields.start);
			} else if (kind === 'span' && isNumber(fields.id) && isNumber(fields.seg) && isNumber(fields.start) && isNumber(fields.size)) {
				spans.set(fields.id, { seg: fields.seg, start: fields.start, size: fields.size });
			} else if (kind === 'line' && isNumber(fields.file) && isNumber(fields.line) && isNumber(fields.span)) {
				lines.push({ file: fields.file, line: fields.line, span: fields.span });
			}
		}

		const locations: IDebugLocation[] = [];
		for (const line of lines) {
			const span = spans.get(line.span);
			const file = files.get(line.file);
			if (!span || !file) { continue; }
			const segmentStart = segments.get(span.seg) ?? 0;
			const address = segmentStart + span.start;
			if (address >= 0 && address <= 0xffff && span.size > 0) {
				locations.push({ file, line: line.line, address, endAddress: Math.min(0x10000, address + span.size) });
			}
		}
		return { files, locations };
	} catch (_err) {
		return null;
	}
}

function parseDbgFields(record: string): Record<string, number | string | undefined> {
	const result: Record<string, number | string | undefined> = {};
	const body = record.replace(/^\S+\s*/, '');
	const pattern = /([A-Za-z][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|[^,\s]+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(body)) !== null) {
		const value = match[2];
		if (value.startsWith('"')) {
			try { result[match[1]] = JSON.parse(value); } catch { result[match[1]] = value.slice(1, -1); }
		} else {
			const number = /^\$[0-9a-f]+$/i.test(value) ? parseInt(value.slice(1), 16) : Number(value);
			result[match[1]] = Number.isNaN(number) ? value : number;
		}
	}
	return result;
}

function resolveDebugPath(fileName: string, baseDirectory: string): string {
	return path.normalize(path.isAbsolute(fileName) ? fileName : path.resolve(baseDirectory, fileName));
}

function isNumber(value: number | string | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface IBasicParseResult {
	address: number;
	rawSys: string;
}

/**
 * Parses Commodore BASIC line to find the SYS token (0x9E) and extract the target address.
 */
function parseBasicSysAddress(data: Buffer): IBasicParseResult | null {
	// First 2 bytes: link pointer to next line
	// Next 2 bytes: line number
	// Bytes after: BASIC tokens until 0x00 (end of line)
	let index = 4;
	const maxSearch = Math.min(data.length, 64);

	while (index < maxSearch && data[index] !== 0x00) {
		const byte = data[index];

		// 0x9E is Commodore BASIC token for 'SYS'
		if (byte === 0x9e) {
			index++;
			// Skip whitespace
			while (index < maxSearch && (data[index] === 0x20 || data[index] === 0x09)) {
				index++;
			}

			// Check for hex notation (e.g. $080D)
			if (index < maxSearch && data[index] === 0x24) { // '$'
				index++;
				let hexStr = '';
				while (index < maxSearch && isHexChar(data[index])) {
					hexStr += String.fromCharCode(data[index]);
					index++;
				}
				if (hexStr.length > 0) {
					const addr = parseInt(hexStr, 16);
					if (!isNaN(addr) && addr >= 0 && addr <= 0xffff) {
						return { address: addr, rawSys: `$${hexStr}` };
					}
				}
			} else {
				// Parse decimal digits (e.g. 2061)
				let decStr = '';
				while (index < maxSearch && isDigit(data[index])) {
					decStr += String.fromCharCode(data[index]);
					index++;
				}
				if (decStr.length > 0) {
					const addr = parseInt(decStr, 10);
					if (!isNaN(addr) && addr >= 0 && addr <= 0xffff) {
						return { address: addr, rawSys: decStr };
					}
				}
			}
		} else if (byte === 0x53 && index + 2 < maxSearch && data[index + 1] === 0x59 && data[index + 2] === 0x53) {
			// ASCII 'SYS' in case token was unexpanded
			index += 3;
			while (index < maxSearch && (data[index] === 0x20 || data[index] === 0x09)) {
				index++;
			}
			let decStr = '';
			while (index < maxSearch && isDigit(data[index])) {
				decStr += String.fromCharCode(data[index]);
				index++;
			}
			if (decStr.length > 0) {
				const addr = parseInt(decStr, 10);
				if (!isNaN(addr) && addr >= 0 && addr <= 0xffff) {
					return { address: addr, rawSys: `SYS ${decStr}` };
				}
			}
		}

		index++;
	}

	return null;
}

function isDigit(byte: number): boolean {
	return byte >= 0x30 && byte <= 0x39; // '0' - '9'
}

function isHexChar(byte: number): boolean {
	return (
		(byte >= 0x30 && byte <= 0x39) || // '0' - '9'
		(byte >= 0x41 && byte <= 0x46) || // 'A' - 'F'
		(byte >= 0x61 && byte <= 0x66)    // 'a' - 'f'
	);
}
