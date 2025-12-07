import { execFile } from 'child_process';
import { OutputChannel } from 'vscode';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type WolframEvaluationMode = 'plain' | 'latex';

export class WolframKernelService {
    private disposed = false;
    private outputChannel?: OutputChannel;

    constructor(outputChannel?: OutputChannel) {
        this.outputChannel = outputChannel;
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

    async evaluate(code: string, mode: WolframEvaluationMode, cwd?: string): Promise<string> {
        if (this.disposed) {
            return Promise.reject(new Error('Wolfram kernel service has been disposed.'));
        }

        const formatter = mode === 'latex'
            ? 'Function[expr, ToString[TeXForm[expr], InputForm]]'
            : 'Function[expr, ToString[expr, InputForm]]';

        const escapedCode = escapeForWolframString(code);
        const escapedDir = cwd ? escapeForWolframString(cwd) : undefined;

        const evaluationExpression = escapedDir
            ? `Block[{\$CurrentDirectory = "${escapedDir}"}, ToExpression[MMATEXEXPR, InputForm]]`
            : 'ToExpression[MMATEXEXPR, InputForm]';

        // Construct a self-contained Wolfram script to run
        const script = `
Module[{MMATEXEXPR = "${escapedCode}", MMATEXRESULT, MMATEXFORMAT},
  MMATEXFORMAT = ${formatter};
  MMATEXRESULT = Block[{Print = Function[{}, Null]},
    Quiet@Check[
      ${evaluationExpression},
      $Failed
    ]
  ];
  If[MMATEXRESULT =!= Null, Print[MMATEXFORMAT[MMATEXRESULT]]];
];
Exit[];
`;
        
        this.log(`Executing one-shot command for code: ${code.substring(0, 50)}...`);

        try {
            const { stdout, stderr } = await execFileAsync('wolframscript', ['-code', script], {
                encoding: 'utf8',
                cwd: cwd
            });

            if (stderr && stderr.trim().length > 0) {
                this.log(`stderr output: ${stderr}`);
            }

            const result = stdout.trim();
            this.log(`Execution success. Result length: ${result.length}`);
            return result || stderr || '(no output)';
        } catch (err: any) {
            this.error(`Execution failed: ${err.message}`);
            throw err;
        }
    }

    dispose() {
        this.disposed = true;
        this.log('Wolfram kernel service disposed.');
    }
}

function escapeForWolframString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}
