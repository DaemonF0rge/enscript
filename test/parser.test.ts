import { parse } from '../server/src/analysis/ast/parser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'node:url';

const CURRENT_DIR = "P:\\enscript\\test";

test('parses class declaration', () => {
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, 'class Foo { };');
    const ast = parse(doc);
    expect(ast.body[0]).toHaveProperty('kind', 'ClassDecl');
});

test('detects foreach local variables', () => {
    const code = `class Foo {
    void DoStuff() {
        array<PlayerBase> players;
        foreach (PlayerBase player : players) {
            player.DoSomething();
        }
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    // Should detect: players (from 'array<PlayerBase> players;') and player (from foreach)
    const localNames = func.locals.map((l: any) => l.name);
    expect(localNames).toContain('players');
    expect(localNames).toContain('player');
    const playerLocal = func.locals.find((l: any) => l.name === 'player');
    expect(playerLocal.type.identifier).toBe('PlayerBase');
});

test('detects auto-typed local variables', () => {
    const code = `class Foo {
    void Bar() {
        auto x = GetSomething();
        int y = 5;
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    const localNames = func.locals.map((l: any) => l.name);
    expect(localNames).toContain('x');
    expect(localNames).toContain('y');
    const autoLocal = func.locals.find((l: any) => l.name === 'x');
    expect(autoLocal.type.identifier).toBe('auto');
});

test('detects two-variable foreach locals', () => {
    const code = `class Foo {
    void Bar() {
        map<string, int> m;
        foreach (string key, int val : m) {
            Print(key);
        }
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    const localNames = func.locals.map((l: any) => l.name);
    expect(localNames).toContain('m');
    expect(localNames).toContain('key');
    expect(localNames).toContain('val');
});

test('does not false-positive on case labels', () => {
    const code = `class Foo {
    void Bar() {
        switch (x) {
            case 0:
                break;
            case MyEnum.VALUE:
                break;
            default:
                break;
        }
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    // Should NOT detect any local variables (no valid declarations)
    expect(func.locals.length).toBe(0);
});

// ── Phase 3: scopeEnd tests ────────────────────────────────────────────

test('scopeEnd is set for locals in nested blocks', () => {
    const code = `class Foo {
    void Bar() {
        int outer = 1;
        if (true) {
            int inner = 2;
        }
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.locals.length).toBe(2);

    const outerLocal = func.locals.find((l: any) => l.name === 'outer');
    const innerLocal = func.locals.find((l: any) => l.name === 'inner');
    expect(outerLocal).toBeDefined();
    expect(innerLocal).toBeDefined();

    // outer is in the function body scope — its scopeEnd is the function's closing '}'
    expect(outerLocal.scopeEnd).toBeDefined();
    // inner is in the if-block scope — its scopeEnd is the if-block's closing '}'
    expect(innerLocal.scopeEnd).toBeDefined();

    // inner's scope should end BEFORE outer's scope
    // (inner ends at the if-block '}', outer ends at the function '}')
    expect(innerLocal.scopeEnd.line).toBeLessThan(outerLocal.scopeEnd.line);
});

test('scopeEnd for loop variables is function scope', () => {
    // for-loop variables are declared before the '{', so they belong
    // to the parent (function body) scope, not the loop block scope.
    const code = `class Foo {
    void Bar() {
        for (int j = 0; j < 10; j++) {
            int inside = 1;
        }
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;

    const jLocal = func.locals.find((l: any) => l.name === 'j');
    const insideLocal = func.locals.find((l: any) => l.name === 'inside');
    expect(jLocal).toBeDefined();
    expect(insideLocal).toBeDefined();

    // j is in the function body scope (declared before the for-loop '{')
    // inside is in the for-loop block scope
    // So j.scopeEnd should be >= insideLocal.scopeEnd
    expect(jLocal.scopeEnd.line).toBeGreaterThanOrEqual(insideLocal.scopeEnd.line);
});

test('scopeEnd allows sibling-block variables with same name', () => {
    // Variables in sibling (non-overlapping) blocks have separate scopes
    const code = `class Foo {
    void Bar() {
        if (true) {
            int x = 1;
        }
        if (true) {
            int x = 2;
        }
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;

    // Both 'x' locals should exist
    const xLocals = func.locals.filter((l: any) => l.name === 'x');
    expect(xLocals.length).toBe(2);

    // Their scopes should NOT overlap: first x's scopeEnd < second x's start
    const first = xLocals[0];
    const second = xLocals[1];
    expect(first.scopeEnd.line).toBeLessThanOrEqual(second.start.line);
});

test('comparison operators do not false-positive as generic types', () => {
    // Bug: `tier.radius > maxSafeRadius;` walked back to `<` in `i < tierCount`,
    // creating a false local with type='i'. The angle bracket walk-back must stop
    // at statement boundaries (`;`, `{`, `}`).
    const code = `class Foo {
    void Bar() {
        int tierCount = 10;
        for (int i = 0; i < tierCount; i++) {
            float radius = 50.0;
            float maxSafe = 100.0;
            bool wouldOverlap = radius > maxSafe;
        }
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;

    // Should detect: tierCount, i, radius, maxSafe, wouldOverlap
    const localNames = func.locals.map((l: any) => l.name);
    expect(localNames).toContain('tierCount');
    expect(localNames).toContain('i');
    expect(localNames).toContain('radius');
    expect(localNames).toContain('maxSafe');
    expect(localNames).toContain('wouldOverlap');

    // MUST NOT have 'maxSafe' with type='i' (the false positive)
    // All locals with name 'maxSafe' should have type 'float', never 'i'
    const maxSafeLocals = func.locals.filter((l: any) => l.name === 'maxSafe');
    for (const loc of maxSafeLocals) {
        expect(loc.type.identifier).toBe('float');
    }

    // The 'i' local should have type 'int'
    const iLocal = func.locals.find((l: any) => l.name === 'i');
    expect(iLocal.type.identifier).toBe('int');

    // Should NOT have any false locals with type='i' and name='maxSafe'
    const falseLocals = func.locals.filter((l: any) => l.type.identifier === 'i');
    expect(falseLocals.length).toBe(0);
});

test('comparison > across functions does not false-positive', () => {
    // Bug: `return currentCount > maxTerritories;` in one method walked back
    // across function boundaries to find `<` in `currentCount < maxTerritories`
    // in a previous method, falsely detecting type='currentCount'.
    const code = `class Foo {
    bool MethodA(string arg) {
        int currentCount = 5;
        bool canClaim = currentCount < 10;
        return canClaim;
    }
    bool MethodB(string arg) {
        int currentCount = 5;
        return currentCount > 10;
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;

    const methodA = cls.members.find((m: any) => m.name === 'MethodA');
    const methodB = cls.members.find((m: any) => m.name === 'MethodB');

    // MethodA locals: currentCount (int), canClaim (bool)
    expect(methodA.locals.map((l: any) => l.name)).toEqual(
        expect.arrayContaining(['currentCount', 'canClaim'])
    );

    // MethodB locals: currentCount (int) only — NO false locals
    const methodBNames = methodB.locals.map((l: any) => l.name);
    expect(methodBNames).toContain('currentCount');
    // Should NOT have a false local with type='currentCount'
    const falseLocals = methodB.locals.filter((l: any) => l.type.identifier === 'currentCount');
    expect(falseLocals.length).toBe(0);
});

test('multi-line string detection moved to runDiagnostics', () => {
    // Multi-line string detection was moved from the parser to Analyzer.runDiagnostics()
    // so it works even when the parser throws a ParseError.
    // The parser itself should NOT produce multi-line string diagnostics anymore.
    const code = 'class Foo {\n    void Bar() {\n        string s = "hello\nworld";\n    }\n};';
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const mlDiag = ast.diagnostics.find(d => d.message.includes('Multi-line string'));
    expect(mlDiag).toBeUndefined();
});

test('no false positive for single-line strings', () => {
    const code = 'class Foo {\n    void Bar() {\n        string s = "hello" + " " + "world";\n    }\n};';
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    // Should NOT have a multi-line string diagnostic
    const mlDiag = ast.diagnostics.find(d => d.message.includes('Multi-line string'));
    expect(mlDiag).toBeUndefined();
});

// ── Return statement detection tests ──────────────────────────────────────

test('detects return statements in function bodies', () => {
    const code = `class Foo {
    int GetValue() {
        return 42;
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.hasBody).toBe(true);
    expect(func.returnStatements.length).toBe(1);
    expect(func.returnStatements[0].isEmpty).toBe(false);
});

test('detects bare return in void function', () => {
    const code = `class Foo {
    void DoStuff() {
        if (true)
            return;
        Print("hello");
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.hasBody).toBe(true);
    expect(func.returnStatements.length).toBe(1);
    expect(func.returnStatements[0].isEmpty).toBe(true);
});

test('detects multiple return statements', () => {
    const code = `class Foo {
    int GetValue(bool flag) {
        if (flag)
            return 1;
        return 0;
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.returnStatements.length).toBe(2);
    expect(func.returnStatements[0].isEmpty).toBe(false);
    expect(func.returnStatements[1].isEmpty).toBe(false);
});

test('proto functions have no body', () => {
    const code = `class Foo {
    proto int GetValue();
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.hasBody).toBe(false);
    expect(func.returnStatements.length).toBe(0);
});

test('detects return this in method', () => {
    const code = `class Foo {
    Foo Clone() {
        return this;
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.returnStatements.length).toBe(1);
    const ret = func.returnStatements[0];
    expect(ret.isEmpty).toBe(false);
    const exprText = code.substring(ret.exprStart, ret.exprEnd).trim();
    expect(exprText).toBe('this');
});

test('detects return this.Method() chain', () => {
    const code = `class Foo {
    string GetName() {
        return this.m_name;
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.returnStatements.length).toBe(1);
    const ret = func.returnStatements[0];
    const exprText = code.substring(ret.exprStart, ret.exprEnd).trim();
    expect(exprText).toBe('this.m_name');
});

test('detects return with expression text', () => {
    const code = `class Foo {
    string GetName() {
        return m_name;
    }
};`;
    const doc = TextDocument.create('file:///test.enscript', 'enscript', 1, code);
    const ast = parse(doc);
    const cls = ast.body[0] as any;
    const func = cls.members[0] as any;
    expect(func.returnStatements.length).toBe(1);
    const ret = func.returnStatements[0];
    expect(ret.isEmpty).toBe(false);
    // The expression text between exprStart and exprEnd should contain 'm_name'
    const exprText = code.substring(ret.exprStart, ret.exprEnd).trim();
    expect(exprText).toBe('m_name');
});

test('playground', () => {
    const target_file = path.join("P:\\enscript\\test", "test_enscript.c");
    const text = fs.readFileSync(target_file, "utf8");
    const doc = TextDocument.create(url.pathToFileURL(target_file).href, 'enscript', 1, text);
    const ast = parse(doc);
    expect(ast.body[0]).toHaveProperty('kind', 'ClassDecl');
});