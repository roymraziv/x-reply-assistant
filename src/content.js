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

  const storage = await chrome.storage.local.get(['masterPrompt', 'presets', 'activePresetId', 'analyzeImages']);
  const { masterPrompt, presets, activePresetId, analyzeImages } = storage;
  const preset = (presets || []).find(p => p.id === activePresetId);

  if (!preset) {
    aiBtn.innerText = '⚡';
    aiBtn.disabled = false;
    alert('No active preset selected. Open the extension popup and select a preset.');
    return;
  }

  // Extract images if the setting is enabled
  let imageUrls = [];
  if (analyzeImages) {
    imageUrls = extractTweetImages(replyBtn);
  }

  const response = await chrome.runtime.sendMessage({
    type: 'GENERATE_REPLY',
    payload: {
      tweetText,
      masterPrompt: masterPrompt || '',
      presetIntent: preset.intent,
      model: preset.model || 'gpt-4.1-mini',
      imageUrls
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
    injectRegenerateButton(box, tweetText, masterPrompt, preset, imageUrls);
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

function extractTweetImages(replyBtn) {
  // Walk up to find the tweet article, then extract all images
  let el = replyBtn;
  for (let i = 0; i < 15; i++) {
    el = el.parentElement;
    if (!el) break;

    // X uses multiple selectors for images
    const imageSelectors = [
      '[data-testid="tweetPhoto"] img',
      '[data-testid="card.layoutLarge.media"] img',
      '[data-testid="card.layoutSmall.media"] img',
      'img[alt*="Image"]',
      'article img'
    ];

    for (const selector of imageSelectors) {
      const images = el.querySelectorAll(selector);
      if (images.length > 0) {
        // Extract src URLs and filter out profile pictures and icons
        const imageUrls = Array.from(images)
          .map(img => img.src)
          .filter(src => {
            // Filter out small images (likely icons/avatars)
            // X tweet images are typically larger
            return src &&
                   !src.includes('profile_images') &&
                   !src.includes('emoji') &&
                   (src.includes('media') || src.includes('pbs.twimg.com'));
          });

        if (imageUrls.length > 0) {
          return imageUrls;
        }
      }
    }
  }
  return [];
}

function fillReplyBox(box, text) {
  // X uses Draft.js - the key is to let Draft.js process changes naturally
  box.focus();

  // Wait a tick for focus to settle
  setTimeout(() => {
    // Select all existing content in the box (if any)
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);

    // Use execCommand to insert text - Draft.js handles this properly
    // This works because Draft.js listens to the selection and mutation changes
    document.execCommand('insertText', false, text);
  }, 10);
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
function injectRegenerateButton(replyBox, tweetText, masterPrompt, preset, imageUrls = []) {
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
        presetIntent: preset.intent,
        model: preset.model || 'gpt-4.1-mini',
        imageUrls
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
