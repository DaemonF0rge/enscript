/**
 * Token Module - Enforce Script LSP
 * ==================================
 * 
 * Defines the token types produced by the lexer. Tokens are the atomic units
 * that the parser consumes to build the AST.
 * 
 * TOKEN FLOW:
 *   Source Code → [lexer.ts] → Token[] → [parser.ts] → AST
 * 
 * @module enscript/server/src/analysis/lexer/token
 */

/**
 * Token kinds for the Enforce Script lexer
 * 
 * Each token produced by the lexer has one of these kinds:
 *   - Identifier: Variable names, class names, function names
 *   - Keyword: Reserved words like 'class', 'override', 'modded'
 *   - Number: Numeric literals (int, float, hex)
 *   - String: String literals "..."
 *   - Operator: Single or multi-char operators (+, ==, &&, etc.)
 *   - Punctuation: Structural chars ({, }, (, ), ;, etc.)
 *   - Comment: // or /* ... * / comments
 *   - Preproc: Preprocessor directives (#ifdef, #define, etc.)
 *   - EOF: End of file marker
 */
export enum TokenKind {
  Identifier,
  Keyword,
  Number,
  String,
  Operator,
  Punctuation,
  Comment,
  Preproc,
  EOF
}

/**
 * Token interface - represents a single lexical token
 * 
 * @property kind - The type of token (from TokenKind enum)
 * @property value - The actual text content of the token
 * @property start - Byte offset where the token starts in source
 * @property end - Byte offset where the token ends in source
 */
export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}
