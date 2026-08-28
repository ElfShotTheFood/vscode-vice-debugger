import { IViceRegisters, IViceRegisterDefinition } from './viceMonitor';

/**
 * Event callback subscription handle. Kept vscode-free so this module can be
 * unit-tested and reused outside the extension host if needed.
 */
export interface IDisposable {
	dispose(): void;
}

export type DebuggerEvent = 'stopped' | 'resumed' | 'jam' | 'disconnected' | 'registers';

/**
 * Facade exposing everything a webview panel might need from a debug session.
 * Panels never touch the debug session or monitor directly; they talk to this
 * interface so future panels (memory, disassembly, breakpoints) share one
 * well-defined surface.
 */
export interface IViceDebuggerServices {
	/** True while the binary monitor socket is connected. */
	readonly isConnected: boolean;

	getRegisters(): Promise<IViceRegisters>;
	getRegisterDefinitions(): IViceRegisterDefinition[];
	/** Write a register by (case-insensitive) name, e.g. 'A', 'PC', 'P'. */
	setRegisterByName(name: string, value: number): Promise<void>;

	getMemory(startAddr: number, endAddr: number): Promise<Buffer>;
	setMemory(address: number, data: Buffer): Promise<void>;

	/** Subscribe to debugger lifecycle events ('stopped', 'resumed', ...). */
	onDebuggerEvent(listener: (event: DebuggerEvent, payload: any) => void): IDisposable;
}

const registry = new Map<string, IViceDebuggerServices>();

export function registerDebuggerServices(sessionId: string, services: IViceDebuggerServices): void {
	registry.set(sessionId, services);
}

export function unregisterDebuggerServices(sessionId: string): void {
	registry.delete(sessionId);
}

export function getDebuggerServices(sessionId: string): IViceDebuggerServices | undefined {
	return registry.get(sessionId);
}