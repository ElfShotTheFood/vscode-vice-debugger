import * as fs from 'fs';

export interface IPrgInfo {
	loadAddress: number;
	entryAddress: number;
	hasBasicStub: boolean;
	details: string;
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
