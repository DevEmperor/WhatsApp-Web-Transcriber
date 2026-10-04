# Changelog

## 1.8 (2026-10-04)

* **New:** "✨ Summary" button for voice messages longer than about 30 seconds (Groq `openai/gpt-oss-120b`).
* **New:** Transcripts and summaries are cached locally (up to 500 messages) and survive reloads. "Close" only hides them, "Transcribe" shows them again without a second API call.
* **New:** "🩺 Copy Diagnostics" menu command that copies a sanitized report of the page structure for bug reports.
* **New:** "🗑️ Clear Transcript Cache" menu command.
* **Improved:** Works in every WhatsApp Web UI language: voice messages are found by their progress slider instead of the English label.
* **Improved:** The audio is loaded through WhatsApp Web's own media download instead of the context menu, also when Tampermonkey runs the script in Firefox's sandbox. No menu flicker, and the sender never sees the message as played. The context menu remains as a fallback and now also recognizes the download entry by its icon.
* **Improved:** Readable message when Groq's rate limit is hit, including how long to wait.
* **Improved:** A warning in the browser console when a voice message is found but the button cannot be attached.

## 1.7 (2026-10-04)

* **Fixed:** Layout for the current WhatsApp Web DOM. The timestamp no longer slides under the buttons, and the empty gap above them is gone.
* **Improved:** Text box and buttons share the same width and inset, long transcripts no longer stretch the bubble.
* **Improved:** Colors follow the bubble background, so the light theme works too.
* **Improved:** Transcripts survive WhatsApp re-rendering rows while scrolling.
* **Improved:** Errors are always shown in the text box, a 401 hints at the API key.
* **Fixed:** Only a "Download" entry that appears after opening the menu is clicked, never one already on the page.

## 1.6 (2026-06-08)

* **Fixed:** Emojis in the transcript are no longer rendered italic.
* **Improved:** More robust detection of sent vs. received messages.

## 1.5 (2026-06-08)

* **Fixed:** Updated DOM selectors after a WhatsApp Web update.
* **Improved:** Support for the German WhatsApp UI ("Herunterladen").

## 1.4 (2026-04-23)

* First public release: one-click transcription with Groq Whisper, copy button, API key and language settings in the Tampermonkey menu, automatic updates.
