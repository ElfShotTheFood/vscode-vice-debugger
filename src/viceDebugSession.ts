import {
	LoggingDebugSession,
	InitializedEvent,
	StoppedEvent,
	OutputEvent,
	Thread,
	StackFrame,
	Scope,
	Source,
	Handles
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

export interface IViceLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program?: string;
	stopOnEntry?: boolean;
	viceHost?: string;
	vicePort?: number;
}

export interface IViceAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	viceHost?: string;
	vicePort?: number;
	stopOnEntry?: boolean;
}

export class ViceDebugSession extends LoggingDebugSession {
	private static readonly THREAD_ID = 1;
	private _variableHandles = new Handles<string>();

	public constructor() {
		super('vice-debug.txt');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
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

	protected configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
		_args: DebugProtocol.ConfigurationDoneArguments
	): void {
		this.sendResponse(response);
		// Stop on entry when debugging begins
		this.sendEvent(new StoppedEvent('entry', ViceDebugSession.THREAD_ID));
	}

	protected launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: IViceLaunchRequestArguments
	): void {
		this.sendEvent(new OutputEvent(`[VICE Debugger] Launch requested for: ${args.program || 'unspecified'}\n`, 'console'));
		this.sendResponse(response);
	}

	protected attachRequest(
		response: DebugProtocol.AttachResponse,
		args: IViceAttachRequestArguments
	): void {
		const host = args.viceHost || '127.0.0.1';
		const port = args.vicePort || 6510;
		this.sendEvent(new OutputEvent(`[VICE Debugger] Attaching to monitor at ${host}:${port}\n`, 'console'));
		this.sendResponse(response);
	}

	protected setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments
	): void {
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
		response.body = {
			stackFrames: [
				new StackFrame(
					0,
					'Reset / Entry',
					new Source('main.s', 'main.s'),
					1,
					1
				)
			],
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

	protected variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments
	): void {
		const handle = this._variableHandles.get(args.variablesReference);
		const variables: DebugProtocol.Variable[] = [];

		if (handle === 'registers') {
			variables.push(
				{ name: 'A', value: '$00', variablesReference: 0 },
				{ name: 'X', value: '$00', variablesReference: 0 },
				{ name: 'Y', value: '$00', variablesReference: 0 },
				{ name: 'SP', value: '$FD', variablesReference: 0 },
				{ name: 'PC', value: '$080D', variablesReference: 0 },
				{ name: 'NV-BDIZC', value: '00110000', variablesReference: 0 }
			);
		}

		response.body = {
			variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(
		response: DebugProtocol.ContinueResponse,
		_args: DebugProtocol.ContinueArguments
	): void {
		this.sendResponse(response);
	}

	protected nextRequest(
		response: DebugProtocol.NextResponse,
		_args: DebugProtocol.NextArguments
	): void {
		this.sendResponse(response);
		this.sendEvent(new StoppedEvent('step', ViceDebugSession.THREAD_ID));
	}

	protected stepInRequest(
		response: DebugProtocol.StepInResponse,
		_args: DebugProtocol.StepInArguments
	): void {
		this.sendResponse(response);
		this.sendEvent(new StoppedEvent('step', ViceDebugSession.THREAD_ID));
	}

	protected disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		_args: DebugProtocol.DisconnectArguments
	): void {
		this.sendEvent(new OutputEvent('[VICE Debugger] Session disconnected.\n', 'console'));
		this.sendResponse(response);
	}
}
