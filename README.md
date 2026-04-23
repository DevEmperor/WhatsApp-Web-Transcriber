# 💬 WhatsApp Web Voice Transcriber

![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)
![JavaScript](https://img.shields.io/badge/Code-JavaScript-yellow.svg)
![Tampermonkey](https://img.shields.io/badge/Extension-Tampermonkey-black.svg)

A lightweight, robust Tampermonkey Userscript that allows you to transcribe WhatsApp Web voice messages into text with a single click. Powered by the blazing-fast Groq API (Whisper-large-v3).

## 📸 Screenshots

![Screenshot 1: The Transcribe Button](link-zum-bild-1.png)
*The custom button integrates seamlessly into the WhatsApp Web UI.*

![Screenshot 2: The Result](link-zum-bild-2.png)
*Transcriptions appear directly below the voice message, complete with a convenient copy button.*

## ✨ Features

* **One-Click Transcription:** No need to download files manually or use external bots.
* **Blazing Fast:** Uses Groq's API for near-instant text generation.
* **Seamless UI:** The transcription and buttons are injected directly into the chat bubble, respecting WhatsApp's native design (including dark mode).
* **Copy to Clipboard:** Instantly copy the transcribed text.
* **Auto-Language Detection:** Automatically detects the spoken language, or lets you manually enforce a specific language code via the Tampermonkey menu.
* **Secure Key Management:** Your API key is stored locally in your browser, never shared.

## 🚀 Installation

1. Install a Userscript manager for your browser (e.g., [Tampermonkey](https://www.tampermonkey.net/)).
2. Click the link below to install the script:
   👉 **[Install WhatsApp Web Voice Transcriber](https://raw.githubusercontent.com/DevEmperor/WhatsApp-Web-Transcriber/main/WhatsApp-Web-Transcriber.user.js)**
3. Confirm the installation in the Tampermonkey tab that opens.

## 🔑 Getting your free API Key

This script uses the Groq API to transcribe the audio. You need a free API key to use it:

1. Go to the [Groq Console](https://console.groq.com/keys).
2. Create a free account or log in.
3. Generate a new API Key (it starts with `gsk_...`).
4. The first time you click "Transcribe" in WhatsApp Web, the script will ask for this key. Paste it there, and it will be saved locally.

*(You can always change your key or language settings later by clicking the Tampermonkey extension icon and selecting the script's menu commands).*

## 🛠️ Usage

1. Open [WhatsApp Web](https://web.whatsapp.com/).
2. Open any chat containing a voice message.
3. You will see a new **"📄 Transcribe"** button attached to every voice message bubble.
4. Click it and wait a few seconds. The text will appear right below the audio!

## 📜 License

This project is licensed under the **GPL-3.0 License** - see the [license file](https://raw.githubusercontent.com/DevEmperor/WhatsApp-Web-Transcriber/master/LICENSE) file for details.
