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
  const tokenPattern = /(`+)([\s\S]*?)\1|\[([^\]]+)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)|(\*\*|__)(.+?)\6|(~~)(.+?)\8|(?<!\w)(\*|_)(?!\s)(.+?)(?<!\s)\10(?!\w)/;
  const match = tokenPattern.exec(text);
  if (!match) {
    parent.append(document.createTextNode(text.replace(/\\([\\`*_[\]{}()#+.!>~-])/g, '$1')));
    return;
  }

  if (match.index) appendInlineMarkdown(parent, text.slice(0, match.index));
  if (match[1]) {
    const code = document.createElement('code');
    code.textContent = match[2];
    parent.append(code);
  } else if (match[3]) {
    const href = safeMarkdownUrl(match[4]);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (match[5]) link.title = match[5];
      appendInlineMarkdown(link, match[3]);
      parent.append(link);
    } else {
      parent.append(document.createTextNode(match[0]));
    }
  } else {
    const element = document.createElement(match[6] ? 'strong' : match[8] ? 'del' : 'em');
    appendInlineMarkdown(element, match[7] || match[9] || match[11]);
    parent.append(element);
  }
  appendInlineMarkdown(parent, text.slice(match.index + match[0].length));
}

function safeMarkdownUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
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
