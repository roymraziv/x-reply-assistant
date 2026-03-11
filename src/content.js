const REPLY_BTN_SELECTOR = '[data-testid="reply"]';
const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const REPLY_BOX_SELECTOR = '[data-testid="tweetTextarea_0"]';
const TWEET_ARTICLE_SELECTOR = 'article';
const STATUS_LINK_SELECTOR = 'a[href*="/status/"]';
const XRA_BADGE_SELECTOR = '.xra-follow-status';
const FOLLOW_STATUS_TTL_MS = 10 * 60 * 1000;

const followStatusCache = new Map();
const inflightFollowStatus = new Set();
const seenUserKeys = new Set();
const followStatusAttemptTimes = new Map();
const userBadgeRegistry = new Map();
const lazyStatusObserver = new IntersectionObserver(onStatusBadgeIntersect, {
  root: null,
  threshold: 0.2
});
const FOLLOW_STATUS_RETRY_COOLDOWN_MS = 2 * 60 * 1000;

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

  injectFollowerStatusBadges();
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

function injectFollowerStatusBadges() {
  document.querySelectorAll(TWEET_ARTICLE_SELECTOR).forEach((article) => {
    const author = extractAuthorIdentity(article);
    if (!author) return;

    const badge = ensureFollowStatusBadge(article, author.userKey);
    registerBadge(author.userKey, badge);

    const domStatus = detectDomRelationshipStatus(article);
    if (domStatus !== 'unknown') {
      setCachedFollowStatus(author.userKey, domStatus);
      renderFollowStatusBadge(badge, domStatus, 'dom');
      return;
    }

    const cached = getCachedFollowStatus(author.userKey);
    if (cached) {
      renderFollowStatusBadge(badge, cached, 'cache');
      return;
    }

    if (!shouldAttemptFollowResolution(author.userKey)) {
      renderFollowStatusBadge(badge, 'unknown', 'cooldown');
      return;
    }

    renderFollowStatusBadge(badge, 'loading', 'pending');
    badge.dataset.xraPendingUserKey = author.userKey;
    badge.dataset.xraPendingScreenName = author.screenName;
    lazyStatusObserver.observe(badge);
  });
}

function extractAuthorIdentity(article) {
  const statusLinks = article.querySelectorAll(STATUS_LINK_SELECTOR);
  for (const link of statusLinks) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\//);
    if (!match) continue;

    const screenName = match[1];
    const userKey = screenName.toLowerCase();
    return { screenName, userKey };
  }
  return null;
}

function detectDomRelationshipStatus(article) {
  const articleText = (article.innerText || '').toLowerCase();
  const followsYou = articleText.includes('follows you');

  const followingButton = article.querySelector(
    '[data-testid$="-unfollow"], button[aria-label*="Following"], div[role="button"][aria-label*="Following"]'
  );
  const followButton = article.querySelector(
    '[data-testid$="-follow"], button[aria-label*="Follow"], div[role="button"][aria-label*="Follow"]'
  );

  let following;
  if (followingButton) {
    following = true;
  } else if (followButton) {
    following = false;
  } else {
    following = null;
  }

  if (followsYou && following === true) return 'mutual';
  if (followsYou && following === false) return 'followsYou';
  if (followsYou && following === null) return 'followsYou';
  if (!followsYou && following === true) return 'followingOnly';
  if (!followsYou && following === false) return 'none';
  return 'unknown';
}

function ensureFollowStatusBadge(article, userKey) {
  let badge = article.querySelector(`${XRA_BADGE_SELECTOR}[data-xra-user-key="${userKey}"]`);
  if (badge) return badge;

  badge = document.createElement('span');
  badge.className = 'xra-follow-status';
  badge.dataset.xraUserKey = userKey;
  badge.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'margin-left:6px',
    'padding:1px 6px',
    'border-radius:9999px',
    'font-size:11px',
    'font-weight:600',
    'line-height:16px',
    'vertical-align:middle',
    'white-space:nowrap'
  ].join(';');

  const anchorForPlacement = article.querySelector(`${STATUS_LINK_SELECTOR} time`)?.closest('a')
    || article.querySelector(STATUS_LINK_SELECTOR);
  if (anchorForPlacement?.parentNode) {
    anchorForPlacement.insertAdjacentElement('afterend', badge);
  } else {
    const fallbackTarget = article.querySelector('[data-testid="User-Name"]')
      || article.querySelector('header')
      || article.firstElementChild;
    fallbackTarget?.appendChild(badge);
  }

  return badge;
}

function renderFollowStatusBadge(badge, status, source) {
  const statusMap = {
    loading: { label: 'Checking...', bg: 'rgba(113,118,123,0.20)', color: '#8899a6' },
    followsYou: { label: 'Follows you', bg: 'rgba(0,186,124,0.20)', color: '#00ba7c' },
    mutual: { label: 'Mutual', bg: 'rgba(29,155,240,0.20)', color: '#1d9bf0' },
    followingOnly: { label: 'Following only', bg: 'rgba(255,212,0,0.20)', color: '#ffd400' },
    none: { label: 'Not following', bg: 'rgba(244,33,46,0.18)', color: '#f4212e' },
    unknown: { label: 'Unknown', bg: 'rgba(113,118,123,0.20)', color: '#71767b' }
  };

  const style = statusMap[status] || statusMap.unknown;
  badge.textContent = style.label;
  badge.style.background = style.bg;
  badge.style.color = style.color;
  badge.dataset.xraStatus = status;
  badge.dataset.xraSource = source;

  if (status === 'unknown') {
    badge.style.display = 'none';
  } else {
    badge.style.display = 'inline-flex';
  }
}

function registerBadge(userKey, badge) {
  const existing = userBadgeRegistry.get(userKey) || new Set();
  existing.add(badge);
  userBadgeRegistry.set(userKey, existing);
}

function getCachedFollowStatus(userKey) {
  const cached = followStatusCache.get(userKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > FOLLOW_STATUS_TTL_MS) {
    followStatusCache.delete(userKey);
    return null;
  }
  return cached.status;
}

function setCachedFollowStatus(userKey, status) {
  followStatusCache.set(userKey, {
    status,
    timestamp: Date.now()
  });
}

function onStatusBadgeIntersect(entries) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;

    const badge = entry.target;
    lazyStatusObserver.unobserve(badge);

    const userKey = badge.dataset.xraPendingUserKey;
    const screenName = badge.dataset.xraPendingScreenName;
    if (!userKey || !screenName) return;

    resolveFollowStatusFromBackground(userKey, screenName);
  });
}

async function resolveFollowStatusFromBackground(userKey, screenName) {
  if (inflightFollowStatus.has(userKey)) return;
  inflightFollowStatus.add(userKey);
  seenUserKeys.add(userKey);
  followStatusAttemptTimes.set(userKey, Date.now());

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_FOLLOW_STATUS',
      payload: {
        userKey,
        screenName,
        csrfToken: getCookieValue('ct0')
      }
    });

    const resolvedStatus = normalizeFollowStatus(response?.status);
    if (resolvedStatus !== 'unknown') {
      setCachedFollowStatus(userKey, resolvedStatus);
    }
    renderStatusForAllUserBadges(userKey, resolvedStatus, response?.source || 'network');
  } catch (error) {
    renderStatusForAllUserBadges(userKey, 'unknown', 'network_error');
  } finally {
    inflightFollowStatus.delete(userKey);
  }
}

function shouldAttemptFollowResolution(userKey) {
  if (!seenUserKeys.has(userKey)) return true;
  const lastAttempt = followStatusAttemptTimes.get(userKey);
  if (!lastAttempt) return true;
  return Date.now() - lastAttempt > FOLLOW_STATUS_RETRY_COOLDOWN_MS;
}

function renderStatusForAllUserBadges(userKey, status, source) {
  const badges = userBadgeRegistry.get(userKey);
  if (!badges) return;
  badges.forEach((badge) => {
    renderFollowStatusBadge(badge, status, source);
  });
}

function normalizeFollowStatus(status) {
  const normalized = ['followsYou', 'mutual', 'followingOnly', 'none', 'unknown'];
  return normalized.includes(status) ? status : 'unknown';
}

function getCookieValue(name) {
  const cookies = document.cookie ? document.cookie.split('; ') : [];
  for (const pair of cookies) {
    const [key, value] = pair.split('=');
    if (key === name) return decodeURIComponent(value || '');
  }
  return '';
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
