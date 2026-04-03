/**
 * Simple Markdown renderer for chat messages
 * Ported from TerminalView.swift renderMarkdown/renderInlineMarkdown
 */

function renderMarkdown(text) {
  const lines = text.split('\n');
  const container = document.createDocumentFragment();
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        const pre = document.createElement('pre');
        pre.className = 'md-code-block';
        pre.textContent = codeLines.join('\n');
        container.appendChild(pre);
        inCodeBlock = false;
        codeLines = [];
      } else {
        // Start code block
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      const h = document.createElement('div');
      h.className = 'md-h3';
      h.textContent = line.slice(4);
      container.appendChild(h);
    } else if (line.startsWith('## ')) {
      const h = document.createElement('div');
      h.className = 'md-h2';
      h.textContent = line.slice(3);
      container.appendChild(h);
    } else if (line.startsWith('# ')) {
      const h = document.createElement('div');
      h.className = 'md-h1';
      h.textContent = line.slice(2);
      container.appendChild(h);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      // List item
      const li = document.createElement('div');
      li.className = 'md-list-item';
      li.appendChild(renderInlineMarkdown(line.slice(2)));
      container.appendChild(li);
    } else if (line.trim() === '') {
      // Empty line -> small spacing
      const br = document.createElement('div');
      br.style.height = '4px';
      container.appendChild(br);
    } else {
      // Regular text with inline formatting
      const p = document.createElement('span');
      p.appendChild(renderInlineMarkdown(line));
      const br = document.createTextNode('\n');
      container.appendChild(p);
      container.appendChild(br);
    }
  }

  // Unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    const pre = document.createElement('pre');
    pre.className = 'md-code-block';
    pre.textContent = codeLines.join('\n');
    container.appendChild(pre);
  }

  return container;
}

function renderInlineMarkdown(text) {
  const fragment = document.createDocumentFragment();
  let i = 0;

  while (i < text.length) {
    // Inline code
    if (text[i] === '`') {
      const closeIdx = text.indexOf('`', i + 1);
      if (closeIdx !== -1) {
        const code = document.createElement('code');
        code.className = 'md-code';
        code.textContent = text.slice(i + 1, closeIdx);
        fragment.appendChild(code);
        i = closeIdx + 1;
        continue;
      }
    }

    // Bold **text**
    if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '*') {
      const closeIdx = text.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        const bold = document.createElement('strong');
        bold.className = 'md-bold';
        bold.textContent = text.slice(i + 2, closeIdx);
        fragment.appendChild(bold);
        i = closeIdx + 2;
        continue;
      }
    }

    // Link [text](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && closeBracket + 1 < text.length && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen);
          const a = document.createElement('a');
          a.className = 'md-link';
          a.textContent = linkText;
          a.href = url;
          a.target = '_blank';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            window.open(url, '_blank');
          });
          fragment.appendChild(a);
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Raw URL
    if (text[i] === 'h') {
      const remaining = text.slice(i);
      if (remaining.startsWith('https://') || remaining.startsWith('http://')) {
        let j = i;
        while (j < text.length && !'\t\n\r )>'.includes(text[j])) {
          j++;
        }
        const url = text.slice(i, j);
        const a = document.createElement('a');
        a.className = 'md-link';
        a.textContent = url;
        a.href = url;
        a.target = '_blank';
        fragment.appendChild(a);
        i = j;
        continue;
      }
    }

    // Regular character
    fragment.appendChild(document.createTextNode(text[i]));
    i++;
  }

  return fragment;
}

// Export for use in chat.js
window.renderMarkdown = renderMarkdown;
window.renderInlineMarkdown = renderInlineMarkdown;
