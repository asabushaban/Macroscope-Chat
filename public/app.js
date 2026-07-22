'use strict';

const conversation = document.querySelector('#conversation');
const chatForm = document.querySelector('#chat-form');
const messageInput = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const cancelButton = document.querySelector('#cancel-button');
const requestStatus = document.querySelector('#request-status');
const settingsToggle = document.querySelector('#settings-toggle');
const settingsPanel = document.querySelector('#settings-panel');
const settingsForm = document.querySelector('#settings-form');
const webhookInput = document.querySelector('#webhook-url');
const tokenInput = document.querySelector('#api-token');
const clearSettingsButton = document.querySelector('#clear-settings');
const configuredIndicator = document.querySelector('#configured-indicator');
const headerStatus = document.querySelector('#header-status');
const settingsMessage = document.querySelector('#settings-message');
const inboundIndicator = document.querySelector('#inbound-indicator');
const inboundDetails = document.querySelector('#inbound-details');
const inboundUrl = document.querySelector('#inbound-url');
const inboundMessage = document.querySelector('#inbound-message');
const startInboundButton = document.querySelector('#start-inbound');
const stopInboundButton = document.querySelector('#stop-inbound');

let configured = false;
let activeController = null;
let loadingBubble = null;
let statusTimer = null;
let lastInboundMessageId = 0;

// Kept separate so prior conversation messages can be added later if desired.
function buildChatRequest(message) {
  return { message };
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The local server returned an unreadable response.');
  }
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function setConfigured(value) {
  configured = Boolean(value);
  configuredIndicator.textContent = configured ? 'Configured' : 'Not configured';
  configuredIndicator.classList.toggle('ready', configured);
  headerStatus.textContent = configured ? 'Ready' : 'Open Settings to connect';
}

async function refreshStatus() {
  try {
    const [status, inbound] = await Promise.all([api('/api/status'), api('/api/inbound/status')]);
    setConfigured(status.configured);
    setInboundState(inbound);
    if (!status.configured) openSettings();
  } catch {
    headerStatus.textContent = 'Local server unavailable';
  }
}

function setInboundState(state) {
  const ready = state.status === 'ready';
  const starting = state.status === 'starting';
  inboundIndicator.textContent = ready ? 'Ready' : starting ? 'Starting' : 'Stopped';
  inboundIndicator.classList.toggle('ready', ready);
  inboundDetails.hidden = !ready;
  inboundUrl.value = ready ? state.webhookUrl : '';
  startInboundButton.hidden = ready || starting;
  startInboundButton.disabled = starting;
  stopInboundButton.hidden = !ready && !starting;
}

function openSettings() {
  settingsPanel.hidden = false;
  settingsToggle.setAttribute('aria-expanded', 'true');
}

settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsToggle.setAttribute('aria-expanded', String(!settingsPanel.hidden));
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  settingsMessage.textContent = 'Saving…';
  try {
    const data = await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: webhookInput.value, apiToken: tokenInput.value }),
    });
    tokenInput.value = '';
    webhookInput.value = '';
    setConfigured(data.configured);
    settingsMessage.textContent = 'Credentials saved for this session.';
  } catch (error) {
    settingsMessage.textContent = error.message;
  }
});

clearSettingsButton.addEventListener('click', async () => {
  settingsMessage.textContent = 'Clearing…';
  try {
    const data = await api('/api/settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    webhookInput.value = '';
    tokenInput.value = '';
    setConfigured(data.configured);
    settingsMessage.textContent = 'Credentials cleared.';
  } catch (error) {
    settingsMessage.textContent = error.message;
  }
});

startInboundButton.addEventListener('click', async () => {
  inboundMessage.textContent = 'Starting Cloudflare Tunnel…';
  startInboundButton.disabled = true;
  try {
    const state = await api('/api/inbound/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    setInboundState(state);
    inboundMessage.textContent = 'External webhook is ready. Add the URL to your Macroscope Macro.';
  } catch (error) {
    inboundMessage.textContent = error.message;
    startInboundButton.disabled = false;
  }
});

stopInboundButton.addEventListener('click', async () => {
  inboundMessage.textContent = 'Stopping tunnel…';
  stopInboundButton.disabled = true;
  try {
    const state = await api('/api/inbound/tunnel', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    setInboundState(state);
    inboundMessage.textContent = 'External webhook stopped and its URL was revoked.';
  } catch (error) {
    inboundMessage.textContent = error.message;
  } finally {
    stopInboundButton.disabled = false;
  }
});

document.querySelectorAll('[data-copy-target]').forEach((button) => {
  button.addEventListener('click', async () => {
    const field = document.querySelector(`#${button.dataset.copyTarget}`);
    try {
      await navigator.clipboard.writeText(field.value);
      const previous = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = previous; }, 1200);
    } catch {
      inboundMessage.textContent = 'Could not copy automatically. Select and copy the value manually.';
    }
  });
});

async function pollInboundMessages() {
  try {
    const data = await api(`/api/inbound/messages?after=${lastInboundMessageId}`);
    setInboundState(data.tunnel);
    for (const message of data.messages) {
      lastInboundMessageId = Math.max(lastInboundMessageId, message.id);
      addSystemMessage('Received via external webhook');
      addMessage(message.response, 'assistant');
    }
  } catch {
    // A later poll will retry when the local server is available again.
  }
}

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeController) return;
  const message = messageInput.value.trim();
  if (!message) return;
  if (!configured) {
    addSystemMessage('Open Settings and add your Macroscope credentials first.');
    openSettings();
    return;
  }

  addMessage(message, 'user');
  messageInput.value = '';
  setRunning(true);
  loadingBubble = addLoadingBubble();
  activeController = new AbortController();
  startStatusMessages();

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildChatRequest(message)),
      signal: activeController.signal,
    });
    removeLoadingBubble();
    addMessage(data.response, 'assistant');
  } catch (error) {
    removeLoadingBubble();
    if (error.name === 'AbortError') {
      addSystemMessage('The request was canceled.');
    } else {
      addErrorMessage(error.message || 'The local connection was interrupted.');
      if (!messageInput.value) messageInput.value = message;
    }
  } finally {
    activeController = null;
    setRunning(false);
    stopStatusMessages();
    messageInput.focus();
  }
});

cancelButton.addEventListener('click', () => {
  if (activeController) activeController.abort();
});

function setRunning(running) {
  sendButton.disabled = running;
  messageInput.disabled = running;
  cancelButton.hidden = !running;
}

function startStatusMessages() {
  const messages = ['Sending request…', 'Macroscope is working…', 'Waiting for response…'];
  let index = 0;
  requestStatus.textContent = messages[index];
  statusTimer = setInterval(() => {
    index = Math.min(index + 1, messages.length - 1);
    requestStatus.textContent = messages[index];
  }, 1800);
}

function stopStatusMessages() {
  clearInterval(statusTimer);
  statusTimer = null;
  requestStatus.textContent = '';
}

function addMessage(text, role) {
  removeWelcome();
  const row = document.createElement('div');
  row.className = `message-row ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'assistant') renderSafeMarkdown(bubble, String(text ?? ''));
  else bubble.textContent = text;
  row.append(bubble);
  conversation.append(row);
  scrollToNewest();
  return row;
}

function addLoadingBubble() {
  removeWelcome();
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.setAttribute('aria-label', 'Macroscope is working');
  const bubble = document.createElement('div');
  bubble.className = 'bubble loading';
  for (let i = 0; i < 3; i += 1) bubble.append(document.createElement('span'));
  row.append(bubble);
  conversation.append(row);
  scrollToNewest();
  return row;
}

function removeLoadingBubble() {
  if (loadingBubble) loadingBubble.remove();
  loadingBubble = null;
}

function addSystemMessage(text) {
  removeWelcome();
  const element = document.createElement('p');
  element.className = 'system-message';
  element.textContent = text;
  conversation.append(element);
  scrollToNewest();
}

function addErrorMessage(text) {
  const row = addMessage(text, 'assistant');
  row.querySelector('.bubble').classList.add('error');
}

function removeWelcome() {
  const welcome = conversation.querySelector('.welcome');
  if (welcome) welcome.remove();
}

function scrollToNewest() {
  conversation.scrollTop = conversation.scrollHeight;
}

function renderSafeMarkdown(container, source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const fence = lines[index].match(/^\s*```([^`]*)$/);
    if (fence) {
      const language = fence[1].trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      appendCodeBlock(container, codeLines.join('\n'), language);
      continue;
    }
    const heading = lines[index].match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(element, heading[2]);
      container.append(element);
      index += 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])) {
      container.append(document.createElement('hr'));
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(lines[index])) {
      const quote = document.createElement('blockquote');
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      renderSafeMarkdown(quote, quoteLines.join('\n'));
      container.append(quote);
      continue;
    }
    if (/^\s*[-+*]\s+/.test(lines[index])) {
      const list = document.createElement('ul');
      while (index < lines.length && /^\s*[-+*]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        const itemText = lines[index].replace(/^\s*[-+*]\s+/, '');
        const task = itemText.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = task[1].toLowerCase() === 'x';
          checkbox.disabled = true;
          item.className = 'task-list-item';
          item.append(checkbox);
          appendInlineMarkdown(item, task[2]);
        } else {
          appendInlineMarkdown(item, itemText);
        }
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(lines[index])) {
      const list = document.createElement('ol');
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && lines[index] && !/^\s*```/.test(lines[index]) &&
      !/^\s*(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[index])) {
      paragraphLines.push(lines[index++]);
    }
    if (paragraphLines.length) {
      const paragraph = document.createElement('p');
      paragraphLines.forEach((line, lineIndex) => {
        if (lineIndex) paragraph.append(document.createElement('br'));
        appendInlineMarkdown(paragraph, line);
      });
      container.append(paragraph);
    } else {
      index += 1;
    }
  }
}

function appendInlineMarkdown(parent, text) {
  const tokenPattern = /(?<codeMark>`+)(?<codeText>[\s\S]*?)\k<codeMark>|!\[(?<imageAlt>[^\]]*)\]\((?<imageUrl>[^\s)]+)\)|\[(?<linkText>[^\]]+)\]\((?<linkUrl>[^\s)]+)(?:\s+["'](?<linkTitle>[^"']*)["'])?\)|(?<strongMark>\*\*|__)(?<strongText>.+?)\k<strongMark>|(?<strikeMark>~~)(?<strikeText>.+?)\k<strikeMark>|(?<!\w)(?<emMark>\*|_)(?!\s)(?<emText>.+?)(?<!\s)\k<emMark>(?!\w)/;
  const match = tokenPattern.exec(text);
  if (!match) {
    appendInlineImagesAndLinks(parent, text.replace(/\\([\\`*_[\]{}()#+.!>~-])/g, '$1'));
    return;
  }

  if (match.index) appendInlineMarkdown(parent, text.slice(0, match.index));
  const token = match.groups;
  if (token.codeMark) {
    const code = document.createElement('code');
    code.textContent = token.codeText;
    parent.append(code);
  } else if (token.imageUrl) {
    const src = safeMarkdownUrl(token.imageUrl, false);
    if (src) appendInlineImage(parent, src, token.imageAlt || 'Image');
    else parent.append(document.createTextNode(match[0]));
  } else if (token.linkUrl) {
    const href = safeMarkdownUrl(token.linkUrl, true);
    if (href) {
      if (isImageUrl(href)) {
        appendInlineImage(parent, href, token.linkText);
      } else {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        if (token.linkTitle) link.title = token.linkTitle;
        appendInlineMarkdown(link, token.linkText);
        parent.append(link);
      }
    } else {
      parent.append(document.createTextNode(match[0]));
    }
  } else {
    const element = document.createElement(token.strongMark ? 'strong' : token.strikeMark ? 'del' : 'em');
    appendInlineMarkdown(element, token.strongText || token.strikeText || token.emText);
    parent.append(element);
  }
  appendInlineMarkdown(parent, text.slice(match.index + match[0].length));
}

function safeMarkdownUrl(value, allowEmail = false) {
  try {
    const url = new URL(value, document.baseURI);
    const protocols = allowEmail ? ['http:', 'https:', 'mailto:'] : ['http:', 'https:'];
    if (!protocols.includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isImageUrl(url) {
  try {
    const pathname = new URL(url, document.baseURI).pathname.toLowerCase();
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(pathname);
  } catch {
    return false;
  }
}

function appendInlineImage(parent, src, alt) {
  const image = document.createElement('img');
  image.src = src;
  image.alt = alt;
  image.className = 'inline-image';
  image.loading = 'lazy';
  parent.append(image);
}

function appendInlineImagesAndLinks(parent, text) {
  // Pattern to match markdown images ![alt](url), markdown links [text](url), and plain URLs
  const combinedPattern = /!\[([^\]]*)\]\(([^\s<>[\]()]+(?:\([^\s<>[\]()]*\))?[^\s<>[\()]*)\)|\[([^\]]+)\]\(([^\s<>[\]()]+(?:\([^\s<>[\]()]*\))?[^\s<>[\()]*)\)|(https?:\/\/[^\s<>[\]()]+(?:\([^\s<>[\]()]*\))?[^\s<>[\()]*)/g;
  let lastIndex = 0;
  let match;

  while ((match = combinedPattern.exec(text)) !== null) {
    // Append text before the match
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    if (match[1] !== undefined || match[2] !== undefined) {
      // Markdown image: ![alt](url)
      const alt = match[1] || '';
      const url = match[2];
      const src = safeMarkdownUrl(url);
      if (src) {
        appendInlineImage(parent, src, alt);
      } else {
        // Unsafe URL scheme - render as plain text
        parent.append(document.createTextNode(match[0]));
      }
    } else if (match[3] !== undefined && match[4] !== undefined) {
      // Markdown link: [text](url)
      const linkText = match[3];
      const url = match[4];
      const href = safeMarkdownUrl(url, true);
      if (!href) {
        // Unsafe URL scheme - render as plain text
        parent.append(document.createTextNode(match[0]));
      } else if (isImageUrl(href)) {
        // If the link points to an image, render the image
        const img = document.createElement('img');
        img.src = href;
        img.alt = linkText;
        img.className = 'inline-image';
        img.loading = 'lazy';
        parent.append(img);
      } else {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = linkText;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      }
    } else if (match[5]) {
      // Plain URL - strip trailing sentence punctuation
      let url = match[5];
      let strippedCount = 0;
      const trailingPunctuation = /[.,;:!?)\]}"']+$/;
      const punctMatch = url.match(trailingPunctuation);
      if (punctMatch) {
        strippedCount = punctMatch[0].length;
        url = url.slice(0, -strippedCount);
      }
      if (isImageUrl(url)) {
        appendInlineImage(parent, url, 'Image');
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.textContent = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      }
      lastIndex = match.index + match[0].length - strippedCount;
      continue;
    }

    lastIndex = match.index + match[0].length;
  }

  // Append remaining text after the last match
  if (lastIndex < text.length) {
    parent.append(document.createTextNode(text.slice(lastIndex)));
  }
}

function appendCodeBlock(parent, codeText, language) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';
  const toolbar = document.createElement('div');
  toolbar.className = 'code-toolbar';
  const label = document.createElement('span');
  label.textContent = language || 'Code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    } catch {
      copy.textContent = 'Copy failed';
    }
  });
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = codeText;
  pre.append(code);
  toolbar.append(label, copy);
  wrapper.append(toolbar, pre);
  parent.append(wrapper);
}

refreshStatus();
pollInboundMessages();
+setTimeout(function poll() { pollInboundMessages().finally(() => setTimeout(poll, 2_000)); }, 2_000);
