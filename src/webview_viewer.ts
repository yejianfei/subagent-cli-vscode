import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import type { Logger } from './logger'

export interface SessionListItem {
  session: string
  subagent?: string
  state?: string
  cwd?: string
  role?: string
  last_at?: number
  /** Host-injected: true if this extension already has a (Pseudo)terminal for this session. */
  attached?: boolean
}

export interface InternalViewerDeps {
  fetchSessions: () => Promise<SessionListItem[]>
  openSession: (sessionId: string, subagent: string) => void
  log: Logger
}

interface InboundMessage {
  type: 'ready' | 'refresh' | 'open'
  sessionId?: string
  subagent?: string
}

/**
 * Webview-based session list / dispatcher.
 *
 * It does NOT render TUIs — it only lists sessions and asks the host to open
 * a (Pseudo)terminal for the chosen one. All HTTP calls happen in the host,
 * the webview only talks to the host via postMessage (no network, no CSP risk).
 */
export class InternalViewer {
  private panel: vscode.WebviewPanel | undefined

  constructor(private readonly deps: InternalViewerDeps) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal()
      void this.refresh()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      'subagent-cli.viewer',
      vscode.l10n.t('Subagent Viewer'),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    )
    panel.webview.html = this.renderHtml()
    panel.webview.onDidReceiveMessage((msg: InboundMessage) => this.handleMessage(msg))
    panel.onDidDispose(() => {
      this.panel = undefined
    })
    this.panel = panel
  }

  dispose(): void {
    this.panel?.dispose()
    this.panel = undefined
  }

  private handleMessage(msg: InboundMessage): void {
    if (msg.type === 'ready' || msg.type === 'refresh') {
      void this.refresh()
      return
    }
    if (msg.type === 'open' && msg.sessionId) {
      this.deps.openSession(msg.sessionId, msg.subagent ?? 'subagent')
    }
  }

  private async refresh(): Promise<void> {
    if (!this.panel) return
    try {
      const sessions = await this.deps.fetchSessions()
      this.panel.webview.postMessage({ type: 'sessions', data: sessions })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log(`viewer refresh failed: ${message}`)
      this.panel.webview.postMessage({ type: 'error', message })
    }
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex')
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`
    const title = vscode.l10n.t('Subagent Sessions')
    const refreshLabel = vscode.l10n.t('Refresh')
    const loadingLabel = vscode.l10n.t('Loading…')
    const emptyLabel = vscode.l10n.t('No active sessions.')
    const errorPrefix = vscode.l10n.t('Error')
    // i18n templates for relative-time formatter (replaced inside the webview JS).
    const tplJustNow = JSON.stringify(vscode.l10n.t('just now'))
    const tplMinAgo = JSON.stringify(vscode.l10n.t('{0}m ago'))
    const tplHourAgo = JSON.stringify(vscode.l10n.t('{0}h ago'))
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${title}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 16px; margin: 0; font-size: var(--vscode-font-size); }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  h1 { font-size: 13px; font-weight: 600; margin: 0; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-foreground); }
  button.icon { background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); border: none; padding: 4px 6px; cursor: pointer; font-size: 16px; line-height: 1; border-radius: 3px; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.icon:active { background: var(--vscode-toolbar-activeBackground); }
  ul { list-style: none; padding: 0; margin: 0; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  li { padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; display: grid; grid-template-columns: 88px 88px minmax(180px, 1.4fr) minmax(120px, 1fr) 88px 72px; gap: 12px; align-items: center; }
  li:last-child { border-bottom: none; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  li.empty { display: block; color: var(--vscode-descriptionForeground); cursor: default; font-style: italic; }
  li.empty:hover { background: transparent; }
  li.closed { cursor: not-allowed; opacity: 0.55; }
  li.closed:hover { background: transparent; }
  .subagent { font-weight: 600; color: var(--vscode-symbolIcon-classForeground, var(--vscode-foreground)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .id { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .cwd { color: var(--vscode-descriptionForeground); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .role { color: var(--vscode-foreground); font-size: 12px; opacity: 0.9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .last { color: var(--vscode-descriptionForeground); font-size: 12px; text-align: right; }
  .state { padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; text-align: center; color: var(--vscode-editor-background); }
  .state-IDLE { background: var(--vscode-charts-green, #2ea043); }
  .state-RUNNING { background: var(--vscode-charts-orange, #db8400); }
  .state-PENDING { background: var(--vscode-charts-yellow, #cba300); }
  .state-INIT { background: var(--vscode-charts-blue, #1e90ff); }
  .state-CLOSED { background: var(--vscode-charts-foreground, var(--vscode-descriptionForeground)); opacity: 0.7; }
  .state-ERROR { background: var(--vscode-charts-red, #d73a49); }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <button id="refresh" type="button" class="icon" title="${refreshLabel}" aria-label="${refreshLabel}">↻</button>
</header>
<ul id="list"><li class="empty">${loadingLabel}</li></ul>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const tplJustNow = ${tplJustNow};
  const tplMinAgo = ${tplMinAgo};
  const tplHourAgo = ${tplHourAgo};
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatRel = (ts) => {
    if (!ts) return '';
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return tplJustNow;
    if (diff < 3600) return tplMinAgo.replace('{0}', Math.floor(diff / 60));
    if (diff < 86400) return tplHourAgo.replace('{0}', Math.floor(diff / 3600));
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const render = (items) => {
    if (!items || items.length === 0) {
      list.innerHTML = '<li class="empty">${emptyLabel}</li>';
      return;
    }
    list.innerHTML = items.map(s => {
      const id = s.session || '';
      const sub = s.subagent || 'subagent';
      const state = s.state || '';
      const cwd = s.cwd || '';
      const role = s.role || '';
      const closed = state === 'CLOSED';
      // Show the daemon's real state. Clicking a not-yet-attached session is
      // safe: both the viewer-open and the IPC handshake dedup against
      // sessionTerminals, so no duplicate terminal is created.
      const cls = closed ? ' class="closed"' : '';
      return '<li' + cls + ' data-id="' + escape(id) + '" data-sub="' + escape(sub) + '" data-state="' + escape(state) + '">' +
        '<span class="subagent">' + escape(sub) + '</span>' +
        '<span class="id">' + escape(id.slice(0, 8)) + '</span>' +
        '<span class="cwd" title="' + escape(cwd) + '">' + escape(cwd) + '</span>' +
        '<span class="role" title="' + escape(role) + '">' + escape(role) + '</span>' +
        '<span class="last">' + escape(formatRel(s.last_at)) + '</span>' +
        (state ? '<span class="state state-' + escape(state) + '">' + escape(state) + '</span>' : '') +
        '</li>';
    }).join('');
    list.querySelectorAll('li[data-id]:not(.closed)').forEach(el => {
      el.addEventListener('click', () => vscode.postMessage({ type: 'open', sessionId: el.dataset.id, subagent: el.dataset.sub }));
    });
  };
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'sessions') render(msg.data);
    if (msg.type === 'error') list.innerHTML = '<li class="empty">${errorPrefix}: ' + escape(msg.message) + '</li>';
  });
  // Auto-refresh every 5s while panel is visible.
  setInterval(() => {
    if (document.visibilityState === 'visible') vscode.postMessage({ type: 'refresh' });
  }, 5000);
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`
  }
}
