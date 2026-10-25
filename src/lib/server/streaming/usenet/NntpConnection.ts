/**
 * NntpConnection - Single NNTP connection with clean state management.
 *
 * Provides a Promise-based API for NNTP operations with:
 * - Clean state machine
 * - Configurable timeouts per operation type
 * - Better error classification (retryable vs fatal)
 * - Keepalive support for long-lived connections
 */

import * as net from 'net';
import * as tls from 'tls';
import { createChildLogger } from '#lib/logging/index.js';
import {
	type NntpConnectionState,
	type NntpResponse,
	type ClassifiedError,
	NntpResponseCode
} from './types';

const logger = createChildLogger({ logDomain: 'streams' as const });

const CRLF = '\r\n';

/**
 * Timeout configuration per operation type.
 */
export interface TimeoutConfig {
	connect: number;
	command: number;
	multiline: number;
}

const DEFAULT_TIMEOUTS: TimeoutConfig = {
	connect: 15000, // 15s for connection
	command: 30000, // 30s for simple commands
	multiline: 120000 // 2 minutes for article bodies
};

/**
 * Connection configuration.
 */
export interface NntpConnectionConfig {
	host: string;
	port: number;
	useSsl: boolean;
	username?: string;
	password?: string;
	timeouts?: Partial<TimeoutConfig>;
}

/**
 * NntpConnection manages a single NNTP connection.
 */
export class NntpConnection {
	private config: NntpConnectionConfig;
	private timeouts: TimeoutConfig;
	private socket: net.Socket | tls.TLSSocket | null = null;
	private _state: NntpConnectionState = 'disconnected';
	private responseBuffer = '';
	private multilineData: Buffer[] = [];
	private isMultiline = false;

	private pendingResolve: ((response: NntpResponse) => void) | null = null;
	private pendingReject: ((error: Error) => void) | null = null;
	private commandTimeout: ReturnType<typeof setTimeout> | null = null;

	private lastActivityTime = Date.now();
	private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: NntpConnectionConfig) {
		this.config = config;
		this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
	}

	/**
	 * Get current connection state.
	 */
	get state(): NntpConnectionState {
		return this._state;
	}

	/**
	 * Check if connection is ready for commands.
	 */
	get isReady(): boolean {
		return this._state === 'ready';
	}

	/**
	 * Get host for logging/identification.
	 */
	get host(): string {
		return this.config.host;
	}

	/**
	 * Get time since last activity (for idle detection).
	 */
	get idleTimeMs(): number {
		return Date.now() - this.lastActivityTime;
	}

	/**
	 * Connect to the NNTP server.
	 */
	async connect(): Promise<void> {
		if (this._state !== 'disconnected') {
			throw new Error(`Cannot connect: state is ${this._state}`);
		}

		this._state = 'connecting';

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.cleanup();
				reject(new Error('Connection timeout'));
			}, this.timeouts.connect);

			const onConnect = () => {
				// Wait for greeting
			};

			const onData = async (data: Buffer) => {
				try {
					await this.handleData(data);
				} catch (error) {
					this.cleanup();
					reject(error);
				}
			};

			const onError = (err: Error) => {
				clearTimeout(timeout);
				this.cleanup();
				reject(err);
			};

			const onClose = () => {
				if (this._state !== 'disconnected') {
					this._state = 'disconnected';
					if (this.pendingReject) {
						this.pendingReject(new Error('Connection closed unexpectedly'));
						this.pendingReject = null;
						this.pendingResolve = null;
					}
				}
			};

			// Set up one-time greeting handler
			this.pendingResolve = async (response: NntpResponse) => {
				clearTimeout(timeout);

				if (
					response.code !== NntpResponseCode.POSTING_ALLOWED &&
					response.code !== NntpResponseCode.POSTING_PROHIBITED
				) {
					this.cleanup();
					reject(new Error(`Unexpected greeting: ${response.code} ${response.message}`));
					return;
				}

				// Authenticate if credentials provided
				if (this.config.username && this.config.password) {
					try {
						await this.authenticate();
						this._state = 'ready';
						this.startKeepalive();
						resolve();
					} catch (error) {
						this.cleanup();
						reject(error);
					}
				} else {
					this._state = 'ready';
					this.startKeepalive();
					resolve();
				}
			};

			this.pendingReject = reject;

			try {
				if (this.config.useSsl) {
					this.socket = tls.connect(
						{
							host: this.config.host,
							port: this.config.port,
							rejectUnauthorized: false // Many NNTP servers use self-signed certs
						},
						onConnect
					);
				} else {
					this.socket = net.connect({ host: this.config.host, port: this.config.port }, onConnect);
				}

				this.socket.on('data', onData);
				this.socket.on('error', onError);
				this.socket.on('close', onClose);
			} catch (error) {
				clearTimeout(timeout);
				this.cleanup();
				reject(error);
			}
		});
	}

	/**
	 * Disconnect gracefully.
	 */
	async disconnect(): Promise<void> {
		this.stopKeepalive();

		if (this.socket && this._state === 'ready') {
			try {
				await this.sendCommand('QUIT', this.timeouts.command);
			} catch {
				// Ignore errors during quit
			}
		}
		this.cleanup();
	}

	/**
	 * Get article body by message ID.
	 */
	async getBody(messageId: string): Promise<Buffer> {
		const id = messageId.startsWith('<') ? messageId : `<${messageId}>`;
		const response = await this.sendMultilineCommand(`BODY ${id}`, this.timeouts.multiline);

		if (response.code !== NntpResponseCode.BODY_FOLLOWS) {
			throw this.createError(response);
		}

		return response.data || Buffer.alloc(0);
	}

	/**
	 * Check if article exists (STAT command).
	 */
	async checkArticle(messageId: string): Promise<boolean> {
		const id = messageId.startsWith('<') ? messageId : `<${messageId}>`;

		try {
			const response = await this.sendCommand(`STAT ${id}`, this.timeouts.command);
			return response.code === NntpResponseCode.ARTICLE_SELECTED;
		} catch {
			return false;
		}
	}

	/**
	 * Select a newsgroup.
	 */
	async selectGroup(name: string): Promise<void> {
		const response = await this.sendCommand(`GROUP ${name}`, this.timeouts.command);

		if (response.code !== NntpResponseCode.GROUP_SELECTED) {
			throw this.createError(response);
		}
	}

	/**
	 * Classify an error for retry logic.
	 */
	classifyError(error: Error): ClassifiedError {
		const message = error.message.toLowerCase();

		// Connection/network errors are retryable
		if (
			message.includes('timeout') ||
			message.includes('connection') ||
			message.includes('econnreset') ||
			message.includes('epipe') ||
			message.includes('socket')
		) {
			return { type: 'retryable', message: error.message, originalError: error };
		}

		// Service unavailable is retryable
		if (message.includes('400') || message.includes('service unavailable')) {
			return { type: 'retryable', message: error.message, originalError: error };
		}

		// Article not found is not retryable on this provider
		if (
			message.includes('430') ||
			message.includes('420') ||
			message.includes('not found') ||
			message.includes('no such article')
		) {
			return { type: 'not_found', message: error.message, originalError: error };
		}

		// Auth errors are fatal
		if (message.includes('480') || message.includes('482') || message.includes('auth')) {
			return { type: 'fatal', message: error.message, originalError: error };
		}

		// Default to retryable
		return { type: 'retryable', message: error.message, originalError: error };
	}

	/**
	 * Authenticate with the server.
	 */
	private async authenticate(): Promise<void> {
		this._state = 'authenticating';

		const userResponse = await this.sendCommand(
			`AUTHINFO USER ${this.config.username}`,
			this.timeouts.command
		);

		if (userResponse.code === NntpResponseCode.AUTH_ACCEPTED) {
			return;
		}

		if (userResponse.code !== NntpResponseCode.PASSWORD_REQUIRED) {
			throw new Error(`Auth failed: ${userResponse.code} ${userResponse.message}`);
		}

		const passResponse = await this.sendCommand(
			`AUTHINFO PASS ${this.config.password}`,
			this.timeouts.command
		);

		if (passResponse.code !== NntpResponseCode.AUTH_ACCEPTED) {
			throw new Error(`Authentication rejected: ${passResponse.code} ${passResponse.message}`);
		}
	}

	/**
	 * Send a single-line command.
	 */
	private sendCommand(command: string, timeout: number): Promise<NntpResponse> {
		return new Promise((resolve, reject) => {
			if (!this.socket || this._state === 'disconnected') {
				reject(new Error('Not connected'));
				return;
			}

			this.clearCommandTimeout();
			this.pendingResolve = resolve;
			this.pendingReject = reject;
			this.isMultiline = false;

			this.commandTimeout = setTimeout(() => {
				this.pendingResolve = null;
				this.pendingReject = null;
				reject(new Error(`Command timeout after ${timeout}ms`));
			}, timeout);

			const logCommand = command.startsWith('AUTHINFO PASS') ? 'AUTHINFO PASS ****' : command;
			logger.debug({ command: logCommand }, 'Sending NNTP command');

			this.lastActivityTime = Date.now();
			this.socket.write(command + CRLF);
		});
	}

	/**
	 * Send a command that returns multiline response.
	 */
	private sendMultilineCommand(command: string, timeout: number): Promise<NntpResponse> {
		return new Promise((resolve, reject) => {
			if (!this.socket || this._state === 'disconnected') {
				reject(new Error('Not connected'));
				return;
			}

			this.clearCommandTimeout();
			this.pendingResolve = resolve;
			this.pendingReject = reject;
			this.isMultiline = true;
			this.multilineData = [];

			this.commandTimeout = setTimeout(() => {
				this.pendingResolve = null;
				this.pendingReject = null;
				this.isMultiline = false;
				reject(new Error(`Multiline command timeout after ${timeout}ms`));
			}, timeout);

			logger.debug({ command }, 'Sending multiline NNTP command');

			this.lastActivityTime = Date.now();
			this.socket.write(command + CRLF);
		});
	}

	/**
	 * Handle incoming data from socket.
	 */
	private async handleData(data: Buffer): Promise<void> {
		this.lastActivityTime = Date.now();

		if (this.isMultiline) {
			this.multilineData.push(data);

			const combined = Buffer.concat(this.multilineData);
			const str = combined.toString('binary');

			if (str.endsWith('\r\n.\r\n')) {
				this.isMultiline = false;
				this.clearCommandTimeout();

				const firstLineEnd = str.indexOf('\r\n');
				const statusLine = str.slice(0, firstLineEnd);
				const code = parseInt(statusLine.slice(0, 3), 10);
				const message = statusLine.slice(4);

				const dataStart = firstLineEnd + 2;
				const dataEnd = combined.length - 5;
				const bodyData = combined.slice(dataStart, dataEnd);

				const response: NntpResponse = { code, message, data: bodyData };

				logger.debug(
					{
						code,
						message: `${message.slice(0, 50)}...`,
						bodyLength: bodyData.length
					},
					'Received multiline NNTP response'
				);

				if (this.pendingResolve) {
					const resolve = this.pendingResolve;
					this.pendingResolve = null;
					this.pendingReject = null;
					resolve(response);
				}
			}
		} else {
			this.responseBuffer += data.toString();

			const lineEnd = this.responseBuffer.indexOf('\r\n');
			if (lineEnd !== -1) {
				const line = this.responseBuffer.slice(0, lineEnd);
				this.responseBuffer = this.responseBuffer.slice(lineEnd + 2);
				this.clearCommandTimeout();

				const code = parseInt(line.slice(0, 3), 10);
				const message = line.slice(4);

				logger.debug({ code, message }, 'Received NNTP response');

				const response: NntpResponse = { code, message };

				if (this.pendingResolve) {
					const resolve = this.pendingResolve;
					this.pendingResolve = null;
					this.pendingReject = null;
					resolve(response);
				}
			}
		}
	}

	/**
	 * Create an error from NNTP response.
	 */
	private createError(response: NntpResponse): Error {
		return new Error(`NNTP error ${response.code}: ${response.message}`);
	}

	/**
	 * Clear command timeout.
	 */
	private clearCommandTimeout(): void {
		if (this.commandTimeout) {
			clearTimeout(this.commandTimeout);
			this.commandTimeout = null;
		}
	}

	/**
	 * Start keepalive interval.
	 */
	private startKeepalive(): void {
		// Send DATE command every 5 minutes to keep connection alive
		this.keepaliveInterval = setInterval(
			async () => {
				if (this._state === 'ready' && this.idleTimeMs > 60000) {
					try {
						await this.sendCommand('DATE', this.timeouts.command);
					} catch {
						// Ignore keepalive errors
					}
				}
			},
			5 * 60 * 1000
		);
	}

	/**
	 * Stop keepalive interval.
	 */
	private stopKeepalive(): void {
		if (this.keepaliveInterval) {
			clearInterval(this.keepaliveInterval);
			this.keepaliveInterval = null;
		}
	}

	/**
	 * Clean up connection.
	 */
	private cleanup(): void {
		this.stopKeepalive();
		this.clearCommandTimeout();

		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}

		this._state = 'disconnected';
		this.responseBuffer = '';
		this.multilineData = [];
		this.isMultiline = false;
		this.pendingResolve = null;
		this.pendingReject = null;
	}
}
