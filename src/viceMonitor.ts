import * as net from 'net';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

export const VICE_MONITOR_COMMAND = {
	MEMORY_GET: 0x01,
	MEMORY_SET: 0x02,
	CHECKPOINT_GET: 0x11,
	CHECKPOINT_SET: 0x12,
	CHECKPOINT_DELETE: 0x13,
	CHECKPOINT_LIST: 0x14,
	CHECKPOINT_TOGGLE: 0x15,
	CONDITION_SET: 0x22,
	REGISTERS_GET: 0x31,
	REGISTERS_SET: 0x32,
	DUMP: 0x41,
	UNDUMP: 0x42,
	RESOURCE_GET: 0x51,
	RESOURCE_SET: 0x52,
	ADVANCE_INSTRUCTION: 0x71,
	KEYBOARD_FEED: 0x72,
	EXECUTE_UNTIL_RETURN: 0x73,
	PING: 0x81,
	BANKS_AVAILABLE: 0x82,
	REGISTERS_AVAILABLE: 0x83,
	EXIT_MONITOR: 0xaa,
	QUIT: 0xbb,
	RESET: 0xcc,
	AUTOSTART: 0xdd,
	// Response & Event codes
	RESPONSE_OK: 0x00,
	EVENT_JAM: 0x61,
	EVENT_STOPPED: 0x62,
	EVENT_RESUMED: 0x63
} as const;

export function getCommandName(commandType: number): string {
	switch (commandType) {
		case 0x01: return 'MEMORY_GET (0x01)';
		case 0x02: return 'MEMORY_SET (0x02)';
		case 0x11: return 'CHECKPOINT_GET (0x11)';
		case 0x12: return 'CHECKPOINT_SET (0x12)';
		case 0x13: return 'CHECKPOINT_DELETE (0x13)';
		case 0x14: return 'CHECKPOINT_LIST (0x14)';
		case 0x15: return 'CHECKPOINT_TOGGLE (0x15)';
		case 0x22: return 'CONDITION_SET (0x22)';
		case 0x31: return 'REGISTERS_GET (0x31)';
		case 0x32: return 'REGISTERS_SET (0x32)';
		case 0x41: return 'DUMP (0x41)';
		case 0x42: return 'UNDUMP (0x42)';
		case 0x51: return 'RESOURCE_GET (0x51)';
		case 0x52: return 'RESOURCE_SET (0x52)';
		case 0x71: return 'ADVANCE_INSTRUCTION (0x71)';
		case 0x72: return 'KEYBOARD_FEED (0x72)';
		case 0x73: return 'EXECUTE_UNTIL_RETURN (0x73)';
		case 0x81: return 'PING (0x81)';
		case 0x82: return 'BANKS_AVAILABLE (0x82)';
		case 0x83: return 'REGISTERS_AVAILABLE (0x83)';
		case 0xaa: return 'EXIT (0xAA)';
		case 0xbb: return 'QUIT (0xBB)';
		case 0xcc: return 'RESET (0xCC)';
		case 0xdd: return 'AUTOSTART (0xDD)';
		case 0x61: return 'EVENT_JAM (0x61)';
		case 0x62: return 'EVENT_STOPPED (0x62)';
		case 0x63: return 'EVENT_RESUMED (0x63)';
		case 0x00: return 'RESPONSE_OK (0x00)';
		default: return `UNKNOWN (0x${commandType.toString(16).padStart(2, '0').toUpperCase()})`;
	}
}

export function bufferToHex(buf: Buffer, maxBytes = 64): string {
	const slice = buf.subarray(0, maxBytes);
	const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
	return buf.length > maxBytes ? `${hex} ... (${buf.length} bytes total)` : `${hex} (${buf.length} bytes)`;
}

export interface IViceRegisters {
	a: number;
	x: number;
	y: number;
	sp: number;
	pc: number;
	flags: number;
	rawMap: Map<number, number>;
}

export interface IViceMonitorResponse {
	requestId: number;
	commandType: number;
	errorCode: number;
	body: Buffer;
}

export class ViceMonitorClient extends EventEmitter {
	private _socket: net.Socket | null = null;
	private _requestId = 1;
	private _pendingRequests = new Map<number, {
		commandType: number;
		resolve: (resp: IViceMonitorResponse) => void;
		reject: (err: Error) => void;
		timeoutTimer: NodeJS.Timeout
	}>();
	private _receiveBuffer = Buffer.alloc(0);
	private _isConnected = false;
	private _logClockWallMs: number | undefined;
	private _logClockHrtimeNs: bigint | undefined;

	public onLog?: (message: string) => void;

	public get isConnected(): boolean {
		return this._isConnected;
	}

	private _log(msg: string): void {
		if (this.onLog) {
			// Anchor a wall-clock timestamp to a monotonic high-resolution clock.
			// Combining Date.now() with an unrelated hrtime remainder can make
			// timestamps appear to go backwards, especially near a millisecond
			// boundary. The anchor preserves wall-clock time while hrtime keeps
			// subsequent timestamps ordered and gives them microsecond precision.
			const currentHrtimeNs = process.hrtime.bigint();
			if (this._logClockWallMs === undefined || this._logClockHrtimeNs === undefined) {
				this._logClockWallMs = Date.now();
				this._logClockHrtimeNs = currentHrtimeNs;
			}
			const elapsedMicros = (currentHrtimeNs - this._logClockHrtimeNs) / 1000n;
			const wallClockMicros = BigInt(this._logClockWallMs) * 1000n + elapsedMicros;
			const seconds = wallClockMicros / 1000000n;
			const micros = wallClockMicros % 1000000n;
			const timestampDate = new Date(Number(seconds) * 1000);
			const timestamp = `${timestampDate.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)}.${micros.toString().padStart(6, '0')}`;
			const timestamped = msg.split(/(?<=\n)/).map(line => {
				if (!line) { return line; }
				const content = line.endsWith('\n') ? line.slice(0, -1) : line;
				return `[${timestamp}] ${content}${line.endsWith('\n') ? '\n' : ''}`;
			}).join('');
			this.onLog(timestamped.endsWith('\n') ? timestamped : timestamped + '\n');
		}
	}

	public async connect(host: string, port: number, timeoutMs = 12000, retryIntervalMs = 500): Promise<void> {
		const startTime = Date.now();
		let attempt = 0;

		while (Date.now() - startTime < timeoutMs) {
			attempt++;
			try {
				this._log(`[VICE Monitor] Connection attempt #${attempt} to ${host}:${port}...`);
				await this._attemptConnect(host, port);
				this._isConnected = true;
				this._log(`[VICE Monitor] Connected to ${host}:${port} on attempt #${attempt}!`);
				this.emit('connected');
				return;
			} catch (_err: any) {
				await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
			}
		}

		throw new Error(`Failed to connect to VICE Binary Monitor at ${host}:${port} within ${timeoutMs}ms.`);
	}

	private _attemptConnect(host: string, port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = new net.Socket();

			const onConnect = () => {
				cleanup();
				this._socket = socket;
				this._socket.on('data', data => this._onDataReceived(data));
				this._socket.on('close', () => this._onClose());
				this._socket.on('error', err => this._onError(err));
				resolve();
			};

			const onError = (err: Error) => {
				cleanup();
				socket.destroy();
				reject(err);
			};

			const cleanup = () => {
				socket.removeListener('connect', onConnect);
				socket.removeListener('error', onError);
			};

			socket.once('connect', onConnect);
			socket.once('error', onError);
			socket.connect(port, host);
		});
	}

	public disconnect(): void {
		if (this._socket) {
			this._socket.destroy();
			this._socket = null;
		}
		this._cleanupPending(new Error('Monitor client disconnected.'));
		this._isConnected = false;
	}

	public sendCommand(commandType: number, body: Buffer = Buffer.alloc(0), timeoutMs = 5000): Promise<IViceMonitorResponse> {
		if (!this._socket || !this._isConnected) {
			return Promise.reject(new Error('VICE monitor client is not connected.'));
		}

		const reqId = this._requestId++;
		if (this._requestId > 0xffffffff) {
			this._requestId = 1;
		}

		// Request Header (11 bytes for API Version 2):
		// [0]: 0x02 (STX)
		// [1]: 0x02 (API Version 2)
		// [2..5]: Body Length (uint32 LE)
		// [6..9]: Request ID (uint32 LE)
		// [10]: Command Type (uint8)
		const header = Buffer.alloc(11);
		header[0] = 0x02; // STX
		header[1] = 0x02; // Version
		header.writeUInt32LE(body.length, 2);
		header.writeUInt32LE(reqId, 6);
		header[10] = commandType;

		const packet = Buffer.concat([header, body]);

		this._log(`[VICE RAW OUT] Req #${reqId} (${getCommandName(commandType)}) Total ${packet.length}B: ${bufferToHex(packet, packet.length)}`);

		return new Promise<IViceMonitorResponse>((resolve, reject) => {
			const timeoutTimer = setTimeout(() => {
				this._pendingRequests.delete(reqId);
				const err = new Error(`Timeout waiting for response to ${getCommandName(commandType)} (Req #${reqId})`);
				this._log(`[VICE Monitor ERROR] ${err.message}`);
				reject(err);
			}, timeoutMs);

			this._pendingRequests.set(reqId, { commandType, resolve, reject, timeoutTimer });
			this._socket!.write(packet);
		});
	}

	public async ping(): Promise<boolean> {
		const res = await this.sendCommand(VICE_MONITOR_COMMAND.PING);
		return res.errorCode === 0;
	}

	public async exitMonitor(): Promise<void> {
		await this.sendCommand(VICE_MONITOR_COMMAND.EXIT_MONITOR);
	}

	/** Load a PRG through VICE's binary-monitor AUTOSTART command and run it. */
	public async autostart(programPath: string, run = true): Promise<void> {
		const filename = Buffer.from(programPath, 'utf8');
		if (filename.length > 255) {
			throw new Error('VICE AUTOSTART filename is limited to 255 bytes.');
		}
		const body = Buffer.alloc(4 + filename.length);
		body[0] = run ? 1 : 0;
		body.writeUInt16LE(0, 1); // file index: normal filesystem path
		body[3] = filename.length;
		filename.copy(body, 4);
		await this.sendCommand(VICE_MONITOR_COMMAND.AUTOSTART, body);
	}

	public async stepInstruction(stepOver = false): Promise<void> {
		const body = Buffer.alloc(3);
		body[0] = stepOver ? 0x01 : 0x00;
		body.writeUInt16LE(1, 1);
		await this.sendCommand(VICE_MONITOR_COMMAND.ADVANCE_INSTRUCTION, body);
	}

	public async stepOut(): Promise<void> {
		await this.sendCommand(VICE_MONITOR_COMMAND.EXECUTE_UNTIL_RETURN);
	}

	public async setCheckpoint(address: number, stopWhenHit = true, isTemp = false): Promise<number> {
		// VICE CHECKPOINT_SET body is exactly 9 bytes:
		// 0..1: start_addr (uint16 LE)
		// 2..3: end_addr (uint16 LE)
		// 4: stop_when_hit (uint8)
		// 5: enabled (uint8)
		// 6: cpu_operation (uint8: 1=exec, 2=load, 4=store)
		// 7: temporary (uint8)
		// 8: memspace (uint8: 0=main CPU)
		const body = Buffer.alloc(9);
		body.writeUInt16LE(address, 0);
		body.writeUInt16LE(address, 2);
		body[4] = stopWhenHit ? 0x01 : 0x00;
		body[5] = 0x01; // enabled
		body[6] = 0x01; // CPU Exec
		body[7] = isTemp ? 0x01 : 0x00;
		body[8] = 0x00; // memspace (main CPU)

		const resp = await this.sendCommand(VICE_MONITOR_COMMAND.CHECKPOINT_SET, body);
		if (resp.body.length >= 4) {
			const cpId = resp.body.readUInt32LE(0);
			this._log(`[VICE Monitor] Checkpoint created successfully at $${address.toString(16).padStart(4, '0').toUpperCase()} -> Checkpoint ID ${cpId}`);
			return cpId;
		}
		return 0;
	}

	public async deleteCheckpoint(checkpointId: number): Promise<void> {
		const body = Buffer.alloc(4);
		body.writeUInt32LE(checkpointId, 0);
		await this.sendCommand(VICE_MONITOR_COMMAND.CHECKPOINT_DELETE, body);
	}

	public async listCheckpoints(): Promise<any[]> {
		const resp = await this.sendCommand(VICE_MONITOR_COMMAND.CHECKPOINT_LIST);
		const checkpoints: any[] = [];
		if (resp.body.length >= 4) {
			const count = resp.body.readUInt32LE(0);
			this._log(`[VICE Monitor] Active checkpoints in VICE: ${count}`);
		}
		return checkpoints;
	}

	public async getRegisters(memspace = 0): Promise<IViceRegisters> {
		const body = Buffer.alloc(1);
		body[0] = memspace; // 0 = main CPU

		const resp = await this.sendCommand(VICE_MONITOR_COMMAND.REGISTERS_GET, body);
		const result: IViceRegisters = {
			a: 0,
			x: 0,
			y: 0,
			sp: 0xff,
			pc: 0,
			flags: 0,
			rawMap: new Map()
		};

		if (resp.body.length >= 2) {
			const count = resp.body.readUInt16LE(0);
			let offset = 2;
			for (let i = 0; i < count && offset + 3 <= resp.body.length; i++) {
				const itemSize = resp.body[offset];
				const regId = resp.body[offset + 1];
				const regVal = resp.body.readUInt16LE(offset + 2);

				result.rawMap.set(regId, regVal);

				switch (regId) {
					case 0x00: result.a = regVal & 0xff; break;
					case 0x01: result.x = regVal & 0xff; break;
					case 0x02: result.y = regVal & 0xff; break;
					case 0x03: result.pc = regVal; break;
					case 0x04: result.sp = regVal & 0xff; break;
					case 0x05: result.flags = regVal & 0xff; break;
				}

				offset += (itemSize > 0 ? itemSize : 4);
			}
		}

		return result;
	}

	public async getMemory(startAddr: number, endAddr: number, memspace = 0, bankId = 0): Promise<Buffer> {
		const body = Buffer.alloc(8);
		body[0] = 0x00; // sidefx = false
		body.writeUInt16LE(startAddr, 1);
		body.writeUInt16LE(endAddr, 3);
		body[5] = memspace;
		body.writeUInt16LE(bankId, 6);

		const resp = await this.sendCommand(VICE_MONITOR_COMMAND.MEMORY_GET, body);
		if (resp.body.length >= 2) {
			const length = resp.body.readUInt16LE(0);
			return resp.body.subarray(2, 2 + length);
		}
		return Buffer.alloc(0);
	}

	private _onDataReceived(chunk: Buffer): void {
		this._log(`[VICE RAW IN] ${chunk.length} bytes: ${bufferToHex(chunk, chunk.length)}`);
		this._receiveBuffer = Buffer.concat([this._receiveBuffer, chunk]);

		while (this._receiveBuffer.length >= 12) {
			if (this._receiveBuffer[0] !== 0x02) {
				const nextStx = this._receiveBuffer.indexOf(0x02, 1);
				if (nextStx === -1) {
					this._receiveBuffer = Buffer.alloc(0);
					return;
				}
				this._receiveBuffer = this._receiveBuffer.subarray(nextStx);
				if (this._receiveBuffer.length < 12) {
					return;
				}
			}

			const bodyLength = this._receiveBuffer.readUInt32LE(2);
			const responseType = this._receiveBuffer[6];
			const errorCode = this._receiveBuffer[7];
			const reqId = this._receiveBuffer.readUInt32LE(8);
			const totalPacketLength = 12 + bodyLength;

			if (this._receiveBuffer.length < totalPacketLength) {
				return;
			}

			const body = this._receiveBuffer.subarray(12, totalPacketLength);
			this._receiveBuffer = this._receiveBuffer.subarray(totalPacketLength);

			this._handlePacket(responseType, errorCode, reqId, body);
		}
	}

	private _handlePacket(responseType: number, errorCode: number, reqId: number, body: Buffer): void {
		this._log(`[VICE Decoded Header] RespType=0x${responseType.toString(16).padStart(2, '0')} (${getCommandName(responseType)}), ErrorCode=0x${errorCode.toString(16).padStart(2, '0')}, ReqId=${reqId}, BodyLength=${body.length}`);

			// Asynchronous events use request ID 0xffffffff.
		if (responseType === VICE_MONITOR_COMMAND.EVENT_STOPPED) {
			const pc = body.length >= 2 ? body.readUInt16LE(0) : 0;
			const pcHex = `$${pc.toString(16).padStart(4, '0').toUpperCase()}`;
			this._log(`[VICE Monitor EVENT] EVENT_STOPPED (0xEF) at PC=${pcHex}`);
			this.emit('stopped', { pc });
			return;
		}

		if (responseType === VICE_MONITOR_COMMAND.EVENT_RESUMED) {
			const pc = body.length >= 2 ? body.readUInt16LE(0) : 0;
			const pcHex = `$${pc.toString(16).padStart(4, '0').toUpperCase()}`;
			this._log(`[VICE Monitor EVENT] EVENT_RESUMED (0xF1) at PC=${pcHex}`);
			this.emit('resumed', { pc });
			return;
		}

		if (responseType === VICE_MONITOR_COMMAND.EVENT_JAM) {
			const pc = body.length >= 2 ? body.readUInt16LE(0) : 0;
			const pcHex = `$${pc.toString(16).padStart(4, '0').toUpperCase()}`;
			this._log(`[VICE Monitor EVENT] EVENT_JAM (0xEE) at PC=${pcHex}`);
			this.emit('jam', { pc });
			return;
		}

		// Correlate with pending request
		const pending = this._pendingRequests.get(reqId);
		if (pending) {
			this._pendingRequests.delete(reqId);
			clearTimeout(pending.timeoutTimer);

			this._log(`[VICE Monitor RX] Req #${reqId} matched! ErrorCode=0x${errorCode.toString(16).padStart(2, '0')} | Payload (${body.length}B): ${bufferToHex(body)}`);

			if (errorCode !== 0) {
				pending.reject(new Error(`VICE monitor command ${getCommandName(pending.commandType)} failed with error 0x${errorCode.toString(16).padStart(2, '0')}.`));
				return;
			}

			pending.resolve({
				requestId: reqId,
				commandType: pending.commandType,
				errorCode,
				body
			});
		} else {
			this._log(`[VICE Monitor RX] Uncorrelated Packet: RespType=0x${responseType.toString(16).padStart(2, '0')}, Req #${reqId}`);
		}
	}

	private _onClose(): void {
		this._isConnected = false;
		this._log('[VICE Monitor] Socket closed.');
		this._cleanupPending(new Error('Monitor socket closed.'));
		this.emit('disconnected');
	}

	private _onError(err: Error): void {
		this._log(`[VICE Monitor Socket Error] ${err.message}`);
		this.emit('error', err);
	}

	private _cleanupPending(err: Error): void {
		for (const [, req] of this._pendingRequests) {
			clearTimeout(req.timeoutTimer);
			req.reject(err);
		}
		this._pendingRequests.clear();
	}
}

export interface IViceLaunchOptions {
	installationDirectory?: string;
	viceExecutable?: string;
	viceArgs?: string[];
	program?: string;
	viceHost?: string;
	vicePort?: number;
}

export class ViceProcessLauncher {
	private _process: cp.ChildProcess | null = null;

	public get isRunning(): boolean {
		return this._process !== null && !this._process.killed;
	}

	public resolveExecutablePath(installationDirectory?: string, viceExecutable = 'x64sc'): string {
		let exeName = viceExecutable.trim();
		if (process.platform === 'win32' && !exeName.toLowerCase().endsWith('.exe')) {
			exeName += '.exe';
		}

		if (path.isAbsolute(exeName)) {
			return exeName;
		}

		if (installationDirectory && installationDirectory.trim().length > 0) {
			const binDir = path.join(installationDirectory.trim(), 'bin');
			const fullPath = path.join(binDir, exeName);
			return fullPath;
		}

		return exeName;
	}

	public launch(options: IViceLaunchOptions, outputCallback?: (text: string) => void): cp.ChildProcess {
		const exePath = this.resolveExecutablePath(options.installationDirectory, options.viceExecutable);
		const port = options.vicePort || 6510;
		const host = options.viceHost || '127.0.0.1';

		if (options.installationDirectory && !fs.existsSync(exePath)) {
			const msg = `VICE executable not found at: "${exePath}". Please check your 'vice.installationDirectory' setting or 'viceExecutable' launch configuration.`;
			if (outputCallback) { outputCallback(`${msg}\n`); }
			throw new Error(msg);
		}

		const args: string[] = [
			'-binarymonitor',
			'-binarymonitoraddress',
			`${host}:${port}`,
			...(options.viceArgs || [])
		];

		// Do not pass -autostart here. The debug session must first connect to
		// the monitor and install its entry checkpoint. It invokes AUTOSTART
		// explicitly after that checkpoint has been created.
		if (options.program && !fs.existsSync(options.program.trim()) && outputCallback) {
			outputCallback(`[VICE Launcher Warning] Program file not found: "${options.program.trim()}"\n`);
		}

		if (outputCallback) {
			outputCallback(`[VICE Launcher] Spawning: "${exePath}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}\n`);
		}

		this._process = cp.spawn(exePath, args, {
			detached: false,
			shell: false
		});

		this._process.stdout?.on('data', data => {
			if (outputCallback) {
				outputCallback(`[VICE stdout] ${data.toString()}`);
			}
		});

		this._process.stderr?.on('data', data => {
			if (outputCallback) {
				outputCallback(`[VICE stderr] ${data.toString()}`);
			}
		});

		this._process.on('error', err => {
			if (outputCallback) {
				outputCallback(`[VICE process error] ${err.message}\n`);
			}
		});

		this._process.on('exit', (code, signal) => {
			if (outputCallback) {
				outputCallback(`[VICE process exit] Exited with code ${code}, signal ${signal}\n`);
			}
			this._process = null;
		});

		return this._process;
	}

	public terminate(): void {
		if (this._process) {
			try {
				if (process.platform === 'win32') {
					cp.execSync(`taskkill /pid ${this._process.pid} /T /F`);
				} else {
					this._process.kill('SIGTERM');
				}
			} catch (_e) {
				try {
					this._process.kill();
				} catch {}
			}
			this._process = null;
		}
	}
}
