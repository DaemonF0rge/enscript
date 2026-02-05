/**
 * Rules Module - Enforce Script Lexer Rules
 * ==========================================
 * 
 * Defines keywords, punctuation, and operators for Enforce Script tokenization.
 * 
 * ENFORCE SCRIPT vs C++ DIFFERENCES:
 *   - 'modded' keyword: Modifies existing classes at runtime (unique to DayZ)
 *   - 'ref', 'autoptr': Reference counting (not C++ smart pointers)
 *   - 'proto', 'native': Engine binding declarations
 *   - 'notnull': Null safety annotation
 *   - 'sealed', 'abstract', 'final': Class modifiers
 *   - NO 'template' keyword (uses different generic syntax)
 *   - NO 'virtual' keyword (all methods are virtual by default)
 * 
 * @module enscript/server/src/analysis/lexer/rules
 */

// Enforce Script keywords - complete set of reserved words
export const keywords = new Set([
  // Class/type declaration keywords
  'class', 'enum', 'typedef', 'using', 'extends',
  // Modifiers
  'modded', 'proto', 'native', 'owned', 'local', 'auto', 'event',
  'ref', 'reference', 'out', 'inout',
  'override', 'private', 'protected', 'public', 'static', 'const',
  'notnull', 'external', 'volatile', 'autoptr',
  // Control flow
  'return', 'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto',
  // Operators/values  
  'new', 'delete', 'null', 'true', 'false', 'this', 'super',
  // Types (common built-in)
  'void', 'int', 'float', 'bool', 'string', 'vector', 'typename',
  // Additional Enforce Script keywords
  'sealed', 'abstract', 'final'
]);

// Single-character punctuation
export const punct = '(){}[];:,.<>=+-*/%&|!?^~@#';

/**
 * Multi-character operators
 * 
 * CRITICAL: These must be checked BEFORE single-char operators in the lexer!
 * Otherwise '==' becomes two '=' tokens, breaking comparisons.
 * 
 * Includes:
 *   - Comparison: ==, !=, <=, >=
 *   - Logical: &&, ||
 *   - Increment/Decrement: ++, --
 *   - Compound assignment: +=, -=, *=, /=, %=, &=, |=, ^=
 *   - Shift: <<, >>
 *   - Member access: ->, ::
 *   - Null coalescing: ??
 */
export const multiCharOps = new Set([
  '==', '!=', '<=', '>=',
  '&&', '||',
  '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<', '>>',
  '->', '::',
  '??'
]);
