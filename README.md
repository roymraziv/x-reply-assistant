# X Reply Assistant

AI-powered reply co-pilot for X (Twitter). Click ⚡, get AI-generated replies based on your custom presets.

## Features

- One-click AI reply generation on any tweet (⚡ button next to reply)
- Optional **image-aware replies**: analyze up to 4 images in the tweet (uses vision API; more tokens, slower)
- Custom preset system for different reply intents
- Master prompt to control tone, style, and rules
- Regenerate button for alternative replies
- No backend required — runs entirely in the browser
- API key stored in browser storage only (never in source)

## Installation

### 1. Load Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this `/x-reply-assistant` folder
5. Extension will appear in your toolbar - pin it for easy access

### 2. Configure Extension

1. Click the extension icon to open the popup
2. **Add your OpenAI API key**
   - Get one at https://platform.openai.com/api-keys
   - Paste and click Save
3. **Write your Master Prompt** (optional but recommended)
   - Example: "You are a friendly tech professional. Keep replies under 280 characters. Be authentic and engaging."
4. **Settings**: Optionally enable **Analyze images in tweets** if you want replies to consider tweet media (uses more tokens).
5. **Create your first preset**
   - Label: "Follow Back Connect"
   - Intent: "Express genuine interest and invite them to connect, mention you'll follow back"
   - Click Save Preset
6. Your first preset will auto-activate

### 3. Use on X

1. Go to https://x.com
2. Scroll through your feed
3. Next to each tweet's reply button, you'll see a ⚡ button
4. Click ⚡ to generate and fill an AI reply
5. Review the reply - use the 🔄 Regenerate button if needed
6. Click Post when satisfied

## Creating More Presets

Add presets for different scenarios:

- **Engage Expert**: "Ask a thoughtful follow-up question about their expertise"
- **Supportive**: "Offer encouragement and share a personal experience"
- **Debate**: "Respectfully challenge with a counterpoint"
- **Networking**: "Compliment their work and suggest a collaboration"

Switch presets anytime from the popup - no reload needed.

## Technical Details

- **Platform**: Chrome Extension (Manifest V3)
- **AI Provider**: OpenAI GPT-4o-mini (text + optional vision for tweet images)
- **Storage**: chrome.storage.local (all data stays in browser)
- **No build step**: Pure vanilla JS, no bundler
- **Performance**: Debounced MutationObserver (200ms) for inject on scroll

## File Structure

```
x-reply-assistant/
  manifest.json          # Extension config (MV3)
  .gitignore
  README.md
  src/
    background.js        # OpenAI API calls (text + optional vision)
    content.js           # DOM injection, ⚡ button, regenerate
  src/popup/
    popup.html           # API key, master prompt, settings, presets
    popup.js             # Preset CRUD, active preset, analyzeImages
    popup.css            # Popup styling
  assets/
    icon16.png           # Toolbar / store icons (16, 48, 128)
    icon48.png
    icon128.png
```

## Swapping AI Providers

To use Claude instead of OpenAI:

1. Edit `src/background.js`
2. Change the API endpoint and model in the `fetch()` call
3. Update the request body format for Anthropic's API

## Privacy & Security

- Your API key is stored only in `chrome.storage.local` (browser-only)
- No data is sent to any server except OpenAI's API
- No tracking, no analytics, no external dependencies
- All code is visible and auditable

## Support

This is a personal-use extension. For issues or questions, refer to the source code in this repository.

## License

MIT
