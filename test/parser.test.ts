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

test('playground', () => {
    const target_file = path.join("P:\\enscript\\test", "test_enscript.c");
    const text = fs.readFileSync(target_file, "utf8");
    const doc = TextDocument.create(url.pathToFileURL(target_file).href, 'enscript', 1, text);
    const ast = parse(doc);
    expect(ast.body[0]).toHaveProperty('kind', 'ClassDecl');
});