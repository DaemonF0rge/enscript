import * as vscode from 'vscode';

const ASSET_PATH_EXT_REGEX = /\.(?:p3d|paa|rvmat|xml|layout)\b/i;
const PATH_HINT_REGEX = /(?:^|[\\/])(dz|dayzexpansion|basicmap|playermarkets|_uframework)(?:[\\/]|$)/i;

function isLikelyPathValue(value: string): boolean {
    return value.includes('\\') || value.includes('/') || ASSET_PATH_EXT_REGEX.test(value) || PATH_HINT_REGEX.test(value);
}

export function activateDayzCppDiagnostics(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection('dayzcpp');
    context.subscriptions.push(collection);

    const validate = (doc: vscode.TextDocument) => {
        if (doc.languageId !== 'dayzcpp') {
            collection.delete(doc.uri);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];
        const text = doc.getText();

        const stringRegex = /"([^"\n]*)"/g;
        let strMatch: RegExpExecArray | null;

        while ((strMatch = stringRegex.exec(text)) !== null) {
            const rawWithQuotes = strMatch[0];
            const value = strMatch[1];
            const startOffset = strMatch.index;
            const endOffset = startOffset + rawWithQuotes.length;
            const range = new vscode.Range(doc.positionAt(startOffset), doc.positionAt(endOffset));

            if (!isLikelyPathValue(value)) continue;

            if (value.includes('\\\\')) {
                diagnostics.push(new vscode.Diagnostic(
                    range,
                    'DayZ config path likely contains double backslashes. Use single backslashes in config.cpp/mod.cpp paths (example: "\\dz\\weapons\\...").',
                    vscode.DiagnosticSeverity.Warning
                ));
            }

            if (value.includes('\\') && value.includes('/')) {
                diagnostics.push(new vscode.Diagnostic(
                    range,
                    'Mixed slash styles in path. Prefer consistent DayZ-style single backslashes.',
                    vscode.DiagnosticSeverity.Warning
                ));
            }

            if (/^[A-Za-z]:\\/.test(value)) {
                diagnostics.push(new vscode.Diagnostic(
                    range,
                    'Absolute Windows filesystem path detected. DayZ config values should usually use game-relative paths.',
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }

        const lineCount = doc.lineCount;
        for (let line = 0; line < lineCount; line++) {
            const lineText = doc.lineAt(line).text;

            const classForwardWithBase = lineText.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*;/);
            if (classForwardWithBase) {
                const start = lineText.indexOf(classForwardWithBase[0].trim());
                const range = new vscode.Range(line, Math.max(0, start), line, Math.max(0, start) + classForwardWithBase[0].trim().length);
                diagnostics.push(new vscode.Diagnostic(
                    range,
                    'Suspicious class declaration: forward declarations usually do not include inheritance. Use either "class A;" or a full class body.',
                    vscode.DiagnosticSeverity.Warning
                ));
            }

            const assignmentNoSemicolon = lineText.match(/^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\[\s*\])?\s*=\s*[^;{}]*$/);
            if (assignmentNoSemicolon) {
                const trimmed = lineText.trim();
                if (!trimmed.endsWith('{') && !trimmed.endsWith('}') && !trimmed.endsWith(',') && !trimmed.endsWith('=') && !trimmed.startsWith('//')) {
                    const range = new vscode.Range(line, 0, line, lineText.length);
                    diagnostics.push(new vscode.Diagnostic(
                        range,
                        'Possible missing semicolon in config assignment.',
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            }
        }

        collection.set(doc.uri, diagnostics);
    };

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(validate));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => validate(e.document)));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(validate));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)));

    for (const doc of vscode.workspace.textDocuments) {
        validate(doc);
    }
}
