/**
 * Minimal 6502 disassembler.
 *
 * The VICE binary monitor has no disassemble command, so instructions are
 * decoded client-side from raw memory bytes. Only documented (legal) opcodes
 * are decoded; undocumented opcodes render as '???' with a length of 1.
 */

export interface IDisassembledInstruction {
	address: number;
	size: number;
	bytes: number[];
	text: string;
}

type Mode = 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'abx' | 'aby' | 'ind' | 'izx' | 'izy' | 'rel';

// Table indexed by opcode: 'MNEMONIC:mode', or '?' for undocumented opcodes.
const OPCODE_TABLE_SOURCE: string =
	'BRK:imp ORA:izx ? ? ? ORA:zp ASL:zp ? PHP:imp ORA:imm ASL:acc ? ? ORA:abs ASL:abs ? ' +
	'BPL:rel ORA:izy ? ? ? ORA:zpx ASL:zpx ? CLC:imp ORA:aby ? ? ? ORA:abx ASL:abx ? ' +
	'JSR:abs AND:izx ? ? BIT:zp AND:zp ROL:zp ? PLP:imp AND:imm ROL:acc ? BIT:abs AND:abs ROL:abs ? ' +
	'BMI:rel AND:izy ? ? ? AND:zpx ROL:zpx ? SEC:imp AND:aby ? ? ? AND:abx ROL:abx ? ' +
	'RTI:imp EOR:izx ? ? ? EOR:zp LSR:zp ? PHA:imp EOR:imm LSR:acc ? JMP:abs EOR:abs LSR:abs ? ' +
	'BVC:rel EOR:izy ? ? ? EOR:zpx LSR:zpx ? CLI:imp EOR:aby ? ? ? EOR:abx LSR:abx ? ' +
	'RTS:imp ADC:izx ? ? ? ADC:zp ROR:zp ? PLA:imp ADC:imm ROR:acc ? JMP:ind ADC:abs ROR:abs ? ' +
	'BVS:rel ADC:izy ? ? ? ADC:zpx ROR:zpx ? SEI:imp ADC:aby ? ? ? ADC:abx ROR:abx ? ' +
	'? ? ? ? STY:zp STA:zp STX:zp ? DEY:imp ? TXA:imp ? STY:abs STA:abs STX:abs ? ' +
	'BCC:rel STA:izy ? ? STY:zpx STA:zpx STX:zpy ? TYA:imp STA:aby TXS:imp ? ? STA:abx ? ? ' +
	'LDY:imm LDA:izx LDX:imm ? LDY:zp LDA:zp LDX:zp ? TAY:imp LDA:imm TAX:imp ? LDY:abs LDA:abs LDX:abs ? ' +
	'BCS:rel LDA:izy ? ? LDY:zpx LDA:zpx LDX:zpy ? CLV:imp LDA:aby TSX:imp ? LDY:abx LDA:abx LDX:aby ? ' +
	'CPY:imm CMP:izx ? ? CPY:zp CMP:zp DEC:zp ? INY:imp CMP:imm DEX:imp ? CPY:abs CMP:abs DEC:abs ? ' +
	'BNE:rel CMP:izy ? ? ? CMP:zpx DEC:zpx ? CLD:imp CMP:aby ? ? ? CMP:abx DEC:abx ? ' +
	'CPX:imm SBC:izx ? ? CPX:zp SBC:zp INC:zp ? INX:imp SBC:imm NOP:imp ? CPX:abs SBC:abs INC:abs ? ' +
	'BEQ:rel SBC:izy ? ? ? SBC:zpx INC:zpx ? SED:imp SBC:aby ? ? ? SBC:abx INC:abx ?';

const OPCODE_TABLE: Array<[string, Mode] | null> = OPCODE_TABLE_SOURCE
	.trim()
	.split(/\s+/)
	.map(token => token === '?' ? null : token.split(':') as [string, Mode]);

function hex16(value: number): string {
	return `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

function hex8(value: number): string {
	return `$${(value & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Disassemble a buffer of memory bytes.
 *
 * @param data Raw memory bytes.
 * @param startAddress Address of data[0]. The buffer may wrap past $FFFF;
 *        addresses are masked to 16 bits.
 */
export function disassemble(data: Buffer, startAddress: number): IDisassembledInstruction[] {
	const instructions: IDisassembledInstruction[] = [];
	let offset = 0;

	while (offset < data.length) {
		const address = (startAddress + offset) & 0xffff;
		const opcode = data[offset];
		const definition = OPCODE_TABLE[opcode];
		let size = 1;
		let text = '??? ' + hex8(opcode);

		if (definition) {
			const [mnemonic, mode] = definition;
			switch (mode) {
				case 'imp':
					size = 1;
					text = mnemonic;
					break;
				case 'acc':
					size = 1;
					text = `${mnemonic} A`;
					break;
				case 'imm':
					size = 2;
					text = `${mnemonic} #${hex8(data[offset + 1] ?? 0)}`;
					break;
				case 'zp':
					size = 2;
					text = `${mnemonic} ${hex8(data[offset + 1] ?? 0)}`;
					break;
				case 'zpx':
					size = 2;
					text = `${mnemonic} ${hex8(data[offset + 1] ?? 0)},X`;
					break;
				case 'zpy':
					size = 2;
					text = `${mnemonic} ${hex8(data[offset + 1] ?? 0)},Y`;
					break;
				case 'abs':
					size = 3;
					text = `${mnemonic} ${hex16(data[offset + 1] | ((data[offset + 2] ?? 0) << 8))}`;
					break;
				case 'abx':
					size = 3;
					text = `${mnemonic} ${hex16(data[offset + 1] | ((data[offset + 2] ?? 0) << 8))},X`;
					break;
				case 'aby':
					size = 3;
					text = `${mnemonic} ${hex16(data[offset + 1] | ((data[offset + 2] ?? 0) << 8))},Y`;
					break;
				case 'ind':
					size = 3;
					text = `${mnemonic} (${hex16(data[offset + 1] | ((data[offset + 2] ?? 0) << 8))})`;
					break;
				case 'izx':
					size = 2;
					text = `${mnemonic} (${hex8(data[offset + 1] ?? 0)},X)`;
					break;
				case 'izy':
					size = 2;
					text = `${mnemonic} (${hex8(data[offset + 1] ?? 0)}),Y`;
					break;
				case 'rel': {
					size = 2;
					const raw = data[offset + 1] ?? 0;
					const displacement = raw < 0x80 ? raw : raw - 0x100;
					const target = (address + 2 + displacement) & 0xffff;
					text = `${mnemonic} ${hex16(target)}`;
					break;
				}
			}
		}

		const bytes: number[] = [];
		for (let i = 0; i < size && offset + i < data.length; i++) {
			bytes.push(data[offset + i]);
		}

		instructions.push({ address, size, bytes, text });
		offset += size;
	}

	return instructions;
}
