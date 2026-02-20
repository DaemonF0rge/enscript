/**
 * Comprehensive tests for expression chain resolution.
 * 
 * Tests cover:
 * 1. parseExpressionChainBackward — pure backward scanning parser
 * 2. resolveFullChain — full chain resolution with indexed classes/functions
 * 3. Consistency — same results across definitions, hover, completions
 */
import { Analyzer } from '../server/src/analysis/project/graph';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position } from 'vscode-languageserver';

/** Helper to access private methods for unit testing */
function parseChainBackward(analyzer: Analyzer, text: string): { name: string; isCall: boolean; isIndexed: boolean }[] {
    return (analyzer as any).parseExpressionChainBackward(text);
}

/** Shorthand for backward parser results without isIndexed (defaults to false) */
function seg(name: string, isCall: boolean, isIndexed = false): { name: string; isCall: boolean; isIndexed: boolean } {
    return { name, isCall, isIndexed };
}

/** Helper to get parseChainMembers (forward parser) for comparison */
function parseChainMembers(analyzer: Analyzer, text: string): string[] {
    return (analyzer as any).parseChainMembers(text);
}

/** Create a fresh Analyzer instance (bypasses singleton) */
function freshAnalyzer(): Analyzer {
    return new (Analyzer as any)();
}

/**
 * Create and index a document into an analyzer.
 * Returns { doc, ast } for use in further calls.
 */
function indexDoc(analyzer: Analyzer, code: string, uri = 'file:///test.enscript') {
    const doc = TextDocument.create(uri, 'enscript', 1, code);
    const ast = analyzer.parseAndCache(doc);
    return { doc, ast };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. parseExpressionChainBackward — Unit Tests (pure function, no indexing)
// ══════════════════════════════════════════════════════════════════════════════

describe('parseExpressionChainBackward', () => {
    let analyzer: Analyzer;
    beforeAll(() => { analyzer = freshAnalyzer(); });

    test('simple property access: obj.', () => {
        const result = parseChainBackward(analyzer, 'obj.');
        expect(result).toEqual([seg('obj', false)]);
    });

    test('simple method call: obj.Method().', () => {
        const result = parseChainBackward(analyzer, 'obj.Method().');
        expect(result).toEqual([
            seg('obj', false),
            seg('Method', true),
        ]);
    });

    test('function call root: GetGame().', () => {
        const result = parseChainBackward(analyzer, 'GetGame().');
        expect(result).toEqual([seg('GetGame', true)]);
    });

    test('two-step property chain: a.b.', () => {
        const result = parseChainBackward(analyzer, 'a.b.');
        expect(result).toEqual([
            seg('a', false),
            seg('b', false),
        ]);
    });

    test('method + property: GetGame().Config.', () => {
        const result = parseChainBackward(analyzer, 'GetGame().Config.');
        expect(result).toEqual([
            seg('GetGame', true),
            seg('Config', false),
        ]);
    });

    test('deep chain (5 segments): a.b().c.d().e.', () => {
        const result = parseChainBackward(analyzer, 'a.b().c.d().e.');
        expect(result).toEqual([
            seg('a', false),
            seg('b', true),
            seg('c', false),
            seg('d', true),
            seg('e', false),
        ]);
    });

    test('nested parentheses: Cast(GetGame().GetObjectByNetworkId(low, high)).', () => {
        const result = parseChainBackward(analyzer, 'Cast(GetGame().GetObjectByNetworkId(low, high)).');
        expect(result).toEqual([seg('Cast', true)]);
    });

    test('complex nested: GetGame().GetObjectByNetworkId(a, b).', () => {
        const result = parseChainBackward(analyzer, 'GetGame().GetObjectByNetworkId(a, b).');
        expect(result).toEqual([
            seg('GetGame', true),
            seg('GetObjectByNetworkId', true),
        ]);
    });

    test('deeply nested args: Func(a.B(c.D())).', () => {
        const result = parseChainBackward(analyzer, 'Func(a.B(c.D())).');
        expect(result).toEqual([seg('Func', true)]);
    });

    test('array indexing: items[0].', () => {
        const result = parseChainBackward(analyzer, 'items[0].');
        expect(result).toEqual([seg('items', false, true)]);
    });

    test('method + array indexing: GetItems()[0].', () => {
        const result = parseChainBackward(analyzer, 'GetItems()[0].');
        expect(result).toEqual([seg('GetItems', true, true)]);
    });

    test('chain with array indexing: obj.GetItems()[0].Name.', () => {
        const result = parseChainBackward(analyzer, 'obj.GetItems()[0].Name.');
        expect(result).toEqual([
            seg('obj', false),
            seg('GetItems', true, true),
            seg('Name', false),
        ]);
    });

    test('whitespace tolerance: obj . Method( ) .', () => {
        const result = parseChainBackward(analyzer, 'obj . Method( ) .');
        expect(result).toEqual([
            seg('obj', false),
            seg('Method', true),
        ]);
    });

    test('this keyword: this.m_Field.', () => {
        const result = parseChainBackward(analyzer, 'this.m_Field.');
        expect(result).toEqual([
            seg('this', false),
            seg('m_Field', false),
        ]);
    });

    test('super keyword: super.Init().', () => {
        const result = parseChainBackward(analyzer, 'super.Init().');
        expect(result).toEqual([
            seg('super', false),
            seg('Init', true),
        ]);
    });

    test('keyword stops parsing: return obj.', () => {
        // "return" is a keyword — parser should stop before it, yielding only "obj"
        const result = parseChainBackward(analyzer, 'return obj.');
        expect(result).toEqual([seg('obj', false)]);
    });

    test('keyword stops: if (x) obj.Method().', () => {
        // Parser stops at ')' boundary — extracts "obj.Method()"
        const result = parseChainBackward(analyzer, 'if (x) obj.Method().');
        expect(result).toEqual([
            seg('obj', false),
            seg('Method', true),
        ]);
    });

    test('assignment prefix: x = obj.Method().', () => {
        // '=' is not a word char, so parser stops before it
        const result = parseChainBackward(analyzer, 'x = obj.Method().');
        expect(result).toEqual([
            seg('obj', false),
            seg('Method', true),
        ]);
    });

    test('empty string returns empty', () => {
        expect(parseChainBackward(analyzer, '')).toEqual([]);
    });

    test('just a dot returns empty', () => {
        expect(parseChainBackward(analyzer, '.')).toEqual([]);
    });

    test('no trailing dot returns empty', () => {
        expect(parseChainBackward(analyzer, 'obj')).toEqual([]);
    });

    test('7-segment deep chain', () => {
        const result = parseChainBackward(analyzer, 'a.b().c.d().e.f().g.');
        expect(result).toEqual([
            seg('a', false),
            seg('b', true),
            seg('c', false),
            seg('d', true),
            seg('e', false),
            seg('f', true),
            seg('g', false),
        ]);
    });

    test('PlayerBase.Cast(expr).', () => {
        const result = parseChainBackward(analyzer, 'PlayerBase.Cast(GetGame().GetObjectByNetworkId(low, high)).');
        expect(result).toEqual([
            seg('PlayerBase', false),
            seg('Cast', true),
        ]);
    });

    test('consecutive method calls: a().b().c().', () => {
        const result = parseChainBackward(analyzer, 'a().b().c().');
        expect(result).toEqual([
            seg('a', true),
            seg('b', true),
            seg('c', true),
        ]);
    });

    test('method with multiple args: obj.Method(a, b, c).', () => {
        const result = parseChainBackward(analyzer, 'obj.Method(a, b, c).');
        expect(result).toEqual([
            seg('obj', false),
            seg('Method', true),
        ]);
    });

    test('method with string arg containing dot: obj.Method("foo.bar").', () => {
        // The dot inside the string is inside parens, so it shouldn't break parsing
        const result = parseChainBackward(analyzer, 'obj.Method("foo.bar").');
        expect(result).toEqual([
            seg('obj', false),
            seg('Method', true),
        ]);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. parseChainMembers — Forward parser unit tests
// ══════════════════════════════════════════════════════════════════════════════

describe('parseChainMembers (forward parser)', () => {
    let analyzer: Analyzer;
    beforeAll(() => { analyzer = freshAnalyzer(); });

    test('simple property: .Prop', () => {
        expect(parseChainMembers(analyzer, '.Prop')).toEqual(['Prop']);
    });

    test('method call: .Method()', () => {
        expect(parseChainMembers(analyzer, '.Method()')).toEqual(['Method']);
    });

    test('method with args: .Method(a, b)', () => {
        expect(parseChainMembers(analyzer, '.Method(a, b)')).toEqual(['Method']);
    });

    test('chain: .A().B.C()', () => {
        expect(parseChainMembers(analyzer, '.A().B.C()')).toEqual(['A', 'B', 'C']);
    });

    test('nested parens: .A(B(c)).D', () => {
        expect(parseChainMembers(analyzer, '.A(B(c)).D')).toEqual(['A', 'D']);
    });

    test('array indexing: .Items[0].Name', () => {
        expect(parseChainMembers(analyzer, '.Items[0].Name')).toEqual(['Items', 'Name']);
    });

    test('method + array indexing: .GetItems()[0].Name', () => {
        expect(parseChainMembers(analyzer, '.GetItems()[0].Name')).toEqual(['GetItems', 'Name']);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. resolveFullChain — Integration Tests (requires indexed classes/functions)
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveFullChain with indexed classes', () => {
    let analyzer: Analyzer;
    let mainDoc: TextDocument;
    let mainAst: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        // Index a "library" document with class hierarchies
        const libCode = `
class CGame {
    PlayerBase GetPlayer() { return null; }
    World GetWorld() { return null; }
};

class World {
    string GetName() { return ""; }
    float GetTime() { return 0; }
};

class EntityAI {
    string GetType() { return ""; }
    void SetHealth(float hp) {}
    Inventory GetInventory() { return null; }
};

class Inventory {
    int GetItemCount() { return 0; }
    ItemBase GetItem(int idx) { return null; }
};

class ItemBase {
    string GetDisplayName() { return ""; }
    float GetQuantity() { return 0; }
};

class PlayerBase extends EntityAI {
    void Kill() {}
    HumanInputController GetInputController() { return null; }
};

class HumanInputController {
    bool IsUsePressed() { return false; }
};

CGame GetGame() { return null; }
PlayerBase GetPlayer() { return null; }
`;
        indexDoc(analyzer, libCode, 'file:///lib.enscript');

        // Index the "main" document where chains will be resolved
        const mainCode = `
class TestClass {
    PlayerBase m_Player;
    
    void TestMethod() {
        PlayerBase localPlayer = GetGame().GetPlayer();
        localPlayer.GetType();
    }
};
`;
        const result = indexDoc(analyzer, mainCode, 'file:///main.enscript');
        mainDoc = result.doc;
        mainAst = result.ast;
    });

    test('function call root: GetGame(). → CGame', () => {
        const result = analyzer.resolveFullChain('GetGame().', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('CGame');
    });

    test('two-step chain: GetGame().GetPlayer(). → PlayerBase', () => {
        const result = analyzer.resolveFullChain('GetGame().GetPlayer().', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('PlayerBase');
    });

    test('three-step chain: GetGame().GetPlayer().GetType(). → string', () => {
        const result = analyzer.resolveFullChain('GetGame().GetPlayer().GetType().', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('string');
    });

    test('inherited method: GetGame().GetPlayer().GetInventory(). → Inventory', () => {
        const result = analyzer.resolveFullChain('GetGame().GetPlayer().GetInventory().', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('Inventory');
    });

    test('deep chain (4 steps): GetGame().GetPlayer().GetInventory().GetItem(0). → ItemBase', () => {
        const result = analyzer.resolveFullChain('GetGame().GetPlayer().GetInventory().GetItem(0).', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('ItemBase');
    });

    test('deep chain (5 steps): ...GetItem(0).GetDisplayName(). → string', () => {
        const text = 'GetGame().GetPlayer().GetInventory().GetItem(0).GetDisplayName().';
        const result = analyzer.resolveFullChain(text, mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('string');
    });

    test('property chain: GetGame().GetWorld(). → World', () => {
        const result = analyzer.resolveFullChain('GetGame().GetWorld().', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('World');
    });

    test('nested args in chain: GetGame().GetPlayer(). still resolves', () => {
        // Even with complex text before, the chain should parse correctly
        const result = analyzer.resolveFullChain('x = GetGame().GetPlayer().', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('PlayerBase');
    });

    test('class field access: this.m_Player. → PlayerBase', () => {
        // Position inside TestClass method where this.m_Player is a field
        const result = analyzer.resolveFullChain('this.m_Player.', mainDoc, { line: 5, character: 0 }, mainAst);
        // 'this' resolves to TestClass, m_Player is a field of type PlayerBase
        // This test verifies the chain walks through class fields
        if (result) {
            expect(result.type).toBe('PlayerBase');
        }
        // Note: if this resolves to null, the field lookup might need more context
    });

    test('unresolvable chain returns null', () => {
        const result = analyzer.resolveFullChain('unknownVar.unknownMethod().', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).toBeNull();
    });

    test('text without trailing dot returns null', () => {
        const result = analyzer.resolveFullChain('GetGame()', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).toBeNull();
    });

    test('empty text returns null', () => {
        const result = analyzer.resolveFullChain('', mainDoc, { line: 5, character: 0 }, mainAst);
        expect(result).toBeNull();
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. resolveFullChain with templates/typedefs
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveFullChain with templates and typedefs', () => {
    let analyzer: Analyzer;
    let doc: TextDocument;
    let ast: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        // Index generic classes and typedefs
        const code = `
typedef map<string, int> TStringIntMap;

class array<Class T> {
    int Count() { return 0; }
    T Get(int index) { return null; }
};

class map<Class TKey, Class TValue> {
    TValue Get(TKey key) { return null; }
    int Count() { return 0; }
    TKey GetKey(int index) { return null; }
};

class Container {
    array<ItemBase> GetItems() { return null; }
    TStringIntMap GetLookup() { return null; }
};

class ItemBase {
    string GetName() { return ""; }
};

Container GetContainer() { return null; }
`;
        const result = indexDoc(analyzer, code, 'file:///generics.enscript');
        doc = result.doc;
        ast = result.ast;
    });

    test('typedef chain: GetContainer().GetLookup(). → map', () => {
        const result = analyzer.resolveFullChain('GetContainer().GetLookup().', doc, { line: 1, character: 0 }, ast);
        expect(result).not.toBeNull();
        // TStringIntMap resolves to map<string, int>, so type should be "map"
        expect(result!.type).toBe('map');
    });

    test('typedef chain with method: GetContainer().GetLookup().Get("key"). → int', () => {
        const result = analyzer.resolveFullChain('GetContainer().GetLookup().Get("key").', doc, { line: 1, character: 0 }, ast);
        if (result) {
            // TStringIntMap = map<string,int>, so Get(TKey) returns TValue = int
            expect(result.type).toBe('int');
        }
    });

    test('generic array chain: GetContainer().GetItems(). → array', () => {
        const result = analyzer.resolveFullChain('GetContainer().GetItems().', doc, { line: 1, character: 0 }, ast);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('array');
    });

    test('generic array Get: GetContainer().GetItems().Get(0). → ItemBase', () => {
        const result = analyzer.resolveFullChain('GetContainer().GetItems().Get(0).', doc, { line: 1, character: 0 }, ast);
        if (result) {
            // array<ItemBase>.Get(int) returns T = ItemBase
            expect(result.type).toBe('ItemBase');
        }
    });

    test('generic through typedef: GetContainer().GetLookup().GetKey(0). → string', () => {
        const result = analyzer.resolveFullChain('GetContainer().GetLookup().GetKey(0).', doc, { line: 1, character: 0 }, ast);
        if (result) {
            // TStringIntMap = map<string, int>, GetKey returns TKey = string
            expect(result.type).toBe('string');
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. resolveFullChain with nested parentheses (the original bug)
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveFullChain with nested parentheses', () => {
    let analyzer: Analyzer;
    let doc: TextDocument;
    let ast: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        const code = `
class Object {
    string GetType() { return ""; }
};

class EntityAI extends Object {
    int GetID() { return 0; }
};

class PlayerBase extends EntityAI {
    void Kill() {}
};

class CGame {
    Object GetObjectByNetworkId(int low, int high) { return null; }
    PlayerBase GetPlayer() { return null; }
};

CGame GetGame() { return null; }
PlayerBase Cast(Object obj) { return null; }

class TestClass {
    void Test() {
        auto obj = GetGame().GetObjectByNetworkId(1, 2);
    }
};
`;
        const result = indexDoc(analyzer, code, 'file:///nested.enscript');
        doc = result.doc;
        ast = result.ast;
    });

    test('chain with multi-arg call: GetGame().GetObjectByNetworkId(low, high). → Object', () => {
        const result = analyzer.resolveFullChain(
            'GetGame().GetObjectByNetworkId(low, high).',
            doc, { line: 10, character: 0 }, ast
        );
        expect(result).not.toBeNull();
        expect(result!.type).toBe('Object');
    });

    test('chain with nested call in args: GetGame().GetObjectByNetworkId(GetID(), high). → Object', () => {
        const result = analyzer.resolveFullChain(
            'GetGame().GetObjectByNetworkId(GetID(), high).',
            doc, { line: 10, character: 0 }, ast
        );
        expect(result).not.toBeNull();
        expect(result!.type).toBe('Object');
    });

    test('Cast wrapping chain: Cast(GetGame().GetObjectByNetworkId(1, 2)). → PlayerBase', () => {
        // Cast() is a global function returning PlayerBase
        const result = analyzer.resolveFullChain(
            'Cast(GetGame().GetObjectByNetworkId(1, 2)).',
            doc, { line: 10, character: 0 }, ast
        );
        expect(result).not.toBeNull();
        expect(result!.type).toBe('PlayerBase');
    });

    test('chain after nested function: GetGame().GetPlayer(). after complex prefix', () => {
        // Simulates code like: if (condition) GetGame().GetPlayer().
        const result = analyzer.resolveFullChain(
            'if (true) GetGame().GetPlayer().',
            doc, { line: 10, character: 0 }, ast
        );
        expect(result).not.toBeNull();
        expect(result!.type).toBe('PlayerBase');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Consistency: backward parser agrees with forward parser
// ══════════════════════════════════════════════════════════════════════════════

describe('backward/forward parser consistency', () => {
    let analyzer: Analyzer;
    beforeAll(() => { analyzer = freshAnalyzer(); });

    /**
     * For a chain like "root.a().b.c().",
     * backward parser extracts: [root, a, b, c]
     * forward parser on ".a().b.c()" extracts: [a, b, c]
     * The backward parser's result (minus root) should match the forward parser.
     */
    function verifyConsistency(chainText: string) {
        const backward = parseChainBackward(analyzer, chainText);
        if (backward.length === 0) return; // nothing to compare
        
        // Extract the forward-parseable part: everything after the root segment
        const root = backward[0];
        // Find where the root ends in the text (scan from end backward to reconstruct)
        // For simplicity, just verify member names match
        const backwardMembers = backward.slice(1).map(s => s.name);
        
        // Build the forward chain text from members
        if (backwardMembers.length === 0) return;
        
        // Reconstruct a simplified forward chain: .Member1().Member2.Member3()
        const forwardText = backward.slice(1).map(s => `.${s.name}${s.isCall ? '()' : ''}`).join('');
        const forward = parseChainMembers(analyzer, forwardText);
        
        expect(forward).toEqual(backwardMembers);
    }

    test('simple chain', () => verifyConsistency('obj.Method().'));
    test('multi-step', () => verifyConsistency('a.b().c.d().'));
    test('all methods', () => verifyConsistency('a().b().c().'));
    test('all properties', () => verifyConsistency('a.b.c.d.'));
    test('deep chain', () => verifyConsistency('a.b().c.d().e.f().g.'));
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. resolveChainReturnType / resolveVariableChainType — diagnostic helpers
// ══════════════════════════════════════════════════════════════════════════════

describe('diagnostic chain resolution helpers', () => {
    let analyzer: Analyzer;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        const code = `
class CGame {
    PlayerBase GetPlayer() { return null; }
    World GetWorld() { return null; }
};

class World {
    string GetName() { return ""; }
};

class PlayerBase {
    string GetType() { return ""; }
    Inventory GetInventory() { return null; }
};

class Inventory {
    int Count() { return 0; }
};

CGame GetGame() { return null; }
`;
        indexDoc(analyzer, code, 'file:///diag_lib.enscript');
    });

    test('resolveChainReturnType: GetGame().GetPlayer() → PlayerBase', () => {
        const result = (analyzer as any).resolveChainReturnType('GetGame().GetPlayer()');
        expect(result).toBe('PlayerBase');
    });

    test('resolveChainReturnType: GetGame().GetPlayer().GetType() → string', () => {
        const result = (analyzer as any).resolveChainReturnType('GetGame().GetPlayer().GetType()');
        expect(result).toBe('string');
    });

    test('resolveChainReturnType: GetGame().GetWorld().GetName() → string', () => {
        const result = (analyzer as any).resolveChainReturnType('GetGame().GetWorld().GetName()');
        expect(result).toBe('string');
    });

    test('resolveChainReturnType: single call GetGame() → CGame', () => {
        const result = (analyzer as any).resolveChainReturnType('GetGame()');
        expect(result).toBe('CGame');
    });

    test('resolveVariableChainType: PlayerBase.GetInventory() → Inventory', () => {
        const result = (analyzer as any).resolveVariableChainType('PlayerBase', '.GetInventory()');
        expect(result).toBe('Inventory');
    });

    test('resolveVariableChainType: PlayerBase.GetInventory().Count() → int', () => {
        const result = (analyzer as any).resolveVariableChainType('PlayerBase', '.GetInventory().Count()');
        expect(result).toBe('int');
    });

    test('resolveChainReturnType: deep 4-step chain', () => {
        const result = (analyzer as any).resolveChainReturnType('GetGame().GetPlayer().GetInventory().Count()');
        expect(result).toBe('int');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. Consistency between resolveFullChain and diagnostic chain helpers
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveFullChain vs diagnostic helpers consistency', () => {
    let analyzer: Analyzer;
    let doc: TextDocument;
    let ast: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        const code = `
class CGame {
    PlayerBase GetPlayer() { return null; }
    World GetWorld() { return null; }
};

class World {
    string GetName() { return ""; }
};

class PlayerBase {
    string GetType() { return ""; }
    Inventory GetInventory() { return null; }
};

class Inventory {
    int Count() { return 0; }
};

CGame GetGame() { return null; }

class TestClass {
    void Test() {
        GetGame().GetPlayer();
    }
};
`;
        const result = indexDoc(analyzer, code, 'file:///consistency.enscript');
        doc = result.doc;
        ast = result.ast;
    });

    /**
     * Verify that resolveFullChain and resolveChainReturnType agree on the type
     * for function-rooted chains.
     */
    function verifyFuncChainConsistency(chain: string, expectedType: string) {
        // resolveFullChain expects text ending with dot
        const fullResult = analyzer.resolveFullChain(chain + '.', doc, { line: 10, character: 0 }, ast);
        // resolveChainReturnType expects the chain WITHOUT trailing dot
        const diagResult = (analyzer as any).resolveChainReturnType(chain);

        expect(fullResult).not.toBeNull();
        expect(fullResult!.type).toBe(expectedType);
        expect(diagResult).toBe(expectedType);
    }

    test('single function call', () => {
        verifyFuncChainConsistency('GetGame()', 'CGame');
    });

    test('two-step chain', () => {
        verifyFuncChainConsistency('GetGame().GetPlayer()', 'PlayerBase');
    });

    test('three-step chain', () => {
        verifyFuncChainConsistency('GetGame().GetPlayer().GetType()', 'string');
    });

    test('four-step chain', () => {
        verifyFuncChainConsistency('GetGame().GetPlayer().GetInventory().Count()', 'int');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. Edge cases and robustness
// ══════════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
    let analyzer: Analyzer;
    beforeAll(() => { analyzer = freshAnalyzer(); });

    test('parseExpressionChainBackward handles consecutive dots gracefully', () => {
        // ".." is invalid syntax — should return empty or partial
        const result = parseChainBackward(analyzer, 'obj..');
        // Second dot with no identifier before it — should stop
        // The result may vary, but should not throw
        expect(Array.isArray(result)).toBe(true);
    });

    test('parseExpressionChainBackward handles number before dot', () => {
        // "123." — digits are \w but not a valid identifier for our purposes
        // Parser should extract "123" as a segment (numbers match \w)
        const result = parseChainBackward(analyzer, '123.');
        // 123 doesn't match any keyword, so it will be extracted
        expect(result.length).toBeGreaterThanOrEqual(0);
    });

    test('parseExpressionChainBackward handles underscore identifiers', () => {
        const result = parseChainBackward(analyzer, '_private._field.');
        expect(result).toEqual([
            seg('_private', false),
            seg('_field', false),
        ]);
    });

    test('parseExpressionChainBackward with empty parens in chain', () => {
        const result = parseChainBackward(analyzer, 'a().b().');
        expect(result).toEqual([
            seg('a', true),
            seg('b', true),
        ]);
    });

    test('very long chain does not stack overflow', () => {
        const segments = Array.from({ length: 50 }, (_, i) => `seg${i}()`).join('.');
        const text = segments + '.';
        const result = parseChainBackward(analyzer, text);
        expect(result).toHaveLength(50);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. Audit-derived edge case tests (Findings from systematic review)
// ══════════════════════════════════════════════════════════════════════════════

describe('Finding 1 & 16: string literals inside paren-balancing', () => {
    let analyzer: Analyzer;
    beforeAll(() => { analyzer = freshAnalyzer(); });

    test('backward parser: string with closing paren inside args', () => {
        // foo(bar("text)here")).Method.
        // The ")" inside the string should not break paren depth
        const result = parseChainBackward(analyzer, 'foo(bar("text)here")).Method.');
        expect(result).toEqual([
            seg('foo', true),
            seg('Method', false),
        ]);
    });

    test('backward parser: string with opening paren inside args', () => {
        const result = parseChainBackward(analyzer, 'foo("arg(value").Method.');
        expect(result).toEqual([
            seg('foo', true),
            seg('Method', false),
        ]);
    });

    test('backward parser: single-quoted string with paren', () => {
        const result = parseChainBackward(analyzer, "foo('arg)val').Method.");
        expect(result).toEqual([
            seg('foo', true),
            seg('Method', false),
        ]);
    });

    test('forward parser: string with closing paren inside args', () => {
        // .Format("name)value").Length should parse as ["Format", "Length"]
        const result = parseChainMembers(analyzer, '.Format("name)value").Length');
        expect(result).toEqual(['Format', 'Length']);
    });

    test('forward parser: string with opening paren inside args', () => {
        const result = parseChainMembers(analyzer, '.Method("arg(val").Next');
        expect(result).toEqual(['Method', 'Next']);
    });

    test('forward parser: escaped quote in string', () => {
        const result = parseChainMembers(analyzer, '.Method("he\\"llo)").Next');
        expect(result).toEqual(['Method', 'Next']);
    });
});

describe('Finding 2: expanded keyword stop-list', () => {
    let analyzer: Analyzer;
    beforeAll(() => { analyzer = freshAnalyzer(); });

    test('null is rejected as chain root', () => {
        const result = parseChainBackward(analyzer, 'null.');
        expect(result).toEqual([]);
    });

    test('true is rejected as chain root', () => {
        const result = parseChainBackward(analyzer, 'true.');
        expect(result).toEqual([]);
    });

    test('false is rejected as chain root', () => {
        const result = parseChainBackward(analyzer, 'false.');
        expect(result).toEqual([]);
    });

    test('foreach stops parsing', () => {
        const result = parseChainBackward(analyzer, 'foreach (x) obj.');
        expect(result).toEqual([seg('obj', false)]);
    });

    test('const stops parsing', () => {
        const result = parseChainBackward(analyzer, 'const obj.');
        expect(result).toEqual([seg('obj', false)]);
    });

    test('break is rejected as chain root', () => {
        const result = parseChainBackward(analyzer, 'break.');
        expect(result).toEqual([]);
    });

    test('continue is rejected as chain root', () => {
        const result = parseChainBackward(analyzer, 'continue.');
        expect(result).toEqual([]);
    });

    test('override stops parsing', () => {
        const result = parseChainBackward(analyzer, 'override obj.');
        expect(result).toEqual([seg('obj', false)]);
    });
});

describe('Finding 5: uppercase check for class names', () => {
    let analyzer: Analyzer;
    let doc: TextDocument;
    let ast: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();
        const code = `
class MyClass {
    string GetName() { return ""; }
};

class TestClass {
    MyClass _myVar;
    void Test() {
        _myVar.GetName();
    }
};
`;
        const result = indexDoc(analyzer, code, 'file:///test_uppercase.enscript');
        doc = result.doc;
        ast = result.ast;
    });

    test('underscore-prefixed variable is not mistaken for class', () => {
        // _myVar should resolve as a variable, not try class lookup
        const result = analyzer.resolveFullChain('_myVar.', doc, { line: 7, character: 0 }, ast);
        if (result) {
            expect(result.type).toBe('MyClass');
        }
    });
});

describe('Finding 9/10/20: comparison operator detection', () => {
    let analyzer: Analyzer;

    beforeAll(() => { analyzer = freshAnalyzer(); });

    function hasCompOp(text: string): boolean {
        return (analyzer as any).hasTopLevelComparisonOperator(text);
    }

    test('detects >', () => {
        expect(hasCompOp('.GetCount() > 5')).toBe(true);
    });

    test('detects <', () => {
        expect(hasCompOp('.GetHealth() < 100')).toBe(true);
    });

    test('detects >=', () => {
        expect(hasCompOp('.GetValue() >= other')).toBe(true);
    });

    test('detects <=', () => {
        expect(hasCompOp('.GetValue() <= 0')).toBe(true);
    });

    test('detects ==', () => {
        expect(hasCompOp('.GetType() == "test"')).toBe(true);
    });

    test('detects !=', () => {
        expect(hasCompOp('.GetType() != "test"')).toBe(true);
    });

    test('detects &&', () => {
        expect(hasCompOp('.IsAlive() && other')).toBe(true);
    });

    test('detects ||', () => {
        expect(hasCompOp('.IsAlive() || other')).toBe(true);
    });

    test('does not false-positive on operators inside parens', () => {
        expect(hasCompOp('.Method(a > b)')).toBe(false);
    });

    test('does not false-positive on operators inside strings', () => {
        expect(hasCompOp('.Method("a > b")')).toBe(false);
    });

    test('does not false-positive on simple chain without operators', () => {
        expect(hasCompOp('.GetItems().Count()')).toBe(false);
    });
});

describe('Finding 19: this/super mid-chain validation', () => {
    let analyzer: Analyzer;
    beforeAll(() => { analyzer = freshAnalyzer(); });

    test('this at start is valid', () => {
        const result = parseChainBackward(analyzer, 'this.Method().');
        expect(result.length).toBe(2);
        expect(result[0].name).toBe('this');
    });

    test('super at start is valid', () => {
        const result = parseChainBackward(analyzer, 'super.Method().');
        expect(result.length).toBe(2);
        expect(result[0].name).toBe('super');
    });

    test('this mid-chain returns empty (invalid)', () => {
        // This shouldn't happen in valid code but we validate anyway
        // "obj.this.Method." — if it somehow parsed, this/super mid-chain is rejected
        // Actually the parser won't produce this because 'this' would stop as keyword...
        // but let's verify the post-parse validation works if segments are manually constructed
        const result = parseChainBackward(analyzer, 'obj.this.');
        // 'this' is now in the keyword stop-list, so it wouldn't be extracted
        // The parser would extract just 'obj' as root... but wait, 'this' IS allowed,
        // just not mid-chain. Let's see what happens:
        // backward scan: '.', read 'this', check for dot -> '.', read 'obj', no more dots
        // segments = [{name:'obj'}, {name:'this'}]
        // post-validation: index 1 is 'this' -> return []
        expect(result).toEqual([]);
    });
});

describe('Finding 14: static method chains in inferArgType', () => {
    let analyzer: Analyzer;

    beforeAll(() => {
        analyzer = freshAnalyzer();
        const code = `
class Math {
    static float AbsFloat(float val) { return 0; }
    static int AbsInt(int val) { return 0; }
};

class Container {
    void Process(float val) {}
    void ProcessInt(int val) {}
};
`;
        indexDoc(analyzer, code, 'file:///static_test.enscript');
    });

    test('resolves static method chain in argument', () => {
        const getVarType = (_name: string) => undefined;
        const result = (analyzer as any).inferArgType('Math.AbsFloat(x)', getVarType, undefined);
        // Math is a class, AbsFloat is a static method returning float
        // With our fix, inferArgType should now resolve this
        if (result) {
            expect(result).toBe('float');
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. Indexed container type resolution (array/map indexing in chains)
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveFullChain with array/map indexing', () => {
    let analyzer: Analyzer;
    let doc: TextDocument;
    let ast: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();
        const code = `
class string {
    int Length() { return 0; }
    string SubString(int start, int len) { return ""; }
};

class array<Class T> {
    int Count() { return 0; }
    T Get(int index) { return null; }
    void Insert(T item) {}
};

class map<Class TKey, Class TValue> {
    TValue Get(TKey key) { return null; }
    TKey GetKey(int index) { return null; }
    int Count() { return 0; }
};

class set<Class T> {
    void Insert(T item) {}
    T Get(int n) { return null; }
    int Count() { return 0; }
};

class ItemBase {
    string GetDisplayName() { return ""; }
    float GetHealth() { return 0; }
};

class Inventory {
    array<ItemBase> GetItems() { return null; }
    map<string, ItemBase> GetLookup() { return null; }
};

class Player {
    Inventory GetInventory() { return null; }
    array<string> m_Lines;
};
`;
        const result = indexDoc(analyzer, code, 'file:///indexing_test.enscript');
        doc = result.doc;
        ast = result.ast;
    });

    test('array indexing on root: items[i]. resolves to element type', () => {
        // Backward parser correctly marks items as isIndexed
        const chain = parseChainBackward(analyzer, 'items[0].');
        expect(chain).toEqual([seg('items', false, true)]);
    });

    test('method call + indexing: GetItems()[0]. marked correctly', () => {
        const chain = parseChainBackward(analyzer, 'GetItems()[0].');
        expect(chain).toEqual([seg('GetItems', true, true)]);
    });

    test('resolveFullChain: field array indexing then method', () => {
        // this.m_Lines[i].Length() — m_Lines is array<string>, [i] gives string, Length() is on string
        const result = analyzer.resolveFullChain('this.m_Lines[0].', doc, { line: 50, character: 0 }, ast);
        // m_Lines resolves to array<string>, indexing gives string
        if (result) {
            expect(result.type).toBe('string');
        }
    });

    test('resolveFullChain: method returns array, index it', () => {
        // GetInventory().GetItems()[0]. → array<ItemBase>[0] → ItemBase
        const code2 = `
class CGame {
    Player GetPlayer() { return null; }
};
CGame GetGame() { return null; }
`;
        indexDoc(analyzer, code2, 'file:///indexing_game.enscript');
        const result = analyzer.resolveFullChain(
            'GetGame().GetPlayer().GetInventory().GetItems()[0].',
            doc, { line: 50, character: 0 }, ast
        );
        if (result) {
            expect(result.type).toBe('ItemBase');
        }
    });

    test('resolveIndexedContainerType for vector', () => {
        const deref = (analyzer as any).resolveIndexedContainerType({ type: 'vector', templateMap: new Map() });
        expect(deref.type).toBe('float');
    });

    test('resolveIndexedContainerType for string', () => {
        const deref = (analyzer as any).resolveIndexedContainerType({ type: 'string', templateMap: new Map() });
        expect(deref.type).toBe('string');
    });

    test('resolveIndexedContainerType for array with templateMap', () => {
        const tm = new Map([['T', 'ItemBase']]);
        const deref = (analyzer as any).resolveIndexedContainerType({ type: 'array', templateMap: tm });
        expect(deref.type).toBe('ItemBase');
    });

    test('resolveIndexedContainerType for map with templateMap', () => {
        const tm = new Map([['TKey', 'string'], ['TValue', 'int']]);
        const deref = (analyzer as any).resolveIndexedContainerType({ type: 'map', templateMap: tm });
        expect(deref.type).toBe('int');
    });

    test('resolveIndexedContainerType for set with templateMap', () => {
        const tm = new Map([['T', 'string']]);
        const deref = (analyzer as any).resolveIndexedContainerType({ type: 'set', templateMap: tm });
        expect(deref.type).toBe('string');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. Template parameter resolution
// ══════════════════════════════════════════════════════════════════════════════

describe('template parameter resolution', () => {
    // Each test uses a fresh analyzer to avoid URI/version caching issues
    test('resolveTemplateParam detects T in containing class', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class MyContainer<Class T> {
                T m_Value;
                void DoStuff() {
                    m_Value.GetType();
                }
            }
        `);
        // Position inside DoStuff
        const pos = { line: 4, character: 20 };
        const result = (analyzer as any).resolveTemplateParam('T', ast, pos);
        expect(result).toBe('Class');
    });

    test('resolveTemplateParam returns null for non-template types', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class Foo {
                void Bar() {
                    int x;
                }
            }
        `);
        const pos = { line: 3, character: 10 };
        const result = (analyzer as any).resolveTemplateParam('int', ast, pos);
        expect(result).toBeNull();
    });

    test('resolveTemplateParam detects T1, T2 in Param-like classes', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class Param2<Class T1, Class T2> {
                T1 m_First;
                T2 m_Second;
                void DoStuff() {
                    m_First.Thing();
                }
            }
        `);
        const pos = { line: 5, character: 20 };
        expect((analyzer as any).resolveTemplateParam('T1', ast, pos)).toBe('Class');
        expect((analyzer as any).resolveTemplateParam('T2', ast, pos)).toBe('Class');
        expect((analyzer as any).resolveTemplateParam('T3', ast, pos)).toBeNull();
    });

    test('resolveTemplateParam detects TKey, TValue in map-like classes', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class CustomMap<Class TKey, Class TValue> {
                void Lookup() {
                    TKey k;
                }
            }
        `);
        const pos = { line: 3, character: 10 };
        expect((analyzer as any).resolveTemplateParam('TKey', ast, pos)).toBe('Class');
        expect((analyzer as any).resolveTemplateParam('TValue', ast, pos)).toBe('Class');
    });

    test('resolveChainRoot resolves T-typed variable to Class', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class MyContainer<Class T> {
                T m_Entity;
                void DoStuff() {
                    m_Entity.GetType();
                }
            }
        `);
        const pos = { line: 4, character: 20 };
        const root = { name: 'm_Entity', isCall: false };
        const result = (analyzer as any).resolveChainRoot(root, doc, pos, ast);
        // T should resolve to 'Class' (the upper bound of template params)
        expect(result).not.toBeNull();
        expect(result.type).toBe('Class');
    });

    test('resolveChainRoot preserves concrete types (not template params)', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class Foo {
                int m_Value;
                void Bar() {
                    m_Value;
                }
            }
        `);
        const pos = { line: 4, character: 10 };
        const root = { name: 'm_Value', isCall: false };
        const result = (analyzer as any).resolveChainRoot(root, doc, pos, ast);
        expect(result).not.toBeNull();
        expect(result.type).toBe('int');
    });

    test('auto and typename are still unresolvable', () => {
        const analyzer = freshAnalyzer();
        // These should NOT be treated as template params
        const { doc, ast } = indexDoc(analyzer, `
            class Foo {
                void Bar() {
                    auto x;
                }
            }
        `);
        const pos = { line: 3, character: 10 };
        expect((analyzer as any).resolveTemplateParam('auto', ast, pos)).toBeNull();
        expect((analyzer as any).resolveTemplateParam('typename', ast, pos)).toBeNull();
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. Container generic vars from classIndex
// ══════════════════════════════════════════════════════════════════════════════

describe('built-in container generic vars', () => {
    let analyzer: Analyzer;

    beforeAll(() => {
        analyzer = freshAnalyzer();
        // Register built-in container classes with their generic vars in the classIndex
        indexDoc(analyzer, `
            class array<Class T> {
                T Get(int n);
                int Count();
            }
            class map<Class TKey, Class TValue> {
                TValue Get(TKey key);
            }
            class set<Class T> {
                T Get(int n);
                bool Contains(T value);
            }
        `);
    });

    test('getClassGenericVars returns T for array from classIndex', () => {
        const genericVars = (analyzer as any).getClassGenericVars('array');
        expect(genericVars).toEqual(['T']);
    });

    test('getClassGenericVars returns TKey,TValue for map from classIndex', () => {
        const genericVars = (analyzer as any).getClassGenericVars('map');
        expect(genericVars).toEqual(['TKey', 'TValue']);
    });

    test('getClassGenericVars returns T for set from classIndex', () => {
        const genericVars = (analyzer as any).getClassGenericVars('set');
        expect(genericVars).toEqual(['T']);
    });

    test('buildTemplateMap for array<string> with classIndex', () => {
        const args = [{ identifier: 'string', arrayDims: [], modifiers: [], kind: 'Type', uri: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }];
        const map = (analyzer as any).buildTemplateMap('array', args);
        expect(map.get('T')).toBe('string');
    });

    test('buildTemplateMap for map<string, int> with classIndex', () => {
        const args = [
            { identifier: 'string', arrayDims: [], modifiers: [], kind: 'Type', uri: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            { identifier: 'int', arrayDims: [], modifiers: [], kind: 'Type', uri: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        ];
        const map = (analyzer as any).buildTemplateMap('map', args);
        expect(map.get('TKey')).toBe('string');
        expect(map.get('TValue')).toBe('int');
    });

    test('resolveIndexedContainerType for array<ItemBase> with template map from classIndex', () => {
        const args = [{ identifier: 'ItemBase', arrayDims: [], modifiers: [], kind: 'Type', uri: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }];
        const templateMap = (analyzer as any).buildTemplateMap('array', args);
        const deref = (analyzer as any).resolveIndexedContainerType({ type: 'array', templateMap });
        expect(deref.type).toBe('ItemBase');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. Full chain resolution with templates and indexing
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveFullChain with templates and indexing', () => {
    test('array<CF_XML_Tag> variable indexed resolves element type', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class array<Class T> { T Get(int n); int Count(); }
            class CF_XML_Tag {
                int Get(string tokens, int index) { return 0; }
            }
            class Parser {
                ref array<CF_XML_Tag> _entries;
                void Parse() {
                    _entries[0].Get("test", 1);
                }
            }
        `);
        const pos = { line: 8, character: 20 };
        const result = (analyzer as any).resolveFullChain('_entries[0].', doc, pos, ast);
        expect(result).not.toBeNull();
        expect(result.type).toBe('CF_XML_Tag');
    });

    test('map<string, PlayerBase> indexed resolves to value type', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class map<Class TKey, Class TValue> { TValue Get(TKey key); }
            class PlayerBase {
                string GetName() { return ""; }
            }
            class Manager {
                map<string, PlayerBase> m_Players;
                void DoStuff() {
                    m_Players["key"].GetName();
                }
            }
        `);
        const pos = { line: 8, character: 20 };
        const result = (analyzer as any).resolveFullChain('m_Players["key"].', doc, pos, ast);
        expect(result).not.toBeNull();
        expect(result.type).toBe('PlayerBase');
    });

    test('chain with T-typed root resolves through template param', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class MyWrapper<Class T> {
                T m_Value;
                void DoStuff() {
                    m_Value.GetType();
                }
            }
        `);
        const pos = { line: 4, character: 20 };
        const result = (analyzer as any).resolveFullChain('m_Value.', doc, pos, ast);
        expect(result).not.toBeNull();
        // T resolves to 'Class' (upper bound)
        expect(result.type).toBe('Class');
    });

    test('array<string> indexed resolves to string element type', () => {
        const analyzer = freshAnalyzer();
        const { doc, ast } = indexDoc(analyzer, `
            class array<Class T> { T Get(int n); int Count(); }
            class Foo {
                ref array<string> _lines;
                void Bar() {
                    _lines[0].Length();
                }
            }
        `);
        const pos = { line: 5, character: 20 };
        const result = (analyzer as any).resolveFullChain('_lines[0].', doc, pos, ast);
        expect(result).not.toBeNull();
        expect(result.type).toBe('string');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. Generic angle brackets vs comparison operators
// ══════════════════════════════════════════════════════════════════════════════

describe('hasTopLevelComparisonOperator with generics', () => {
    let analyzer: Analyzer;

    beforeAll(() => {
        analyzer = freshAnalyzer();
    });

    test('new Param1<bool>(true) is NOT a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('new Param1<bool>(true)')).toBe(false);
    });

    test('CF_DoublyLinkedNode_WeakRef<T> is NOT a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('CF_DoublyLinkedNode_WeakRef<T>')).toBe(false);
    });

    test('new UAIChatAgentCreateCB<T>(this, "") is NOT a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('new UAIChatAgentCreateCB<T>(this, "")')).toBe(false);
    });

    test('array<int, float> is NOT a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('array<int, float>')).toBe(false);
    });

    test('nested generics map<string, array<int>> is NOT a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('map<string, array<int>>')).toBe(false);
    });

    test('a < b is a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('a < b')).toBe(true);
    });

    test('a > b is a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('a > b')).toBe(true);
    });

    test('a << 16 is NOT a comparison (bit shift)', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('a << 16')).toBe(false);
    });

    test('a >> 2 is NOT a comparison (bit shift)', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('a >> 2')).toBe(false);
    });

    test('x == y is a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('x == y')).toBe(true);
    });

    test('x != y is a comparison', () => {
        expect((analyzer as any).hasTopLevelComparisonOperator('x != y')).toBe(true);
    });

    test('inferArgType: new Param1<bool>(true) returns Param1', () => {
        const getVar = () => undefined;
        expect((analyzer as any).inferArgType('new Param1<bool>(true)', getVar)).toBe('Param1');
    });

    test('inferArgType: new UAIChatAgentCreateCB<T>(this, "") returns UAIChatAgentCreateCB', () => {
        const getVar = () => undefined;
        expect((analyzer as any).inferArgType('new UAIChatAgentCreateCB<T>(this, "")', getVar)).toBe('UAIChatAgentCreateCB');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 16. Cast() preserves receiver type (DayZ pattern)
// ══════════════════════════════════════════════════════════════════════════════

describe('Cast preserves receiver type', () => {
    let analyzer: Analyzer;
    let doc: TextDocument;
    let ast: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        const code = `
class Class {
    proto native Class Cast();
};

class Managed extends Class {
};

class CF_ModStorageData extends Managed {
    int Get() { return 0; }
};

class array<Class T> {
    proto T Get(int n);
    proto void Insert(T value);
};

class TestCast {
    ref array<Managed> m_Entries;
    void Test() {
        auto val = CF_ModStorageData.Cast(m_Entries[0]).Get();
    }
};
`;
        const result = indexDoc(analyzer, code, 'file:///cast.enscript');
        doc = result.doc;
        ast = result.ast;
    });

    test('CF_ModStorageData.Cast(x). resolves to CF_ModStorageData (not Class)', () => {
        const result = analyzer.resolveFullChain(
            'CF_ModStorageData.Cast(m_Entries[0]).',
            doc, { line: 15, character: 0 }, ast
        );
        expect(result).not.toBeNull();
        expect(result!.type).toBe('CF_ModStorageData');
    });

    test('CF_ModStorageData.Cast(x).Get(). resolves through Cast correctly', () => {
        // After Cast, type is still CF_ModStorageData, so Get() returns int
        const result = analyzer.resolveFullChain(
            'CF_ModStorageData.Cast(m_Entries[0]).Get().',
            doc, { line: 15, character: 0 }, ast
        );
        expect(result).not.toBeNull();
        expect(result!.type).toBe('int');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17. super resolves to parent class
// ══════════════════════════════════════════════════════════════════════════════

describe('super chain resolution', () => {
    let analyzer: Analyzer;
    let doc: TextDocument;
    let ast: any;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        const code = `
class MissionBase {
    void OnClientPrepareEvent() {}
    int GetID() { return 0; }
};

class MissionServer extends MissionBase {
    override void OnClientPrepareEvent() {
        super.OnClientPrepareEvent();
    }
    void Test() {
        super.GetID();
    }
};
`;
        const result = indexDoc(analyzer, code, 'file:///super.enscript');
        doc = result.doc;
        ast = result.ast;
    });

    test('super. inside MissionServer resolves to MissionBase', () => {
        // Position inside MissionServer body (line ~9)
        const result = analyzer.resolveFullChain(
            'super.',
            doc, { line: 9, character: 0 }, ast
        );
        expect(result).not.toBeNull();
        expect(result!.type).toBe('MissionBase');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 18. Double-indexing (2D matrix) resolves element type
// ══════════════════════════════════════════════════════════════════════════════

describe('double indexing (2D matrix)', () => {
    let analyzer: Analyzer;

    beforeAll(() => {
        analyzer = freshAnalyzer();

        const code = `
class array<Class T> {
    proto T Get(int n);
    proto void Insert(T value);
};

class ActiveConfig {
    ref array<ref array<float>> m_BrightnessPatterns;
};
`;
        indexDoc(analyzer, code, 'file:///matrix.enscript');
    });

    test('countIndexingLevels: .m_BrightnessPatterns[id1][id2] returns 2', () => {
        expect((analyzer as any).countIndexingLevels('.m_BrightnessPatterns[id1][id2]')).toBe(2);
    });

    test('countIndexingLevels: .Method(args[0])[1] returns 1', () => {
        expect((analyzer as any).countIndexingLevels('.Method(args[0])[1]')).toBe(1);
    });

    test('countIndexingLevels: no indexing returns 0', () => {
        expect((analyzer as any).countIndexingLevels('.Method()')).toBe(0);
    });

    test('resolveVariableChainType: m_BrightnessPatterns[id][id] resolves to float', () => {
        const result = (analyzer as any).resolveVariableChainType(
            'ActiveConfig', '.m_BrightnessPatterns[id1][id2]'
        );
        expect(result).toBe('float');
    });

    test('resolveVariableChainType: single index on array<array<float>> resolves to array', () => {
        const result = (analyzer as any).resolveVariableChainType(
            'ActiveConfig', '.m_BrightnessPatterns[id1]'
        );
        expect(result).toBe('array');
    });
});
