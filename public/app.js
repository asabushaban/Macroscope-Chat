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

let configured = false;
let activeController = null;
let loadingBubble = null;
let statusTimer = null;

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
    const data = await api('/api/status');
    setConfigured(data.configured);
    if (!data.configured) openSettings();
  } catch {
    headerStatus.textContent = 'Local server unavailable';
  }
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
    if (lines[index].startsWith('```')) {
      const language = lines[index].slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      appendCodeBlock(container, codeLines.join('\n'), language);
      continue;
    }
    if (/^\s*[-*]\s+/.test(lines[index])) {
      const list = document.createElement('ul');
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        appendInlineCode(item, lines[index].replace(/^\s*[-*]\s+/, ''));
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
        appendInlineCode(item, lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && lines[index] && !lines[index].startsWith('```') &&
      !/^\s*[-*]\s+/.test(lines[index]) && !/^\s*\d+[.)]\s+/.test(lines[index])) {
      paragraphLines.push(lines[index++]);
    }
    if (paragraphLines.length) {
      const paragraph = document.createElement('p');
      paragraphLines.forEach((line, lineIndex) => {
        if (lineIndex) paragraph.append(document.createElement('br'));
        appendInlineCode(paragraph, line);
      });
      container.append(paragraph);
    } else {
      index += 1;
    }
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

function isSafeUrl(url) {
  try {
    const parsed = new URL(url, document.baseURI);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function appendInlineCode(parent, text) {
  // Process inline code first by splitting on backticks
  const codeParts = text.split('`');
  codeParts.forEach((part, index) => {
    if (index % 2 === 1) {
      // Inside backticks - render as code
      const code = document.createElement('code');
      code.textContent = part;
      parent.append(code);
    } else {
      // Outside backticks - process for images and links
      appendInlineImagesAndLinks(parent, part);
    }
  });
}

function appendInlineImagesAndLinks(parent, text) {
  // Pattern to match markdown images ![alt](url), markdown links [text](url), and plain URLs
  const combinedPattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>[\]()]+(?:\([^\s<>[\]()]*\))?[^\s<>[\]()]*)/g;
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
      if (isSafeUrl(url)) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = alt;
        img.className = 'inline-image';
        img.loading = 'lazy';
        parent.append(img);
      } else {
        // Unsafe URL scheme - render as plain text
        parent.append(document.createTextNode(match[0]));
      }
    } else if (match[3] !== undefined && match[4] !== undefined) {
      // Markdown link: [text](url)
      const linkText = match[3];
      const url = match[4];
      if (!isSafeUrl(url)) {
        // Unsafe URL scheme - render as plain text
        parent.append(document.createTextNode(match[0]));
      } else if (isImageUrl(url)) {
        // If the link points to an image, render the image
        const img = document.createElement('img');
        img.src = url;
        img.alt = linkText;
        img.className = 'inline-image';
        img.loading = 'lazy';
        parent.append(img);
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.textContent = linkText;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      }
    } else if (match[5]) {
      // Plain URL
      const url = match[5];
      if (isImageUrl(url)) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Image';
        img.className = 'inline-image';
        img.loading = 'lazy';
        parent.append(img);
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.textContent = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      }
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
