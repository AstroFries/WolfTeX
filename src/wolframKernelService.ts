import { ChildProcess, spawn } from 'child_process';
import { OutputChannel } from 'vscode';
import * as net from 'net';
import * as path from 'path';

export type WolframEvaluationMode = 'plain' | 'latex';

export class WolframKernelService {
    private process?: ChildProcess;
    private port?: number;
    private initPromise: Promise<void>;
    private disposed = false;
    private outputChannel?: OutputChannel;

    private systemNames: string[] = [];

    constructor(extensionPath: string, outputChannel?: OutputChannel) {
        this.outputChannel = outputChannel;
        this.initPromise = this.startKernel(extensionPath).then(() => {
            this.getSystemNames().catch(err => this.error(`Failed to fetch system names: ${err}`));
        });
    }

    private log(message: string) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[Kernel] ${message}`);
        } else {
            console.log(`[Kernel] ${message}`);
        }
    }

    private error(message: string) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[Kernel Error] ${message}`);
        } else {
            console.error(`[Kernel Error] ${message}`);
        }
    }

    private startKernel(extensionPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(extensionPath, 'dist', 'kernel.wls');
            this.log(`Starting kernel server from: ${scriptPath}`);

            this.process = spawn('wolframscript', ['-f', scriptPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' }
            });

            if (!this.process.stdout) {
                reject(new Error('Failed to open stdout for kernel process'));
                return;
            }

            this.process.stderr?.on('data', (data) => {
                this.log(`STDERR: ${data.toString()}`);
            });

            this.process.on('error', (err) => {
                this.error(`Failed to start kernel: ${err.message}`);
                reject(err);
            });

            this.process.on('close', (code) => {
                this.log(`Kernel exited with code ${code}`);
                this.process = undefined;
                this.port = undefined;
            });

            // Listen for stdout
            let stdoutBuffer = '';
            let portFound = false;

            this.process.stdout.on('data', (data: Buffer) => {
                const str = data.toString();
                this.log(`STDOUT: ${str.trim()}`);

                if (!portFound) {
                    stdoutBuffer += str;
                    const match = stdoutBuffer.match(/PORT:(\d+)/);
                    if (match) {
                        this.port = parseInt(match[1], 10);
                        this.log(`Kernel server listening on port ${this.port}`);
                        portFound = true;
                        resolve();
                    }
                }
            });
        });
    }

    async getSystemNames(): Promise<string[]> {
        if (this.systemNames.length > 0) {
            return this.systemNames;
        }
        try {
            const result = await this.sendRequest({ type: 'completion' });
            if (Array.isArray(result)) {
                this.systemNames = result;
                this.log(`Fetched ${result.length} system names for completion.`);
                return result;
            }
        } catch (e) {
            this.error(`Failed to fetch system names: ${e}`);
        }
        return [];
    }

    async getFunctionUsage(name: string): Promise<string> {
        try {
            const result = await this.sendRequest({ type: 'usage', name });
            return typeof result === 'string' ? result : "";
        } catch (e) {
            this.error(`Failed to fetch usage for ${name}: ${e}`);
            return "";
        }
    }

    private async sendRequest(requestObj: any): Promise<any> {
        if (this.disposed) {
            throw new Error('Wolfram kernel service has been disposed.');
        }

        await this.initPromise;

        if (!this.port) {
            throw new Error('Kernel server is not running.');
        }

        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            
            socket.connect(this.port!, '127.0.0.1', () => {
                // Prepare request (Newline Delimited JSON)
                const request = JSON.stringify(requestObj) + '\n';
                socket.write(request);
            });

            let responseBuffer = '';

            socket.on('data', (data) => {
                responseBuffer += data.toString('utf8');

                // Check for newline
                if (responseBuffer.includes('\n')) {
                    const parts = responseBuffer.split('\n');
                    // Take the first part as the response
                    const responseStr = parts[0];
                    
                    try {
                        const result = JSON.parse(responseStr);
                        socket.end();
                        resolve(result);
                    } catch (e: any) {
                        this.error(`Failed to parse response: ${e.message}`);
                        reject(e);
                    }
                }
            });

            socket.on('error', (err) => {
                this.error(`Socket error: ${err.message}`);
                reject(err);
            });
        });
    }

    async evaluate(code: string, mode: WolframEvaluationMode, cwd?: string, filename?: string): Promise<string> {
        this.log(`Evaluating: ${code.substring(0, 50)}...`);
        return this.sendRequest({ type: 'evaluate', code, mode, cwd: cwd || '', filename: filename || '' });
    }

    dispose() {
        this.disposed = true;
        this.log('Wolfram kernel service disposed.');
        if (this.process) {
            this.log('Killing Wolfram process (SIGKILL)...');
            this.process.kill('SIGKILL');
            this.process = undefined;
        }
    }
}
