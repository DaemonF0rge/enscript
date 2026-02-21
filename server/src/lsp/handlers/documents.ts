import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  TextDocumentChangeEvent,
  TextDocuments
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Analyzer } from '../../analysis/project/graph';

export function registerDocuments(conn: Connection, docs: TextDocuments<TextDocument>): void {
    const analyser = Analyzer.instance();

    const validate = (change: TextDocumentChangeEvent<TextDocument>) => {
        const diagnostics = analyser.runDiagnostics(change.document);
        conn.sendDiagnostics({ uri: change.document.uri, diagnostics });
    };

    // Debounce timers per-URI so each file gets its own delay
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 300;

    docs.onDidOpen(validate);
    docs.onDidSave((change) => {
        // On save: cancel any pending debounce and run immediately
        const uri = change.document.uri;
        const pending = debounceTimers.get(uri);
        if (pending) {
            clearTimeout(pending);
            debounceTimers.delete(uri);
        }
        validate(change);
    });
    docs.onDidChangeContent((change) => {
        // On every keystroke: do a lightweight parse + index update
        // immediately so hover/definition stay responsive, then
        // schedule the HEAVY diagnostic checks after a debounce delay.
        analyser.ensureIndexed(change.document);

        const uri = change.document.uri;
        const pending = debounceTimers.get(uri);
        if (pending) clearTimeout(pending);
        debounceTimers.set(uri, setTimeout(() => {
            debounceTimers.delete(uri);
            // Re-fetch the latest document — the user may have typed more
            const latestDoc = docs.get(uri);
            if (latestDoc) {
                const diagnostics = analyser.runDiagnostics(latestDoc);
                conn.sendDiagnostics({ uri, diagnostics });
            }
        }, DEBOUNCE_MS));
    });

    docs.onDidClose((change) => {
        const uri = change.document.uri;
        const pending = debounceTimers.get(uri);
        if (pending) {
            clearTimeout(pending);
            debounceTimers.delete(uri);
        }
    });
}
