chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_REPLY') {
    handleGenerateReply(message.payload).then(sendResponse);
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
