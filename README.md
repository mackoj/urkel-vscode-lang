# Urkel VS Code Language Support

This extension makes VS Code recognize `*.urkel` files as the `urkel` language and launches `urkel-lsp` while you edit.

## Setup flow

1. Build `urkel-lsp` from the Urkel repository:

   ```bash
   cd /Users/mac-JMACKO01/Developer/Urkel
   swift build --product urkel-lsp
   ```

2. Install or run this extension from `/Users/mac-JMACKO01/Developer/urkel-lsp`:

   - press `F5` to launch an Extension Development Host, or
   - package a `.vsix` and install it in VS Code.

3. Point the extension at the server binary in VS Code settings:

   ```json
   {
     "urkel.languageServer.path": "/Users/mac-JMACKO01/Developer/Urkel/.build/debug/urkel-lsp"
   }
   ```

   You can also use `~/.mint/bin/urkel-lsp` if you installed the binary with Mint.

## Create a `.vsix`

From this folder, run:

```bash
npm run vsix
```

That writes a packaged extension into `./dist/` with a filename like `urkel-language-support-0.0.1.vsix`.

## What it does

- Registers `*.urkel` as a language.
- Adds a syntax grammar and editor configuration for `urkel`.
- Starts `urkel-lsp` over stdio.
- Forwards diagnostics, hover, completion, formatting, semantic tokens, and code actions to VS Code.

## Verifying it works

Open a `.urkel` file in VS Code. The file should use the `urkel` language id, and the extension should launch `urkel-lsp` automatically. If you edit the file and `urkel-lsp` is connected correctly, diagnostics and completions should appear in the editor.

## Notes

The parser and validator logic live in the Urkel repository. This extension only launches the server binary and speaks LSP to it.
