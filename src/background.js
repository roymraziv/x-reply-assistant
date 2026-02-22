chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_REPLY') {
    handleGenerateReply(message.payload).then(sendResponse);
    return true; // keep channel open for async response
  }
});

async function handleGenerateReply({ tweetText, masterPrompt, presetIntent, imageUrls = [] }) {
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

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        temperature: 0.9,
        messages: [
          { role: 'system', content: masterPrompt },
          { role: 'user', content: userContent }
        ]
      })
    });

    const data = await response.json();

    if (data.error) return { error: data.error.message };

    return { reply: data.choices[0].message.content.trim() };
  } catch (err) {
    // Graceful fallback: if image processing fails, log it but return error
    console.error('AI generation error:', err);
    return { error: err.message };
  }
}
