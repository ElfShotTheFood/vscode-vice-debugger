import {
	LoggingDebugSession,
	InitializedEvent,
	BreakpointEvent,
	StoppedEvent,
	OutputEvent,
	Thread,
	StackFrame,
	Scope,
	Handles,
	Source
} from '@vscode/debugadapter';
import * as path from 'path';
import { EventEmitter } from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ViceMonitorClient, ViceProcessLauncher, IViceRegisters, IViceRegisterDefinition } from './viceMonitor';
import { findViceLabelAddress, parseCc65DebugFile, parsePrgHeader, IDebugLocation } from './prgReader';
import { IViceDebuggerServices, IDisposable, DebuggerEvent } from './sessionRegistry';

export interface IViceLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program?: string;
	viceExecutable?: string;
	viceDirectory?: string;
	viceArgs?: string[];
	dbgFile?: string;
	stopOnDebug?: boolean;
	stopOnEntry?: boolean;
	viceHost?: string;
	vicePort?: number;
}

export interface IViceAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	viceHost?: string;
	vicePort?: number;
	stopOnDebug?: boolean;
	stopOnEntry?: boolean;
}

export class ViceDebugSession extends LoggingDebugSession {
	private static readonly THREAD_ID = 1;

	private _monitor: ViceMonitorClient;
	private _launcher: ViceProcessLauncher;
	private _variableHandles = new Handles<string>();
	private _stopOnDebug = true;
	private _loadAddress = 0x0801;
	private _checkpointAddress = 0x0801;
	private _waitingForEntry = false;
	private _currentRegisters: IViceRegisters | null = null;
	private _currentPc = 0x080d;
	//private _checkpointStopEventSent = false;
	private _stepRequestPending = false;
	private _debugLocations: IDebugLocation[] = [];
	private _breakpoints = new Map<number, { sourcePath: string; line: number; checkpointId: number; address: number }>();
	private _checkpointToBreakpoint = new Map<number, number>();
	private _pendingBreakpointRequests = new Map<string, DebugProtocol.SourceBreakpoint[]>();
	private _pendingBreakpointIds = new Map<string, number[]>();
	private _currentSource: { path: string; line: number } | null = null;
	private _nextBreakpointId = 1;
	private _debuggerEvents = new EventEmitter();
	private _lastStopReason = '';

	public constructor() {
		super('vice-debug.txt');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._monitor = new ViceMonitorClient();
		this._launcher = new ViceProcessLauncher();

		// Stream all monitor communication to VS Code Debug Console
		this._monitor.onLog = (msg: string) => {
			this.sendEvent(new OutputEvent(msg, 'console'));
		};

		this._monitor.on('registers', (registers: IViceRegisters) => {
			this._currentRegisters = registers;
			this._currentPc = registers.pc;
			const location = this._findLocation(this._currentPc);
			if (location) {
				this._currentSource = { path: location.file, line: location.line };
			}
			this._emitDebuggerEvent('registers', registers);
		});

		this._monitor.on('stopped', ({ pc }) => {
			// VICE supplies post-stop registers asynchronously via REGISTERS_GET.
			// Defer processing so a register packet in the same receive batch is
			// dispatched before VS Code receives the stopped event.
			this._currentPc = pc;
			setImmediate(() => {
				const location = this._findLocation(this._currentPc);
				if (location) {
					this._currentSource = { path: location.file, line: location.line };
				}
				const pcHex = `$${this._currentPc.toString(16).padStart(4, '0').toUpperCase()}`;
				this.sendEvent(new OutputEvent(`[VICE Debugger] Execution STOPPED at PC=${pcHex}\n`, 'console'));
				// VICE may report a checkpoint hit with CHECKPOINT_GET and then also
				// send EVENT_STOPPED. The checkpoint event already generated the DAP
				// stop, so do not make VS Code process the same stop twice.
				//if (this._checkpointStopEventSent) {
				//	this._checkpointStopEventSent = false;
				//	return;
				//}

				const reason = this._waitingForEntry ? 'entry' : (this._stepRequestPending ? 'step' : 'breakpoint');
				this._waitingForEntry = false;
				this._stepRequestPending = false;
				this._lastStopReason = reason;
				this._emitDebuggerEvent('stopped', { pc: this._currentPc });
				this.sendEvent(new StoppedEvent(reason, ViceDebugSession.THREAD_ID));
			});
		});

		this._monitor.on('checkpointHit', ({ checkpointId, address }) => {
			this._currentPc = address;
			this._waitingForEntry = false;
			this._stepRequestPending = false;
			const breakpointId = this._checkpointToBreakpoint.get(checkpointId);
			const location = this._findLocation(address);
			if (location) {
				this._currentSource = { path: location.file, line: location.line };
			}
			const addressHex = `$${address.toString(16).padStart(4, '0').toUpperCase()}`;
			this.sendEvent(new OutputEvent(
				`[VICE Debugger] Recognized checkpoint #${checkpointId} hit at ${addressHex}; notifying VS Code.\n`,
				'console'
			));
			this._emitDebuggerEvent('stopped', { pc: address });
			this._lastStopReason = 'breakpoint';

			// DAP's hitBreakpointIds tells VS Code which breakpoint caused the
			// stop. Use the VICE checkpoint ID as the stable ID for this internal
			// checkpoint, so a corresponding source breakpoint can be highlighted.
			const stoppedEvent = new StoppedEvent('breakpoint', ViceDebugSession.THREAD_ID);
			// The installed DAP typings predate hitBreakpointIds, but VS Code
			// understands this standard StoppedEvent body property on the wire.
			const stoppedBody = stoppedEvent.body as { reason: string; hitBreakpointIds?: number[] };
			if (breakpointId !== undefined) {
				stoppedBody.hitBreakpointIds = [breakpointId];
			}
			//this._checkpointStopEventSent = true;
			this.sendEvent(stoppedEvent);
		});

		this._monitor.on('resumed', ({ pc }) => {
			this._currentPc = pc;
			const pcHex = `$${pc.toString(16).padStart(4, '0').toUpperCase()}`;
			this.sendEvent(new OutputEvent(`[VICE Debugger] Execution RESUMED from PC=${pcHex}\n`, 'console'));
			this._emitDebuggerEvent('resumed', { pc });
		});

		this._monitor.on('jam', ({ pc }) => {
			this._currentPc = pc;
			const pcHex = `$${pc.toString(16).padStart(4, '0').toUpperCase()}`;
			this.sendEvent(new OutputEvent(`[VICE Debugger] CPU JAMMED at PC=${pcHex}\n`, 'stderr'));
			this._lastStopReason = 'exception';
			this._emitDebuggerEvent('jam', { pc });
			this.sendEvent(new StoppedEvent('exception', ViceDebugSession.THREAD_ID));
		});

		this._monitor.on('disconnected', () => {
			this.sendEvent(new OutputEvent('[VICE Debugger] Monitor socket disconnected.\n', 'console'));
			this._emitDebuggerEvent('disconnected', undefined);
		});

		this._monitor.on('error', (err: Error) => {
			this.sendEvent(new OutputEvent(`[VICE Monitor Error] ${err.message}\n`, 'stderr'));
		});
	}

	protected initializeRequest(
		response: DebugProtocol.InitializeResponse,
		_args: DebugProtocol.InitializeRequestArguments
	): void {
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = false;
		response.body.supportsStepBack = false;
		response.body.supportsSetVariable = false;
		response.body.supportsRestartRequest = false;

		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected async configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
		_args: DebugProtocol.ConfigurationDoneArguments
	): Promise<void> {
		this.sendEvent(new OutputEvent('[VICE Debugger] ConfigurationDone received from VS Code.\n', 'console'));
		this.sendResponse(response);
	}

	protected async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: IViceLaunchRequestArguments
	): Promise<void> {
		this._stopOnDebug = args.stopOnDebug ?? args.stopOnEntry ?? true;
		const host = args.viceHost || '127.0.0.1';
		const port = args.vicePort || 6510;
		const viceExecutable = args.viceExecutable || 'x64sc';
		const installationDir = args.viceDirectory || '';

		this.sendEvent(new OutputEvent('========================================\n[VICE Debugger] Starting Debug Session\n========================================\n', 'console'));

		// Inspect target PRG to discover entry point
		if (args.program) {
			this.sendEvent(new OutputEvent(`[VICE Debugger] Inspecting program: "${args.program}"\n`, 'console'));
			const dbgPath = args.dbgFile || path.join(path.dirname(args.program), `${path.basename(args.program, path.extname(args.program))}.dbg`);
			const debugInfo = parseCc65DebugFile(dbgPath);
			this._debugLocations = debugInfo?.locations || [];
			if (debugInfo) {
				this.sendEvent(new OutputEvent(`[VICE Debugger] Loaded ${this._debugLocations.length} source locations from "${dbgPath}".\n`, 'console'));
			} else {
				this.sendEvent(new OutputEvent(`[VICE Debugger Warning] No cc65 debug file found at "${dbgPath}"; source breakpoints cannot be resolved.\n`, 'console'));
			}
			const prgInfo = parsePrgHeader(args.program);
			if (prgInfo) {
				this._loadAddress = prgInfo.loadAddress;
				this._checkpointAddress = findViceLabelAddress(args.program, '.initialization') ?? this._loadAddress;
				const loadHex = `$${prgInfo.loadAddress.toString(16).padStart(4, '0').toUpperCase()}`;
				const entryHex = `$${prgInfo.entryAddress.toString(16).padStart(4, '0').toUpperCase()}`;
				this.sendEvent(new OutputEvent(`[VICE Debugger] PRG Analysis: Load=${loadHex}, Entry=${entryHex}, HasBasicStub=${prgInfo.hasBasicStub}\n[VICE Debugger] Details: ${prgInfo.details}\n`, 'console'));
			} else {
				this._loadAddress = 0x0801;
				this._checkpointAddress = this._loadAddress;
				this.sendEvent(new OutputEvent('[VICE Debugger Warning] Could not parse PRG header, defaulting entry to $080D.\n', 'console'));
			}
		} else {
			this._loadAddress = 0x0801;
			this._checkpointAddress = this._loadAddress;
			this.sendEvent(new OutputEvent('[VICE Debugger Warning] No program specified, defaulting entry to $080D.\n', 'console'));
		}

		try {
			// Spawn VICE emulator process
			this._launcher.launch(
				{
					installationDirectory: installationDir,
					viceExecutable: viceExecutable,
					viceArgs: args.viceArgs,
					program: args.program,
					viceHost: host,
					vicePort: port
				},
				(msg: string) => this.sendEvent(new OutputEvent(msg, 'console'))
			);
			// Connect to binary monitor
			await this._monitor.connect(host, port, 12000, 500);
			this.sendEvent(new OutputEvent('[VICE Debugger] Connected to VICE Binary Monitor.\n', 'console'));
			const registerDefinitions = await this._monitor.getAvailableRegisters();
			this.sendEvent(new OutputEvent(
				`[VICE Debugger] Discovered ${registerDefinitions.length} VICE CPU registers: ${registerDefinitions.map(reg => reg.name).join(', ')}\n`,
				'console'
			));

			if (!args.program) {
				throw new Error('A PRG program path is required for launch.');
			}

			const checkpointHex = `$${this._checkpointAddress.toString(16).padStart(4, '0').toUpperCase()}`;
			const checkpointKind = this._checkpointAddress === this._loadAddress ? 'load-address' : '.initialization label';
			this.sendEvent(new OutputEvent(`[VICE Debugger] Establishing ${checkpointKind} checkpoint at ${checkpointHex} before AUTOSTART...\n`, 'console'));
			const cpId = await this._monitor.setCheckpoint(this._checkpointAddress, this._stopOnDebug, true);
			if (cpId <= 0) {
				throw new Error(`VICE did not return a valid checkpoint ID for ${checkpointHex}.`);
			}
			this._waitingForEntry = this._stopOnDebug;
			const startupLocation = this._findLocation(this._checkpointAddress);
			if (startupLocation) {
				this._currentSource = { path: startupLocation.file, line: startupLocation.line };
			}
			this.sendEvent(new OutputEvent(`[VICE Debugger] Checkpoint #${cpId} verified at ${checkpointHex}.\n`, 'console'));
			await this._installPendingBreakpoints();

			this.sendEvent(new OutputEvent('[VICE Debugger] Starting PRG execution with AUTOSTART(run=true)...\n', 'console'));
			await this._monitor.autostart(args.program, true);

			this.sendResponse(response);
		} catch (err: any) {
			const errorMsg = `Launch failed: ${err?.message || err}`;
			this.sendEvent(new OutputEvent(`[VICE Debugger Error] ${errorMsg}\n`, 'stderr'));
			this.sendErrorResponse(response, 1001, errorMsg);
		}
	}

	protected async attachRequest(
		response: DebugProtocol.AttachResponse,
		args: IViceAttachRequestArguments
	): Promise<void> {
		this._stopOnDebug = args.stopOnDebug ?? args.stopOnEntry ?? true;
		const host = args.viceHost || '127.0.0.1';
		const port = args.vicePort || 6510;

		this.sendEvent(new OutputEvent(`[VICE Debugger] Attaching to monitor at ${host}:${port}\n`, 'console'));

		try {
			await this._monitor.connect(host, port, 8000, 500);
			this.sendEvent(new OutputEvent('[VICE Debugger] Connected to VICE Binary Monitor!\n', 'console'));
			const registerDefinitions = await this._monitor.getAvailableRegisters();
			this.sendEvent(new OutputEvent(
				`[VICE Debugger] Discovered ${registerDefinitions.length} VICE CPU registers: ${registerDefinitions.map(reg => reg.name).join(', ')}\n`,
				'console'
			));
			const attachPingOk = await this._monitor.ping();
			this.sendEvent(new OutputEvent(`[VICE Debugger] PING response: ${attachPingOk ? 'OK' : 'FAILED'}\n`, attachPingOk ? 'console' : 'stderr'));
			this.sendResponse(response);
		} catch (err: any) {
			const errorMsg = `Attach failed: ${err?.message || err}`;
			this.sendEvent(new OutputEvent(`[VICE Debugger Error] ${errorMsg}\n`, 'stderr'));
			this.sendErrorResponse(response, 1002, errorMsg);
		}
	}

	protected async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments
	): Promise<void> {
		const sourcePath = this._sourcePath(args.source);
		const clientBreakpoints = args.breakpoints || [];
		this._pendingBreakpointRequests.set(sourcePath, clientBreakpoints);
		const actualBreakpoints: DebugProtocol.Breakpoint[] = [];
		if (this._monitor.isConnected) {
			this._pendingBreakpointIds.delete(sourcePath);
			actualBreakpoints.push(...await this._replaceBreakpoints(sourcePath, clientBreakpoints));
		} else {
			const breakpointIds = clientBreakpoints.map(() => this._nextBreakpointId++);
			this._pendingBreakpointIds.set(sourcePath, breakpointIds);
			for (const bp of clientBreakpoints) {
				actualBreakpoints.push({
					id: breakpointIds[actualBreakpoints.length],
					verified: false,
					line: bp.line,
					message: 'Waiting for VICE monitor connection.'
				});
			}
		}
		response.body = { breakpoints: actualBreakpoints };
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(ViceDebugSession.THREAD_ID, '6502 CPU')
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		_args: DebugProtocol.StackTraceArguments
	): void {
		const pcHex = `$${this._currentPc.toString(16).padStart(4, '0').toUpperCase()}`;
		const frame = new StackFrame(
			0,
			`PC: ${pcHex}`
		);
		if (this._currentSource) {
			frame.source = new Source(path.basename(this._currentSource.path), this._currentSource.path);
			frame.line = this._currentSource.line;
			frame.column = 1;
		}
		frame.instructionPointerReference = `0x${this._currentPc.toString(16).padStart(4, '0')}`;

		response.body = {
			stackFrames: [frame],
			totalFrames: 1
		};
		this.sendResponse(response);
	}

	protected scopesRequest(
		response: DebugProtocol.ScopesResponse,
		_args: DebugProtocol.ScopesArguments
	): void {
		this._variableHandles.reset();
		const registersRef = this._variableHandles.create('registers');

		response.body = {
			scopes: [
				new Scope('6502 Registers', registersRef, false)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments
	): Promise<void> {
		const handle = this._variableHandles.get(args.variablesReference);
		const variables: DebugProtocol.Variable[] = [];

		if (handle === 'registers') {
			if (this._monitor.isConnected) {
				try {
					this._currentRegisters = await this._monitor.getRegisters();
					this._currentPc = this._currentRegisters.pc;
				} catch {}
			}

			const regs = this._currentRegisters || {
				a: 0x00,
				x: 0x00,
				y: 0x00,
				sp: 0xfd,
				pc: this._currentPc,
				flags: 0x30,
				rawMap: new Map(),
				namedMap: new Map()
			};

			const toHex8 = (v: number) => `$${(v & 0xff).toString(16).padStart(2, '0').toUpperCase()} (${v & 0xff})`;
			const toHex16 = (v: number) => `$${(v & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
			const toBin8 = (v: number) => (v & 0xff).toString(2).padStart(8, '0');

			if (regs.namedMap.size > 0) {
				for (const [name, register] of regs.namedMap) {
					const value = register.value;
					const width = Math.ceil(register.size / 4);
					const isFlags = /^(FL|P|FLAGS|STATUS)$/i.test(name.trim());
					if (name !== '00' && name !== '01') {
						variables.push({
							name: `${name}`,
							value: `$${value.toString(16).padStart(width, '0').toUpperCase()} (${value})`,
							variablesReference: isFlags ? this._variableHandles.create(`flags:${name}`) : 0
						});
					}
				}
			} else {
				variables.push(
					{ name: 'PC', value: toHex16(regs.pc), variablesReference: 0 },
					{ name: 'A', value: toHex8(regs.a), variablesReference: 0 },
					{ name: 'X', value: toHex8(regs.x), variablesReference: 0 },
					{ name: 'Y', value: toHex8(regs.y), variablesReference: 0 },
					{ name: 'SP', value: toHex8(regs.sp), variablesReference: 0 },
					{ name: 'Flags (NV-BDIZC)', value: `${toBin8(regs.flags)} (${toHex8(regs.flags)})`, variablesReference: 0 }
				);
			}
		} else if (typeof handle === 'string' && handle.startsWith('flags:')) {
			const flags = this._currentRegisters?.namedMap.get(handle.slice('flags:'.length));
			const value = flags?.value ?? this._currentRegisters?.flags ?? 0;
			const flagNames: Array<[string, number]> = [
				['N', 7], ['V', 6], ['-', 5], ['B', 4], ['D', 3], ['I', 2], ['Z', 1], ['C', 0]
			];
			for (const [name, bit] of flagNames) {
				variables.push({
					name,
					value: (value & (1 << bit)) !== 0 ? 'set (1)' : 'clear (0)',
					variablesReference: 0  
				});
			}
		}

		response.body = {
			variables
		};
		this.sendResponse(response);
	}

	protected async continueRequest(
		response: DebugProtocol.ContinueResponse,
		_args: DebugProtocol.ContinueArguments
	): Promise<void> {
		this.sendResponse(response);
		if (this._monitor.isConnected) {
			try {
				await this._monitor.exitMonitor();
			} catch (err: any) {
				this.sendEvent(new OutputEvent(`[VICE continue error] ${err?.message || err}\n`, 'stderr'));
			}
		}
	}

	protected async nextRequest(
		response: DebugProtocol.NextResponse,
		_args: DebugProtocol.NextArguments
	): Promise<void> {
		if (this._monitor.isConnected) {
			this._stepRequestPending = true;
			try {
				await this._monitor.stepInstruction(true);
				this.sendResponse(response);
			} catch (err: any) {
				this._stepRequestPending = false;
				this.sendEvent(new OutputEvent(`[VICE step error] ${err?.message || err}\n`, 'stderr'));
				this.sendErrorResponse(response, 1003, `Step over failed: ${err?.message || err}`);
			}
		} else {
			this.sendResponse(response);
			this.sendEvent(new StoppedEvent('step', ViceDebugSession.THREAD_ID));
		}
	}

	protected async stepInRequest(
		response: DebugProtocol.StepInResponse,
		_args: DebugProtocol.StepInArguments
	): Promise<void> {
		if (this._monitor.isConnected) {
			this._stepRequestPending = true;
			try {
				await this._monitor.stepInstruction(false);
				this.sendResponse(response);
			} catch (err: any) {
				this._stepRequestPending = false;
				this.sendEvent(new OutputEvent(`[VICE step-in error] ${err?.message || err}\n`, 'stderr'));
				this.sendErrorResponse(response, 1004, `Step into failed: ${err?.message || err}`);
			}
		} else {
			this.sendResponse(response);
			this.sendEvent(new StoppedEvent('step', ViceDebugSession.THREAD_ID));
		}
	}

	protected async stepOutRequest(
		response: DebugProtocol.StepOutResponse,
		_args: DebugProtocol.StepOutArguments
	): Promise<void> {
		if (this._monitor.isConnected) {
			this._stepRequestPending = true;
			try {
				await this._monitor.stepOut();
				this.sendResponse(response);
			} catch (err: any) {
				this._stepRequestPending = false;
				this.sendEvent(new OutputEvent(`[VICE step-out error] ${err?.message || err}\n`, 'stderr'));
				this.sendErrorResponse(response, 1005, `Step out failed: ${err?.message || err}`);
			}
		} else {
			this.sendResponse(response);
			this.sendEvent(new StoppedEvent('step', ViceDebugSession.THREAD_ID));
		}
	}

	protected disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		_args: DebugProtocol.DisconnectArguments
	): void {
		this._monitor.disconnect();
		this._launcher.terminate();
		this.sendEvent(new OutputEvent('[VICE Debugger] Session terminated.\n', 'console'));
		this.sendResponse(response);
	}

	// ------------------------------------------------------------------
	// Services facade for webview panels (see sessionRegistry.ts).
	// ------------------------------------------------------------------

	private _emitDebuggerEvent(event: DebuggerEvent, payload: any): void {
		this._debuggerEvents.emit('event', event, payload);
	}

	public get isConnected(): boolean {
		return this._monitor.isConnected;
	}

	public async getRegisters(): Promise<IViceRegisters> {
		return this._monitor.getRegisters();
	}

	public getRegisterDefinitions(): IViceRegisterDefinition[] {
		return this._monitor.registerDefinitions;
	}

	public async setRegisterByName(name: string, value: number): Promise<void> {
		const regId = this._monitor.getRegisterIdByName(name);
		if (regId === undefined) {
			throw new Error(`Unknown register '${name}'.`);
		}
		await this._monitor.setRegister(regId, value);
	}

	public async getMemory(startAddr: number, endAddr: number): Promise<Buffer> {
		return this._monitor.getMemory(startAddr, endAddr);
	}

	public async setMemory(address: number, data: Buffer): Promise<void> {
		await this._monitor.setMemory(address, data);
	}

	public getLastStopReason(): string {
		return this._lastStopReason;
	}

	public logOutput(text: string): void {
		this.sendEvent(new OutputEvent(text.endsWith('\n') ? text : text + '\n', 'console'));
	}

	public onDebuggerEvent(listener: (event: DebuggerEvent, payload: any) => void): IDisposable {
		this._debuggerEvents.on('event', listener);
		return {
			dispose: () => this._debuggerEvents.off('event', listener)
		};
	}

	/** View of this session suitable for registration in the session registry. */
	public get services(): IViceDebuggerServices {
		return this;
	}

	private _sourcePath(source: DebugProtocol.Source): string {
		return path.normalize(source.path || source.name || '');
	}

	private _samePath(left: string, right: string): boolean {
		return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
	}

	private _findLocation(address: number): IDebugLocation | null {
		return this._debugLocations.find(location => address >= location.address && address < location.endAddress)
			|| this._debugLocations.find(location => location.address === address)
			|| null;
	}

	private _findSourceLocation(sourcePath: string, line: number): IDebugLocation | null {
		return this._debugLocations.find(location => this._samePath(location.file, sourcePath) && location.line === line) || null;
	}

	private async _replaceBreakpoints(sourcePath: string, requested: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
		const pendingIds = this._pendingBreakpointIds.get(sourcePath);
		this._pendingBreakpointIds.delete(sourcePath);
		for (const [dapId, breakpoint] of this._breakpoints) {
			if (this._samePath(breakpoint.sourcePath, sourcePath)) {
				try { await this._monitor.deleteCheckpoint(breakpoint.checkpointId); } catch {}
				this._checkpointToBreakpoint.delete(breakpoint.checkpointId);
				this._breakpoints.delete(dapId);
			}
		}

		const result: DebugProtocol.Breakpoint[] = [];
		for (const requestedBreakpoint of requested) {
			const location = this._findSourceLocation(sourcePath, requestedBreakpoint.line);
			const dapId = pendingIds?.[result.length] ?? this._nextBreakpointId++;
			if (!location) {
				result.push({ id: dapId, verified: false, line: requestedBreakpoint.line, message: 'No address for this source line in the cc65 .dbg file.' });
				continue;
			}
			try {
				const checkpointId = await this._monitor.setCheckpoint(location.address, true, false);
				this._breakpoints.set(dapId, { sourcePath, line: requestedBreakpoint.line, checkpointId, address: location.address });
				this._checkpointToBreakpoint.set(checkpointId, dapId);
				result.push({ id: dapId, verified: true, line: requestedBreakpoint.line, source: new Source(path.basename(location.file), location.file), instructionReference: `0x${location.address.toString(16).padStart(4, '0')}` });
			} catch (err: any) {
				result.push({ id: dapId, verified: false, line: requestedBreakpoint.line, message: err?.message || String(err) });
			}
		}
		return result;
	}

	private async _installPendingBreakpoints(): Promise<void> {
		for (const [sourcePath, requested] of this._pendingBreakpointRequests) {
			const breakpoints = await this._replaceBreakpoints(sourcePath, requested);
			// VS Code sends source breakpoints during the configuration phase,
			// before launch has connected to VICE.  The initial response therefore
			// reports them as pending; notify the client when their VICE checkpoints
			// have been created so the source margin changes to the verified state.
			for (const breakpoint of breakpoints) {
				this.sendEvent(new BreakpointEvent('changed', breakpoint));
			}
			this.sendEvent(new OutputEvent(`[VICE Debugger] Installed ${breakpoints.filter(bp => bp.verified).length} source breakpoint(s) for ${sourcePath}.\n`, 'console'));
		}
	}
}
