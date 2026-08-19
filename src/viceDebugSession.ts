import {
	LoggingDebugSession,
	InitializedEvent,
	StoppedEvent,
	OutputEvent,
	Thread,
	StackFrame,
	Scope,
	Handles
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ViceMonitorClient, ViceProcessLauncher, IViceRegisters } from './viceMonitor';

export interface IViceLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program?: string;
	viceExecutable?: string;
	viceDirectory?: string;
	viceArgs?: string[];
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
	private _currentRegisters: IViceRegisters | null = null;
	private _currentPc = 0x080d;

	public constructor() {
		super('vice-debug.txt');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._monitor = new ViceMonitorClient();
		this._launcher = new ViceProcessLauncher();

		this._monitor.on('stopped', async ({ pc }) => {
			this._currentPc = pc;
			try {
				this._currentRegisters = await this._monitor.getRegisters();
			} catch {}
			this.sendEvent(new StoppedEvent('breakpoint', ViceDebugSession.THREAD_ID));
		});

		this._monitor.on('resumed', ({ pc }) => {
			this._currentPc = pc;
		});

		this._monitor.on('jam', ({ pc }) => {
			this._currentPc = pc;
			this.sendEvent(new OutputEvent(`[VICE] CPU Jammed at PC: $${pc.toString(16).padStart(4, '0').toUpperCase()}\n`, 'stderr'));
			this.sendEvent(new StoppedEvent('exception', ViceDebugSession.THREAD_ID));
		});

		this._monitor.on('disconnected', () => {
			this.sendEvent(new OutputEvent('[VICE] Monitor disconnected.\n', 'console'));
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
		this.sendResponse(response);

		if (this._monitor.isConnected) {
			try {
				this._currentRegisters = await this._monitor.getRegisters();
				this._currentPc = this._currentRegisters.pc;
			} catch {}

			if (this._stopOnDebug) {
				this.sendEvent(new StoppedEvent('entry', ViceDebugSession.THREAD_ID));
			} else {
				try {
					await this._monitor.exitMonitor();
				} catch {}
			}
		} else {
			if (this._stopOnDebug) {
				this.sendEvent(new StoppedEvent('entry', ViceDebugSession.THREAD_ID));
			}
		}
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

		this.sendEvent(
			new OutputEvent(
				`[VICE Debugger] Launching ${viceExecutable} from "${installationDir}" (Monitor: ${host}:${port})\n`,
				'console'
			)
		);

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
			this.sendEvent(new OutputEvent(`[VICE Debugger] Connecting to Binary Monitor at ${host}:${port}...\n`, 'console'));
			await this._monitor.connect(host, port, 12000, 500);
			this.sendEvent(new OutputEvent('[VICE Debugger] Successfully connected to VICE Binary Monitor!\n', 'console'));

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
		const clientBreakpoints = args.breakpoints || [];
		const actualBreakpoints = clientBreakpoints.map((bp, index) => ({
			verified: true,
			line: bp.line,
			id: index + 1
		}));

		response.body = {
			breakpoints: actualBreakpoints
		};
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
				rawMap: new Map()
			};

			const toHex8 = (v: number) => `$${(v & 0xff).toString(16).padStart(2, '0').toUpperCase()} (${v & 0xff})`;
			const toHex16 = (v: number) => `$${(v & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
			const toBin8 = (v: number) => (v & 0xff).toString(2).padStart(8, '0');

			variables.push(
				{ name: 'PC', value: toHex16(regs.pc), variablesReference: 0 },
				{ name: 'A', value: toHex8(regs.a), variablesReference: 0 },
				{ name: 'X', value: toHex8(regs.x), variablesReference: 0 },
				{ name: 'Y', value: toHex8(regs.y), variablesReference: 0 },
				{ name: 'SP', value: toHex8(regs.sp), variablesReference: 0 },
				{ name: 'Flags (NV-BDIZC)', value: `${toBin8(regs.flags)} (${toHex8(regs.flags)})`, variablesReference: 0 }
			);
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
		this.sendResponse(response);
		if (this._monitor.isConnected) {
			try {
				await this._monitor.stepInstruction(true);
			} catch (err: any) {
				this.sendEvent(new OutputEvent(`[VICE step error] ${err?.message || err}\n`, 'stderr'));
			}
		} else {
			this.sendEvent(new StoppedEvent('step', ViceDebugSession.THREAD_ID));
		}
	}

	protected async stepInRequest(
		response: DebugProtocol.StepInResponse,
		_args: DebugProtocol.StepInArguments
	): Promise<void> {
		this.sendResponse(response);
		if (this._monitor.isConnected) {
			try {
				await this._monitor.stepInstruction(false);
			} catch (err: any) {
				this.sendEvent(new OutputEvent(`[VICE step-in error] ${err?.message || err}\n`, 'stderr'));
			}
		} else {
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
}
