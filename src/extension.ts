// src/extension.ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // 使用与 package.json 中完全相同的命令名
    let disposableHello = vscode.commands.registerCommand('mmatex.helloWorld', () => {
        vscode.window.showInformationMessage('Hello, VSCode!');
    });

    // 注册新命令：显示光标所在行的内容
    let disposableShowCursorLine = vscode.commands.registerCommand('mmatex.showCursorLine', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active text editor');
            return;
        }

        const lineNumber = editor.selection.active.line;
        const lineText = editor.document.lineAt(lineNumber).text;
        vscode.window.showInformationMessage(lineText);
    });

    // 注册新命令：复制当前行到下一行（类似 Alt+Shift+Down）
    let disposableDuplicateLineBelow = vscode.commands.registerCommand('mmatex.duplicateLineBelow', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active text editor');
            return;
        }

        const document = editor.document;
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const lineNumbers = Array.from(new Set(editor.selections.map(selection => selection.active.line))).sort((a, b) => b - a);

        if (lineNumbers.length === 0) {
            return;
        }

        editor.edit(editBuilder => {
            for (const lineNumber of lineNumbers) {
                const lineText = document.lineAt(lineNumber).text;
                editBuilder.insert(document.lineAt(lineNumber).range.end, eol + lineText);
            }
        });
    });

    context.subscriptions.push(disposableHello, disposableShowCursorLine, disposableDuplicateLineBelow);
}

export function deactivate() {}