const REPLY_BTN_SELECTOR = '[data-testid="reply"]';
const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const REPLY_BOX_SELECTOR = '[data-testid="tweetTextarea_0"]';

// Debounce helper for performance
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

// Debounced inject function - fires max once per 200ms
const debouncedInject = debounce(injectButtons, 200);

const observer = new MutationObserver(() => debouncedInject());
observer.observe(document.body, { childList: true, subtree: true });

// Initial injection
injectButtons();

function injectButtons() {
  document.querySelectorAll(REPLY_BTN_SELECTOR).forEach(replyBtn => {
    if (replyBtn.dataset.aiInjected) return;
    replyBtn.dataset.aiInjected = 'true';

    const aiBtn = createAIButton(replyBtn);
    replyBtn.parentNode.insertBefore(aiBtn, replyBtn.nextSibling);
  });
}

function createAIButton(replyBtn) {
  const btn = document.createElement('button');
  btn.innerText = '⚡';
  btn.title = 'Generate AI Reply';
  btn.style.cssText = `
    margin-left: 8px;
    background: none;
    border: 1px solid #1d9bf0;
    border-radius: 9999px;
    color: #1d9bf0;
    cursor: pointer;
    padding: 4px 10px;
    font-size: 14px;
    font-weight: bold;
    transition: background 0.2s;
  `;

  btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(29,155,240,0.1)');
  btn.addEventListener('mouseleave', () => btn.style.background = 'none');
  btn.addEventListener('click', () => handleClick(btn, replyBtn));

  return btn;
}

async function handleClick(aiBtn, replyBtn) {
  aiBtn.innerText = '...';
  aiBtn.disabled = true;

  const tweetText = extractTweetText(replyBtn);

  if (!tweetText) {
    aiBtn.innerText = '⚡';
    aiBtn.disabled = false;
    alert('Could not extract tweet text. Try clicking reply first to open the reply box.');
    return;
  }

  const storage = await chrome.storage.local.get(['masterPrompt', 'presets', 'activePresetId']);
  const { masterPrompt, presets, activePresetId } = storage;
  const preset = (presets || []).find(p => p.id === activePresetId);

  if (!preset) {
    aiBtn.innerText = '⚡';
    aiBtn.disabled = false;
    alert('No active preset selected. Open the extension popup and select a preset.');
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'GENERATE_REPLY',
    payload: {
      tweetText,
      masterPrompt: masterPrompt || '',
      presetIntent: preset.intent
    }
  });

  aiBtn.innerText = '⚡';
  aiBtn.disabled = false;

  if (response.error) {
    alert(`AI Error: ${response.error}`);
    return;
  }

  // Click native reply button to open the reply box if not open
  replyBtn.click();

  // Wait for reply box to appear then fill
  waitForElement(REPLY_BOX_SELECTOR, (box) => {
    fillReplyBox(box, response.reply);
    // FR-04: Inject regenerate button after filling
    injectRegenerateButton(box, tweetText, masterPrompt, preset);
  });
}

function extractTweetText(replyBtn) {
  // Walk up to find the tweet article, then pull text
  let el = replyBtn;
  for (let i = 0; i < 15; i++) {
    el = el.parentElement;
    if (!el) break;
    const textEl = el.querySelector(TWEET_TEXT_SELECTOR);
    if (textEl) return textEl.innerText.trim();
  }
  return null;
}

function fillReplyBox(box, text) {
  // X uses Draft.js - we need to work with its internal state
  box.focus();

  // Method 1: Try selecting all and using execCommand (most compatible)
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(box);
  selection.removeAllRanges();
  selection.addRange(range);

  // Use execCommand which Draft.js should handle
  const success = document.execCommand('insertText', false, text);

  // Method 2: Fallback if execCommand fails or Draft.js doesn't respond
  if (!success) {
    box.textContent = text;

    // Trigger multiple events that Draft.js might listen to
    ['input', 'change', 'textInput'].forEach(eventType => {
      const event = new Event(eventType, { bubbles: true });
      box.dispatchEvent(event);
    });
  }

  // Method 3: Nuclear option - dispatch composition events (what IME uses)
  const compositionStart = new CompositionEvent('compositionstart', { bubbles: true });
  const compositionEnd = new CompositionEvent('compositionend', { bubbles: true, data: text });
  box.dispatchEvent(compositionStart);
  box.dispatchEvent(compositionEnd);

  // Final check and force update if needed
  setTimeout(() => {
    if (box.textContent !== text) {
      box.textContent = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, 100);
}

function waitForElement(selector, callback, timeout = 3000) {
  const start = Date.now();
  const interval = setInterval(() => {
    const el = document.querySelector(selector);
    if (el) {
      clearInterval(interval);
      callback(el);
    } else if (Date.now() - start > timeout) {
      clearInterval(interval);
    }
  }, 100);
}

// FR-04: Regenerate button implementation
function injectRegenerateButton(replyBox, tweetText, masterPrompt, preset) {
  // Remove any existing regenerate button first
  const existingBtn = document.getElementById('ai-regenerate-btn');
  if (existingBtn) existingBtn.remove();

  const regenerateBtn = document.createElement('button');
  regenerateBtn.id = 'ai-regenerate-btn';
  regenerateBtn.innerText = '🔄 Regenerate';
  regenerateBtn.title = 'Generate a new AI reply';
  regenerateBtn.style.cssText = `
    margin-top: 8px;
    background: #1d9bf0;
    border: none;
    border-radius: 9999px;
    color: white;
    cursor: pointer;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 600;
    transition: background 0.2s;
  `;

  regenerateBtn.addEventListener('mouseenter', () => regenerateBtn.style.background = '#1a8cd8');
  regenerateBtn.addEventListener('mouseleave', () => regenerateBtn.style.background = '#1d9bf0');

  regenerateBtn.addEventListener('click', async () => {
    regenerateBtn.innerText = '...';
    regenerateBtn.disabled = true;

    const response = await chrome.runtime.sendMessage({
      type: 'GENERATE_REPLY',
      payload: {
        tweetText,
        masterPrompt: masterPrompt || '',
        presetIntent: preset.intent
      }
    });

    regenerateBtn.innerText = '🔄 Regenerate';
    regenerateBtn.disabled = false;

    if (response.error) {
      alert(`AI Error: ${response.error}`);
      return;
    }

    fillReplyBox(replyBox, response.reply);
  });

  // Insert button after reply box
  replyBox.parentNode.insertBefore(regenerateBtn, replyBox.nextSibling);
}
