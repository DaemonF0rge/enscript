# Enfusion Script

[![Discord](https://img.shields.io/badge/Submit%20Feedback-7289DA?logo=discord&logoColor=white&label=&style=flat)](https://discord.gg/BVSeTgAgJw)

Enfusion Script is an unofficial VSCode extension for DayZ modders that indexes enfusion-script and allows advanced IDE features such as syntax highlighting, jump to definition, etc.

## 🔧 Initial setup

The extension works out of the box for the opened project, but additional setup is required to also index the vanilla enscript codebase.

Find your extracted scripts folder (usually `P:\scripts`) and add it to user settings:

![settings](https://raw.githubusercontent.com/yuvalino/enscript/refs/heads/main/media/settings.jpg)

**Important:** Reload the window after saving!

### (YouTube) VSCode Enfusion Script Quickstart Guide
[![VSCode Enfusion Script Quickstart Guide](https://img.youtube.com/vi/uIuiJoe-B30/0.jpg)](https://www.youtube.com/watch?v=uIuiJoe-B30 "VSCode Enfusion Script Quickstart Guide")

## 🧩 Extension

1. **Syntax Highlighting:** Syntax highlighting for EnScript language!

![syntax](https://raw.githubusercontent.com/yuvalino/enscript/refs/heads/main/media/syntax.jpg)

### DayZ `config.cpp` / `mod.cpp` basic highlighting

This extension now includes a separate lightweight language mode for DayZ config-style `config.cpp` and `mod.cpp` files.

- It provides basic highlighting for class blocks, key/value assignments, arrays, strings, numbers, comments, and preprocessor lines.
- It also provides lightweight warnings for common config mistakes (especially AI-generated ones), such as doubled backslashes in paths, mixed slash styles, accidental absolute Windows paths, and suspicious assignment/class declaration forms.
- It is intentionally minimal and isolated from the EnScript language server features.
- It only auto-associates files named `config.cpp` and `mod.cpp`, so regular C++ projects are not affected.

2. **Hover & Jump to Definition:** Indexed symbols have their own hover and may be Ctrl+Click'ed to jump to definition.

![definition.gif](https://raw.githubusercontent.com/yuvalino/enscript/refs/heads/main/media/definition.gif)

3. **Workspace Symbols**: Supports convenient symbol definition search.

![definition.gif](https://raw.githubusercontent.com/yuvalino/enscript/refs/heads/main/media/workspaceSymbols.gif)
