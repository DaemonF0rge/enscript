/**
 * Completion Handler - Enforce Script LSP
 * ========================================
 * 
 * Provides intelligent code completions for Enforce Script.
 * 
 * FEATURES:
 * 1. MEMBER COMPLETIONS (after dot)
 *    - Resolves variable type from parameters, locals, fields
 *    - Walks inheritance chain for complete method list
 *    - Example: void Func(PlayerBase p) { p. } → shows PlayerBase methods
 * 
 * 2. STATIC MEMBER COMPLETIONS
 *    - Detects ClassName.Method() pattern
 *    - Shows only static members
 * 
 * 3. GLOBAL COMPLETIONS
 *    - Shows classes, functions, enums, variables
 *    - Used when not after a dot
 * 
 * @module enscript/server/src/lsp/handlers/completion
 */

import {
  CompletionItemKind,
  CompletionItem,
  CompletionParams,
  Connection,
  TextDocuments,
  InsertTextFormat
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Analyzer } from '../../analysis/project/graph';

export function registerCompletion(
  conn: Connection,
  docs: TextDocuments<TextDocument>
): void {
  conn.onCompletion((params: CompletionParams): CompletionItem[] => {
    const doc = docs.get(params.textDocument.uri);
    if (!doc) return [];

    const analyser = Analyzer.instance();
    const items = analyser.getCompletions(doc, params.position);

    return items.map(i => ({
      label: (i as any).name,
      kind: convertKind((i as any).kind),
      detail: (i as any).detail,
      insertText: (i as any).insertText || (i as any).name,
      // If it's a function with params, place cursor inside parens
      insertTextFormat: InsertTextFormat.PlainText
    }));
  });
}

function convertKind(kind: string): CompletionItemKind {
  switch (kind) {
    case 'class':
      return CompletionItemKind.Class;
    case 'function':
      return CompletionItemKind.Function;
    case 'variable':
      return CompletionItemKind.Variable;
    case 'field':
      return CompletionItemKind.Field;
    case 'enum':
      return CompletionItemKind.Enum;
    case 'typedef':
      return CompletionItemKind.TypeParameter;
    default:
      return CompletionItemKind.Text;
  }
}
