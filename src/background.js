chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_REPLY') {
    handleGenerateReply(message.payload).then(sendResponse);
    return true; // keep channel open for async response
  }
});

async function handleGenerateReply({ tweetText, masterPrompt, presetIntent }) {
  const { apiKey } = await chrome.storage.local.get('apiKey');

  if (!apiKey) {
    return { error: 'No API key set. Open extension popup and add your OpenAI API key.' };
  }

  try {
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
          { role: 'user', content: `Tweet: "${tweetText}"\n\nIntent: ${presetIntent}\n\nGenerate ONLY the reply. No quotes. No explanation.` }
        ]
      })
    });

    const data = await response.json();

    if (data.error) return { error: data.error.message };

    return { reply: data.choices[0].message.content.trim() };
  } catch (err) {
    return { error: err.message };
  }
}
