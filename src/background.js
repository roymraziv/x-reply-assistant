const FOLLOW_STATUS_CACHE_TTL_MS = 10 * 60 * 1000;
const FOLLOW_STATUS_MAX_REQUESTS_PER_MIN = 40;
const FOLLOW_STATUS_DEFAULT = 'unknown';
const FOLLOW_STATUS_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5mTwz8Xf6N6R4%3D' +
  '1Zv7ttfk8wT7xWw6f4v7M2N12x1W3xJ7f3M20k1R8x';

const followStatusCache = new Map();
const followStatusInflight = new Map();
const followStatusRequestTimes = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_REPLY') {
    handleGenerateReply(message.payload).then(sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === 'GET_FOLLOW_STATUS') {
    handleGetFollowStatus(message.payload).then(sendResponse);
    return true; // keep channel open for async response
  }
});

async function handleGenerateReply({ tweetText, masterPrompt, presetIntent, imageUrls = [], model = 'gpt-4.1-mini' }) {
  const { apiKey } = await chrome.storage.local.get('apiKey');

  if (!apiKey) {
    return { error: 'No API key set. Open extension popup and add your OpenAI API key.' };
  }

  try {
    // Build the user message content
    let userContent;

    if (imageUrls && imageUrls.length > 0) {
      // Vision API format: array of content objects
      userContent = [
        {
          type: 'text',
          text: `Tweet: "${tweetText}"\n\nIntent: ${presetIntent}\n\nGenerate ONLY the reply. No quotes. No explanation.`
        }
      ];

      // Add each image URL (limit to 4 images max to avoid token overload)
      imageUrls.slice(0, 4).forEach(url => {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: url,
            detail: 'low' // Use 'low' detail to save tokens
          }
        });
      });
    } else {
      // Text-only format
      userContent = `Tweet: "${tweetText}"\n\nIntent: ${presetIntent}\n\nGenerate ONLY the reply. No quotes. No explanation.`;
    }

    // Newer models (gpt-5, o-series) use max_completion_tokens and don't support custom temperature.
    // For reasoning models, max_completion_tokens covers hidden reasoning + visible output combined,
    // so we omit the limit entirely and let the API default — our prompt keeps visible output short.
    const isNewGen = model === 'gpt-5' || model.startsWith('o');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        ...(!isNewGen && { max_tokens: 100, temperature: 0.9 }),
        messages: [
          { role: 'system', content: masterPrompt },
          { role: 'user', content: userContent }
        ]
      })
    });

    const data = await response.json();

    console.log('[XRA] raw API response:', JSON.stringify(data, null, 2));

    if (data.error) return { error: data.error.message };

    const message = data.choices?.[0]?.message;
    if (!message) return { error: 'No message in API response. Check the service worker console for details.' };

    // Newer models may return content as an array of content objects instead of a plain string
    let replyText;
    if (Array.isArray(message.content)) {
      replyText = message.content
        .filter(c => c.type === 'text' || c.type === 'output_text')
        .map(c => c.text)
        .join('');
    } else if (typeof message.content === 'string') {
      replyText = message.content;
    } else {
      return { error: 'Unexpected content format from API. Check the service worker console for details.' };
    }

    if (!replyText.trim()) {
      return { error: 'API returned empty content. This usually means the token limit was too low for reasoning models — try again.' };
    }

    return { reply: replyText.trim() };
  } catch (err) {
    // Graceful fallback: if image processing fails, log it but return error
    console.error('AI generation error:', err);
    return { error: err.message };
  }
}

async function handleGetFollowStatus(payload = {}) {
  const userKey = (payload.userKey || '').toLowerCase().trim();
  const screenName = (payload.screenName || '').replace(/^@/, '').trim();
  const csrfToken = payload.csrfToken || '';

  if (!userKey || !screenName) {
    return { status: FOLLOW_STATUS_DEFAULT, source: 'invalid_payload' };
  }

  const cached = getCachedFollowStatus(userKey);
  if (cached) {
    return { status: cached, source: 'cache' };
  }

  if (followStatusInflight.has(userKey)) {
    return followStatusInflight.get(userKey);
  }

  const work = resolveFollowStatusHybrid({ userKey, screenName, csrfToken })
    .finally(() => followStatusInflight.delete(userKey));
  followStatusInflight.set(userKey, work);
  return work;
}

async function resolveFollowStatusHybrid({ userKey, screenName, csrfToken }) {
  if (!consumeFollowStatusBudget()) {
    return { status: FOLLOW_STATUS_DEFAULT, source: 'rate_limit_guard' };
  }

  const apiStatus = await withRetry(
    () => fetchStatusFromInternalGraphql(screenName, csrfToken),
    2
  );
  const normalizedApiStatus = normalizeFollowStatus(apiStatus);
  if (normalizedApiStatus !== FOLLOW_STATUS_DEFAULT) {
    setCachedFollowStatus(userKey, normalizedApiStatus);
    return { status: normalizedApiStatus, source: 'internal_graphql' };
  }

  const profileStatus = await withRetry(
    () => fetchStatusFromProfileHtml(screenName),
    1
  );
  const normalizedProfileStatus = normalizeFollowStatus(profileStatus);
  if (normalizedProfileStatus !== FOLLOW_STATUS_DEFAULT) {
    setCachedFollowStatus(userKey, normalizedProfileStatus);
    return { status: normalizedProfileStatus, source: 'profile_html' };
  }

  return { status: FOLLOW_STATUS_DEFAULT, source: 'unresolved' };
}

function getCachedFollowStatus(userKey) {
  const cached = followStatusCache.get(userKey);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > FOLLOW_STATUS_CACHE_TTL_MS) {
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

function consumeFollowStatusBudget() {
  const now = Date.now();
  while (followStatusRequestTimes.length > 0 && now - followStatusRequestTimes[0] > 60_000) {
    followStatusRequestTimes.shift();
  }

  if (followStatusRequestTimes.length >= FOLLOW_STATUS_MAX_REQUESTS_PER_MIN) {
    return false;
  }

  followStatusRequestTimes.push(now);
  return true;
}

async function withRetry(fn, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const backoff = 300 + (attempt * 300) + Math.floor(Math.random() * 250);
      await delay(backoff);
    }
  }

  console.warn('[XRA] follow status resolver failed:', lastError?.message || lastError);
  return FOLLOW_STATUS_DEFAULT;
}

async function fetchStatusFromInternalGraphql(screenName, csrfToken) {
  const endpoints = [
    { queryId: 'G3KGOASz96M-Qu0nwmGXNg', operation: 'UserByScreenName' },
    { queryId: 'sLVLhk0bGj3MVFEKTdax1w', operation: 'UserByScreenName' }
  ];
  const features = {
    hidden_profile_subscriptions_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };

  for (const endpoint of endpoints) {
    const variables = {
      screen_name: screenName,
      withSafetyModeUserFields: true
    };
    const url =
      `https://x.com/i/api/graphql/${endpoint.queryId}/${endpoint.operation}` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(features))}`;

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: '*/*',
        authorization: FOLLOW_STATUS_BEARER,
        'x-csrf-token': csrfToken,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session'
      }
    });

    if (response.status === 429) {
      throw new Error('x_rate_limited');
    }

    if (!response.ok) {
      continue;
    }

    const data = await response.json();
    const relationship = extractRelationshipFromObject(data);
    const status = mapRelationshipToStatus(relationship);
    if (status !== FOLLOW_STATUS_DEFAULT) {
      return status;
    }
  }

  return FOLLOW_STATUS_DEFAULT;
}

async function fetchStatusFromProfileHtml(screenName) {
  const response = await fetch(`https://x.com/${encodeURIComponent(screenName)}`, {
    method: 'GET',
    credentials: 'include',
    headers: {
      accept: 'text/html,application/xhtml+xml'
    }
  });

  if (!response.ok) {
    return FOLLOW_STATUS_DEFAULT;
  }

  const html = await response.text();
  const lower = html.toLowerCase();
  const followsYou = lower.includes('"follows_you":true') || lower.includes('follows you');
  const following = lower.includes('"following":true');
  return mapRelationshipToStatus({ followsYou, following });
}

function extractRelationshipFromObject(root) {
  let followsYou = null;
  let following = null;

  walkObject(root, (node) => {
    if (!node || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'followed_by')) {
      followsYou = node.followed_by === true;
    }
    if (Object.prototype.hasOwnProperty.call(node, 'following')) {
      following = node.following === true;
    }
    if (Object.prototype.hasOwnProperty.call(node, 'follows_you')) {
      followsYou = node.follows_you === true;
    }
  });

  return { followsYou, following };
}

function walkObject(value, visitor) {
  if (!value || typeof value !== 'object') return;
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walkObject(item, visitor));
    return;
  }
  Object.values(value).forEach((child) => walkObject(child, visitor));
}

function mapRelationshipToStatus(relationship = {}) {
  const followsYou = relationship.followsYou;
  const following = relationship.following;

  if (followsYou === true && following === true) return 'mutual';
  if (followsYou === true && (following === false || following === null)) return 'followsYou';
  if (followsYou === false && following === true) return 'followingOnly';
  if (followsYou === false && following === false) return 'none';
  return FOLLOW_STATUS_DEFAULT;
}

function normalizeFollowStatus(status) {
  return ['followsYou', 'mutual', 'followingOnly', 'none'].includes(status)
    ? status
    : FOLLOW_STATUS_DEFAULT;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
