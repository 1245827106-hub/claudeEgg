/**
 * Chat terminal UI
 * Ported from TerminalView.swift
 */

const messages = document.getElementById('messages');
const inputField = document.getElementById('inputField');
const copyBtn = document.getElementById('copyBtn');
const terminal = document.getElementById('terminal');

let currentStreamingEl = null;
let isStreaming = false;
let lastAssistantText = '';
let currentAssistantText = '';

// ---- Input handling ----

inputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = inputField.value.trim();
    if (!text) return;
    inputField.value = '';

    // Handle slash commands locally
    if (handleSlashCommand(text)) return;

    // Display user message
    appendUser(text);
    isStreaming = true;
    currentAssistantText = '';
    currentStreamingEl = null;

    // Send to main process
    window.lilAgents.sendMessage(text);
  }
});

// ---- Slash commands ----

function handleSlashCommand(text) {
  if (!text.startsWith('/')) return false;
  const cmd = text.toLowerCase().trim();

  switch (cmd) {
    case '/clear':
      messages.innerHTML = '';
      window.lilAgents.sendCommand('/clear');
      return true;

    case '/copy':
      window.lilAgents.requestCopyLast();
      return true;

    case '/help': {
      const help = document.createElement('div');
      help.className = 'msg msg-system';
      help.innerHTML = `
        <div style="font-weight:600;color:var(--accent)">lil agents — slash commands</div>
        <div><strong>/clear</strong> <span style="color:var(--text-dim)">clear chat history</span></div>
        <div><strong>/copy</strong> <span style="color:var(--text-dim)">copy last response</span></div>
        <div><strong>/help</strong> <span style="color:var(--text-dim)">show this message</span></div>
      `;
      messages.appendChild(help);
      scrollToBottom();
      return true;
    }

    default: {
      const err = document.createElement('div');
      err.className = 'msg msg-error';
      err.textContent = `unknown command: ${text} (try /help)`;
      messages.appendChild(err);
      scrollToBottom();
      return true;
    }
  }
}

// ---- Message rendering ----

function appendUser(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `<span class="prompt-char">&gt; </span><span class="prompt-text">${escapeHtml(text)}</span>`;
  messages.appendChild(div);
  scrollToBottom();
}

function appendAssistantStreaming(text) {
  // Clean leading newlines for fresh stream
  let cleaned = text;
  if (!currentAssistantText) {
    cleaned = cleaned.replace(/^\n+/, '');
  }
  currentAssistantText += cleaned;

  if (!cleaned) return;

  if (!currentStreamingEl) {
    currentStreamingEl = document.createElement('div');
    currentStreamingEl.className = 'msg msg-assistant';
    messages.appendChild(currentStreamingEl);
  }

  // Render incrementally
  const rendered = renderMarkdown(cleaned);
  currentStreamingEl.appendChild(rendered);
  scrollToBottom();
}

function appendError(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  div.textContent = text;
  messages.appendChild(div);
  scrollToBottom();
}

function appendToolUse(toolName, summary) {
  endStreaming();
  const div = document.createElement('div');
  div.className = 'msg msg-tool-use';
  div.innerHTML = `<span class="tool-name">${escapeHtml(toolName)} </span>${escapeHtml(summary)}`;
  messages.appendChild(div);
  scrollToBottom();
}

function appendToolResult(summary, isError) {
  const div = document.createElement('div');
  div.className = `msg msg-tool-result ${isError ? 'error' : 'success'}`;
  const prefix = isError ? 'FAIL ' : 'DONE ';
  div.innerHTML = `<span class="result-prefix">${prefix}</span><span class="result-text">${escapeHtml(summary)}</span>`;
  messages.appendChild(div);
  scrollToBottom();
}

function endStreaming() {
  if (isStreaming) {
    isStreaming = false;
    if (currentAssistantText) {
      lastAssistantText = currentAssistantText;
    }
    currentAssistantText = '';
    currentStreamingEl = null;
  }
}

// ---- History replay ----

function replayHistory(msgs) {
  messages.innerHTML = '';
  for (const msg of msgs) {
    switch (msg.role) {
      case 'user':
        appendUser(msg.text);
        break;
      case 'assistant': {
        const div = document.createElement('div');
        div.className = 'msg msg-assistant';
        div.appendChild(renderMarkdown(msg.text));
        messages.appendChild(div);
        lastAssistantText = msg.text;
        break;
      }
      case 'error':
        appendError(msg.text);
        break;
      case 'toolUse': {
        const div = document.createElement('div');
        div.className = 'msg msg-tool-use';
        div.innerHTML = `<span class="tool-name">${escapeHtml(msg.text.split(':')[0])} </span>${escapeHtml(msg.text.slice(msg.text.indexOf(':') + 2))}`;
        messages.appendChild(div);
        break;
      }
      case 'toolResult': {
        const isErr = msg.text.startsWith('ERROR:');
        const div = document.createElement('div');
        div.className = `msg msg-tool-result ${isErr ? 'error' : 'success'}`;
        const prefix = isErr ? 'FAIL ' : 'DONE ';
        div.innerHTML = `<span class="result-prefix">${prefix}</span><span class="result-text">${escapeHtml(msg.text)}</span>`;
        messages.appendChild(div);
        break;
      }
    }
  }
  scrollToBottom();
}

// ---- IPC Listeners ----

window.lilAgents.onStreamText((text) => {
  appendAssistantStreaming(text);
});

window.lilAgents.onTurnComplete(() => {
  endStreaming();
});

window.lilAgents.onError((msg) => {
  appendError(msg);
});

window.lilAgents.onToolUse((data) => {
  appendToolUse(data.toolName, data.summary);
});

window.lilAgents.onToolResult((data) => {
  appendToolResult(data.summary, data.isError);
});

window.lilAgents.onReplayHistory((msgs) => {
  replayHistory(msgs);
});

window.lilAgents.onCopied((text) => {
  if (text) {
    window.lilAgents.copyToClipboard(text);
    const div = document.createElement('div');
    div.className = 'msg msg-system';
    div.textContent = '  \u2713 copied to clipboard';
    messages.appendChild(div);
  } else {
    const div = document.createElement('div');
    div.className = 'msg msg-system';
    div.textContent = '  nothing to copy yet';
    messages.appendChild(div);
  }
  scrollToBottom();
});

// Copy button
copyBtn.addEventListener('click', () => {
  window.lilAgents.requestCopyLast();
});

// ---- Theme switching ----

window.lilAgents.onThemeUpdate((data) => {
  const theme = data.theme;
  const root = document.documentElement;

  root.style.setProperty('--popover-bg', theme.popoverBg);
  root.style.setProperty('--popover-border', theme.popoverBorder);
  root.style.setProperty('--popover-border-width', theme.popoverBorderWidth);
  root.style.setProperty('--popover-radius', theme.popoverRadius);
  root.style.setProperty('--title-bar-bg', theme.titleBarBg);
  root.style.setProperty('--title-text', theme.titleText);
  root.style.setProperty('--title-font-weight', theme.titleFontWeight);
  root.style.setProperty('--title-font-family', theme.titleFontFamily);
  root.style.setProperty('--separator', theme.separator);
  root.style.setProperty('--font-family', theme.fontFamily);
  root.style.setProperty('--font-size', theme.fontSize);
  root.style.setProperty('--font-bold-weight', theme.fontBoldWeight);
  root.style.setProperty('--text-primary', theme.textPrimary);
  root.style.setProperty('--text-dim', theme.textDim);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--error', theme.error);
  root.style.setProperty('--success', theme.success);
  root.style.setProperty('--input-bg', theme.inputBg);
  root.style.setProperty('--input-radius', theme.inputRadius);

  // Update title text
  if (data.title) {
    document.getElementById('titleText').textContent = data.title;
  }
});

// ---- Utilities ----

function scrollToBottom() {
  terminal.scrollTop = terminal.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}
