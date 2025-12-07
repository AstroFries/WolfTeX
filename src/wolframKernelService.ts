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

    constructor(extensionPath: string, outputChannel?: OutputChannel) {
        this.outputChannel = outputChannel;
        this.initPromise = this.startKernel(extensionPath);
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
                stdio: ['ignore', 'pipe', 'pipe']
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

    async evaluate(code: string, mode: WolframEvaluationMode, cwd?: string): Promise<string> {
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
                this.log(`Connected to kernel on port ${this.port}`);
                // Prepare request (Newline Delimited JSON)
                const request = JSON.stringify({ code, mode, cwd: cwd || '' }) + '\n';
                socket.write(request);
                this.log(`Sent request: ${code.substring(0, 50)}...`);
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
                        // Parse the JSON response
                        // The response from kernel is a JSON string representing the result string
                        // e.g. "Result String"
                        const result = JSON.parse(responseStr);
                        this.log(`Response received: ${result.substring(0, 50)}...`);
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
