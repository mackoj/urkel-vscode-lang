'use strict';

const vscode = require('vscode');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const LANGUAGE_ID = 'urkel';
const DIAGNOSTIC_SOURCE = 'urkel';
const DEFAULT_SERVER_PATH = 'urkel-lsp';
let activeConnection = null;

function isUrkelDocument(document) {
  return document.languageId === LANGUAGE_ID || document.fileName.endsWith('.urkel');
}

function expandHome(rawPath) {
  if (!rawPath) return rawPath;
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function toSeverity(severity) {
  switch (severity) {
    case 1:
      return vscode.DiagnosticSeverity.Error;
    case 2:
      return vscode.DiagnosticSeverity.Warning;
    case 3:
      return vscode.DiagnosticSeverity.Information;
    case 4:
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function toLspSeverity(severity) {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 1;
    case vscode.DiagnosticSeverity.Warning:
      return 2;
    case vscode.DiagnosticSeverity.Information:
      return 3;
    case vscode.DiagnosticSeverity.Hint:
      return 4;
    default:
      return 1;
  }
}

function toRange(range) {
  if (!range || !range.start || !range.end) {
    return new vscode.Range(0, 0, 0, 0);
  }

  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function toTextEdit(edit) {
  return new vscode.TextEdit(toRange(edit.range), edit.newText ?? '');
}

function toWorkspaceEdit(edit) {
  const workspaceEdit = new vscode.WorkspaceEdit();

  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      workspaceEdit.set(vscode.Uri.parse(uri), textEdits.map(toTextEdit));
    }
  }

  return workspaceEdit;
}

function toDocumentation(documentation) {
  if (!documentation) return undefined;
  if (typeof documentation === 'string') {
    return new vscode.MarkdownString(documentation);
  }
  if (documentation.value) {
    return new vscode.MarkdownString(documentation.value);
  }
  return undefined;
}

function mapCompletionKind(kind) {
  switch (kind) {
    case 1: return vscode.CompletionItemKind.Text;
    case 2: return vscode.CompletionItemKind.Method;
    case 3: return vscode.CompletionItemKind.Function;
    case 4: return vscode.CompletionItemKind.Constructor;
    case 5: return vscode.CompletionItemKind.Field;
    case 6: return vscode.CompletionItemKind.Variable;
    case 7: return vscode.CompletionItemKind.Class;
    case 8: return vscode.CompletionItemKind.Interface;
    case 9: return vscode.CompletionItemKind.Module;
    case 10: return vscode.CompletionItemKind.Property;
    case 11: return vscode.CompletionItemKind.Unit;
    case 12: return vscode.CompletionItemKind.Value;
    case 13: return vscode.CompletionItemKind.Enum;
    case 14: return vscode.CompletionItemKind.Keyword;
    case 15: return vscode.CompletionItemKind.Snippet;
    case 16: return vscode.CompletionItemKind.Color;
    case 17: return vscode.CompletionItemKind.File;
    case 18: return vscode.CompletionItemKind.Reference;
    case 19: return vscode.CompletionItemKind.Folder;
    case 20: return vscode.CompletionItemKind.EnumMember;
    case 21: return vscode.CompletionItemKind.Constant;
    case 22: return vscode.CompletionItemKind.Struct;
    case 23: return vscode.CompletionItemKind.Event;
    case 24: return vscode.CompletionItemKind.Operator;
    case 25: return vscode.CompletionItemKind.TypeParameter;
    default: return vscode.CompletionItemKind.Text;
  }
}

function toMarkdownString(contents) {
  if (!contents) {
    return [];
  }

  if (typeof contents === 'string') {
    return [new vscode.MarkdownString(contents)];
  }

  if (Array.isArray(contents)) {
    return contents.flatMap(toMarkdownString);
  }

  if (typeof contents === 'object' && contents.kind && contents.value) {
    return [new vscode.MarkdownString(contents.value)];
  }

  return [new vscode.MarkdownString(String(contents))];
}

function toDiagnostic(diagnostic) {
  const result = new vscode.Diagnostic(
    toRange(diagnostic.range),
    diagnostic.message,
    toSeverity(diagnostic.severity)
  );
  result.source = diagnostic.source ?? DIAGNOSTIC_SOURCE;
  return result;
}

function toCompletionItem(item) {
  const completionItem = new vscode.CompletionItem(item.label, mapCompletionKind(item.kind));
  completionItem.detail = item.detail ?? undefined;
  completionItem.documentation = toDocumentation(item.documentation);
  completionItem.filterText = item.filterText ?? undefined;
  completionItem.insertText = item.insertText ?? undefined;
  completionItem.sortText = item.sortText ?? undefined;
  completionItem.preselect = item.preselect ?? false;

  if (item.textEdit) {
    completionItem.textEdit = toTextEdit(item.textEdit);
  }

  if (item.additionalTextEdits) {
    completionItem.additionalTextEdits = item.additionalTextEdits.map(toTextEdit);
  }

  if (item.command) {
    completionItem.command = item.command;
  }

  return completionItem;
}

function toCodeAction(action) {
  const codeAction = new vscode.CodeAction(action.title, action.kind ? new vscode.CodeActionKind(action.kind) : undefined);
  codeAction.isPreferred = action.isPreferred ?? false;

  if (action.edit) {
    codeAction.edit = toWorkspaceEdit(action.edit);
  }

  if (action.command) {
    codeAction.command = action.command;
  }

  if (action.diagnostics) {
    codeAction.diagnostics = action.diagnostics.map(toDiagnostic);
  }

  return codeAction;
}

class JsonRpcConnection {
  constructor(outputChannel, diagnostics) {
    this.outputChannel = outputChannel;
    this.diagnostics = diagnostics;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.readyPromise = null;
    this.openDocuments = new Set();
  }

  async start() {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this._start().catch(error => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  async _start() {
    const configuration = vscode.workspace.getConfiguration('urkel.languageServer');
    const command = expandHome(configuration.get('path') || DEFAULT_SERVER_PATH);
    const args = configuration.get('args') || [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    this.outputChannel.appendLine(`Starting urkel-lsp: ${command} ${args.join(' ')}`.trim());

    this.process = spawn(command, args, {
      cwd: workspaceFolder?.uri.fsPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', chunk => this._onData(chunk));
    this.process.stderr.on('data', chunk => {
      this.outputChannel.append(chunk.toString('utf8'));
    });
    this.process.on('error', error => {
      this.outputChannel.appendLine(`urkel-lsp failed to start: ${error.message}`);
      this.process = null;
      this.ready = false;
      this.readyPromise = null;
      this._rejectAllPending(error);
    });
    this.process.on('exit', (code, signal) => {
      this.outputChannel.appendLine(`urkel-lsp exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`);
      this.ready = false;
      this.process = null;
      this.readyPromise = null;
      this._rejectAllPending(new Error(`urkel-lsp exited with code ${code ?? 'unknown'}`));
    });

    await this.request('initialize', this._initializeParams());
    this.notify('initialized', {});
    this.ready = true;
  }

  async stop() {
    if (!this.process) {
      return;
    }

    try {
      await this.request('shutdown', null);
    } catch (error) {
      this.outputChannel.appendLine(`Shutdown request failed: ${error.message}`);
    }

    this.notify('exit', {});
    this.process.kill();
    this.process = null;
    this.ready = false;
    this.readyPromise = null;
    this.openDocuments.clear();
  }

  async restart() {
    await this.stop();
    await this.start();
    await this.syncVisibleDocuments();
  }

  async syncVisibleDocuments() {
    for (const document of vscode.workspace.textDocuments) {
      if (isUrkelDocument(document)) {
        await this.didOpen(document);
      }
    }
  }

  async didOpen(document) {
    if (!isUrkelDocument(document)) {
      return;
    }

    await this.start();
    const uri = document.uri.toString();

    if (this.openDocuments.has(uri)) {
      return;
    }

    this.openDocuments.add(uri);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: LANGUAGE_ID,
        version: document.version,
        text: document.getText()
      }
    });
  }

  async didChange(document) {
    if (!isUrkelDocument(document)) {
      return;
    }

    await this.start();
    const uri = document.uri.toString();

    if (!this.openDocuments.has(uri)) {
      await this.didOpen(document);
      return;
    }

    this.notify('textDocument/didChange', {
      textDocument: {
        uri,
        version: document.version
      },
      contentChanges: [
        {
          text: document.getText()
        }
      ]
    });
  }

  async didClose(document) {
    if (!isUrkelDocument(document)) {
      return;
    }

    await this.start();
    const uri = document.uri.toString();
    this.openDocuments.delete(uri);
    this.notify('textDocument/didClose', {
      textDocument: { uri }
    });
    this.diagnostics.delete(document.uri);
  }

  async request(method, params) {
    await this.start();

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this._send({
        jsonrpc: '2.0',
        id,
        method,
        params
      });
    });
  }

  notify(method, params) {
    if (!this.process) {
      return;
    }

    this._send({
      jsonrpc: '2.0',
      method,
      params
    });
  }

  async provideCompletion(document, position) {
    const response = await this.request('textDocument/completion', {
      textDocument: { uri: document.uri.toString() },
      position
    });

    if (!response) {
      return undefined;
    }

    const items = Array.isArray(response) ? response : response.items ?? [];
    return new vscode.CompletionList(
      response.isIncomplete ?? false,
      items.map(toCompletionItem)
    );
  }

  async provideHover(document, position) {
    const response = await this.request('textDocument/hover', {
      textDocument: { uri: document.uri.toString() },
      position
    });

    if (!response) {
      return undefined;
    }

    const contents = toMarkdownString(response.contents);
    return new vscode.Hover(contents, response.range ? toRange(response.range) : undefined);
  }

  async provideFormatting(document) {
    const response = await this.request('textDocument/formatting', {
      textDocument: { uri: document.uri.toString() },
      options: {
        insertSpaces: true,
        tabSize: 2
      }
    });

    return Array.isArray(response) ? response.map(toTextEdit) : [];
  }

  async provideRangeFormatting(document, range) {
    const response = await this.request('textDocument/rangeFormatting', {
      textDocument: { uri: document.uri.toString() },
      range,
      options: {
        insertSpaces: true,
        tabSize: 2
      }
    });

    return Array.isArray(response) ? response.map(toTextEdit) : [];
  }

  async provideCodeActions(document, range, diagnostics) {
    const response = await this.request('textDocument/codeAction', {
      textDocument: { uri: document.uri.toString() },
      range,
      context: {
        diagnostics: diagnostics.map(diagnostic => ({
          range: {
            start: {
              line: diagnostic.range.start.line,
              character: diagnostic.range.start.character
            },
            end: {
              line: diagnostic.range.end.line,
              character: diagnostic.range.end.character
            }
          },
          severity: toLspSeverity(diagnostic.severity),
          message: diagnostic.message,
          source: diagnostic.source ?? DIAGNOSTIC_SOURCE
        }))
      }
    });

    if (!response) {
      return [];
    }

    return response.map(action => {
      if (action.edit || action.diagnostics || action.kind) {
        return toCodeAction(action);
      }

      if (action.command) {
        return {
          title: action.title ?? action.command.title,
          command: action.command.command,
          arguments: action.command.arguments ?? []
        };
      }

      return action;
    });
  }

  async provideSemanticTokens(document) {
    const response = await this.request('textDocument/semanticTokens/full', {
      textDocument: { uri: document.uri.toString() }
    });

    const data = response?.data ?? response;
    return Array.isArray(data) ? new vscode.SemanticTokens(new Uint32Array(data)) : undefined;
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'method')) {
      this._send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unhandled client request: ${message.method}`
        }
      });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'urkel-lsp request failed'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  handleNotification(method, params) {
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        const uri = vscode.Uri.parse(params.uri);
        const diagnostics = (params.diagnostics || []).map(toDiagnostic);
        this.diagnostics.set(uri, diagnostics);
        break;
      }
      case 'window/logMessage':
        this.outputChannel.appendLine(params?.message ?? '');
        break;
      case 'window/showMessage':
        this.outputChannel.appendLine(params?.message ?? '');
        if (params?.type === 1) {
          vscode.window.showErrorMessage(params.message);
        } else if (params?.type === 2) {
          vscode.window.showWarningMessage(params.message);
        } else {
          vscode.window.showInformationMessage(params.message);
        }
        break;
      default:
        break;
    }
  }

  _initializeParams() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    return {
      processId: process.pid,
      clientInfo: {
        name: 'Urkel VS Code',
        version: '0.0.1'
      },
      rootUri: workspaceFolder?.uri.toString() ?? null,
      capabilities: {
        workspace: {
          workspaceFolders: true
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: false
          },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext']
            }
          },
          hover: {
            contentFormat: ['markdown', 'plaintext']
          },
          formatting: {
            dynamicRegistration: false
          },
          semanticTokens: {
            requests: {
              full: true,
              range: false
            },
            tokenTypes: [
              'keyword',
              'type',
              'namespace',
              'event',
              'parameter',
              'function',
              'comment'
            ],
            tokenModifiers: []
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ['quickfix', 'refactor', 'source']
              }
            }
          }
        }
      }
    };
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        this.handleMessage(JSON.parse(body));
      } catch (error) {
        this.outputChannel.appendLine(`Failed to parse urkel-lsp message: ${error.message}`);
      }
    }
  }

  _send(message) {
    if (!this.process || !this.process.stdin.writable) {
      return;
    }

    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.process.stdin.write(Buffer.concat([header, body]));
  }

  _rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel('Urkel');
  const diagnostics = vscode.languages.createDiagnosticCollection('urkel');
  const connection = new JsonRpcConnection(outputChannel, diagnostics);
  activeConnection = connection;

  context.subscriptions.push(outputChannel, diagnostics);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (isUrkelDocument(document)) {
        connection.didOpen(document).catch(error => outputChannel.appendLine(error.message));
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (isUrkelDocument(event.document)) {
        connection.didChange(event.document).catch(error => outputChannel.appendLine(error.message));
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (isUrkelDocument(document)) {
        connection.didClose(document).catch(error => outputChannel.appendLine(error.message));
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('urkel.languageServer')) {
        connection.restart().catch(error => {
          outputChannel.appendLine(`Failed to restart urkel-lsp: ${error.message}`);
          vscode.window.showErrorMessage(`Urkel LSP restart failed: ${error.message}`);
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: LANGUAGE_ID, scheme: 'file' }, { language: LANGUAGE_ID, scheme: 'untitled' }],
      {
        provideCompletionItems: async (document, position) => {
          try {
            return await connection.provideCompletion(document, position);
          } catch (error) {
            outputChannel.appendLine(`Completion failed: ${error.message}`);
            return undefined;
          }
        }
      },
      '@',
      ':',
      '>'
    ),
    vscode.languages.registerHoverProvider(
      [{ language: LANGUAGE_ID, scheme: 'file' }, { language: LANGUAGE_ID, scheme: 'untitled' }],
      {
        provideHover: async (document, position) => {
          try {
            return await connection.provideHover(document, position);
          } catch (error) {
            outputChannel.appendLine(`Hover failed: ${error.message}`);
            return undefined;
          }
        }
      }
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      [{ language: LANGUAGE_ID, scheme: 'file' }, { language: LANGUAGE_ID, scheme: 'untitled' }],
      {
        provideDocumentFormattingEdits: async document => {
          try {
            return await connection.provideFormatting(document);
          } catch (error) {
            outputChannel.appendLine(`Formatting failed: ${error.message}`);
            return [];
          }
        }
      }
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      [{ language: LANGUAGE_ID, scheme: 'file' }, { language: LANGUAGE_ID, scheme: 'untitled' }],
      {
        provideDocumentRangeFormattingEdits: async (document, range) => {
          try {
            return await connection.provideRangeFormatting(document, range);
          } catch (error) {
            outputChannel.appendLine(`Range formatting failed: ${error.message}`);
            return [];
          }
        }
      }
    ),
    vscode.languages.registerCodeActionsProvider(
      [{ language: LANGUAGE_ID, scheme: 'file' }, { language: LANGUAGE_ID, scheme: 'untitled' }],
      {
        provideCodeActions: async (document, range, context) => {
          try {
            return await connection.provideCodeActions(document, range, context.diagnostics);
          } catch (error) {
            outputChannel.appendLine(`Code actions failed: ${error.message}`);
            return [];
          }
        }
      },
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor, vscode.CodeActionKind.Source]
      }
    ),
    vscode.languages.registerDocumentSemanticTokensProvider(
      [{ language: LANGUAGE_ID, scheme: 'file' }, { language: LANGUAGE_ID, scheme: 'untitled' }],
      {
        provideDocumentSemanticTokens: async document => {
          try {
            return await connection.provideSemanticTokens(document);
          } catch (error) {
            outputChannel.appendLine(`Semantic tokens failed: ${error.message}`);
            return undefined;
          }
        }
      },
      new vscode.SemanticTokensLegend(
        ['keyword', 'type', 'namespace', 'event', 'parameter', 'function', 'comment'],
        []
      )
    )
  );

  try {
    await connection.start();
    await connection.syncVisibleDocuments();
  } catch (error) {
    outputChannel.appendLine(`Failed to start urkel-lsp: ${error.message}`);
    vscode.window.showErrorMessage(`Urkel LSP failed to start: ${error.message}`);
  }

  context.subscriptions.push(vscode.commands.registerCommand('urkel.languageServer.restart', async () => {
    await connection.restart();
  }));

  return connection;
}

async function deactivate() {
  if (activeConnection) {
    await activeConnection.stop();
    activeConnection = null;
  }
}

module.exports = {
  activate,
  deactivate
};
