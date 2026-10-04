// ==UserScript==
// @name         WhatsApp Web Transcriber
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Transcribes WhatsApp voice messages with one click (Layout fix for the 2026 WhatsApp Web redesign)
// @author       DevEmperor
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.groq.com
// @updateURL    https://raw.githubusercontent.com/DevEmperor/WhatsApp-Web-Transcriber/main/WhatsApp-Web-Transcriber.user.js
// @downloadURL  https://raw.githubusercontent.com/DevEmperor/WhatsApp-Web-Transcriber/main/WhatsApp-Web-Transcriber.user.js
// ==/UserScript==

(function() {
    'use strict';

    // === SETTINGS MANAGEMENT ===
    const API_KEY_NAME = 'GROQ_API_KEY';
    const LANGUAGE_NAME = 'GROQ_LANGUAGE';

    let apiKey = GM_getValue(API_KEY_NAME, '');
    let targetLanguage = GM_getValue(LANGUAGE_NAME, ''); // Empty means auto-detect

    function checkAndGetApiKey() {
        if (!apiKey || apiKey.trim() === '') {
            apiKey = prompt("🤖 WhatsApp Voice Transcriber\n\nPlease enter your Groq API Key (gsk_...):\n(You can get one for free at console.groq.com/keys)");
            if (apiKey && apiKey.trim() !== '') {
                apiKey = apiKey.trim();
                GM_setValue(API_KEY_NAME, apiKey);
                alert("✅ API Key saved successfully!");
            }
        }
        return apiKey;
    }

    // Menu: Change API Key
    GM_registerMenuCommand("🔑 Change API Key", () => {
        const newKey = prompt("Enter new Groq API Key (leave blank to cancel):", apiKey);
        if (newKey && newKey.trim() !== '') {
            apiKey = newKey.trim();
            GM_setValue(API_KEY_NAME, apiKey);
            alert("✅ API Key updated successfully!");
        }
    });

    // Menu: Change Language
    GM_registerMenuCommand("🌐 Change Language (Auto/Manual)", () => {
        const promptText = "Enter a 2-letter language code (e.g., 'en' for English, 'de' for German, 'es' for Spanish).\n\nLeave the field completely blank to use Auto-Detect:";
        const newLang = prompt(promptText, targetLanguage);

        if (newLang !== null) {
            targetLanguage = newLang.trim().toLowerCase();
            GM_setValue(LANGUAGE_NAME, targetLanguage);
            if (targetLanguage === '') {
                alert("✅ Language set to Auto-Detect!");
            } else {
                alert(`✅ Language explicitly set to: '${targetLanguage}'`);
            }
        }
    });


    // --- 1. CSP BYPASS VIA UNSAFEWINDOW ---
    const originalClick = unsafeWindow.HTMLAnchorElement.prototype.click;
    function trappedClick() {
        if (unsafeWindow.__transcriberTrapArmed === true && this.download) {
            unsafeWindow.__transcriberTrapArmed = false;
            document.dispatchEvent(new CustomEvent('AudioCaught', { detail: this.href }));
            return;
        }
        return originalClick.apply(this, arguments);
    }
    // If Firefox runs the script in an Xray sandbox, the page may only call functions exported to it
    let clickHook = trappedClick;
    if (typeof exportFunction === 'function') {
        try { clickHook = exportFunction(trappedClick, unsafeWindow); } catch (err) { /* already in page context */ }
    }
    unsafeWindow.HTMLAnchorElement.prototype.click = clickHook;

    // --- 2. STYLES ---
    GM_addStyle(`
        .wa-tr-wrap {
            contain: inline-size; /* long transcripts must not stretch the bubble */
            margin: 2px 6px 0;
            padding: 8px 0 6px;
            border-top: 1px solid var(--wa-tr-line);
        }
        .wa-tr-dark {
            --wa-tr-line: rgba(255, 255, 255, 0.15);
            --wa-tr-box: rgba(0, 0, 0, 0.15);
            --wa-tr-fg: #e9edef;
            --wa-tr-soft: #404a4e;
            --wa-tr-hover: rgba(255, 255, 255, 0.06);
        }
        .wa-tr-light {
            --wa-tr-line: rgba(0, 0, 0, 0.1);
            --wa-tr-box: rgba(0, 0, 0, 0.05);
            --wa-tr-fg: #111b21;
            --wa-tr-soft: rgba(0, 0, 0, 0.08);
            --wa-tr-hover: rgba(0, 0, 0, 0.04);
        }
        .wa-tr-text {
            box-sizing: border-box;
            max-height: 350px;
            overflow-y: auto;
            margin: 0 0 8px;
            padding: 8px 12px;
            border-radius: 8px;
            background: var(--wa-tr-box);
            color: var(--wa-tr-fg);
            font-size: 14px;
            line-height: 1.4;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            user-select: text;
        }
        .wa-tr-icon { font-style: normal; margin-right: 4px; } /* Emojis must not be italic */
        .wa-tr-body { font-style: italic; }
        .wa-tr-buttons { display: flex; gap: 8px; }
        .wa-tr-btn {
            flex: 2;
            min-width: 0;
            margin: 0;
            padding: 8px 12px;
            border: none;
            border-radius: 8px;
            background: transparent;
            color: var(--wa-tr-fg);
            font-family: inherit;
            font-size: 13px;
            font-weight: bold;
            line-height: 1.2;
            text-align: center;
            cursor: pointer;
            transition: background-color 0.2s, filter 0.2s;
        }
        .wa-tr-btn[hidden] { display: none; }
        .wa-tr-btn[data-state="idle"]:hover { background: var(--wa-tr-hover); }
        .wa-tr-btn[data-state="menu"], .wa-tr-btn[data-state="download"], .wa-tr-btn[data-state="upload"] {
            background: #8696a0; color: white; cursor: progress;
        }
        .wa-tr-btn[data-state="close"], .wa-tr-btn[data-state="error"] { background: #d14553; color: white; }
        .wa-tr-copy { flex: 1; background: var(--wa-tr-soft); }
        .wa-tr-copy[data-copied] { background: #00a884; color: white; }
        .wa-tr-copy:hover, .wa-tr-btn[data-state="close"]:hover, .wa-tr-btn[data-state="error"]:hover { filter: brightness(1.12); }
    `);

    // --- 3. TAMPERMONKEY LOGIC ---
    const VOICE_SELECTOR = 'span[aria-label="Voice message"], span[aria-label="Sprachnachricht"]';
    const DOWNLOAD_SELECTOR = '[aria-label="Download"], [aria-label="Herunterladen"]';

    const BUTTON_LABELS = {
        idle: '📄 Transcribe',
        menu: '🔍 Finding menu...',
        download: '⏳ Extracting...',
        upload: '🚀 Transcribing...',
        close: '✖ Close',
        error: '🔄 Try again'
    };

    // WhatsApp unmounts rows that scroll out of view, so finished transcripts are kept per message id
    const transcripts = new Map();
    let currentSession = null;

    document.addEventListener('AudioCaught', async (e) => {
        if (!currentSession) return;
        const blobUrl = e.detail;
        const ui = currentSession;
        currentSession = null;

        setBtnState(ui.btn, 'upload');

        try {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            sendToAPI(blob, ui);
        } catch (err) {
            console.error("Fetch error:", err);
            showError(ui, "File error");
        }
    });

    function setBtnState(btn, state) {
        btn.dataset.state = state;
        btn.textContent = BUTTON_LABELS[state];
    }

    function isTransparent(color) {
        return color === 'transparent' || /,\s*0\)$/.test(color);
    }

    function isDark(color) {
        const [r, g, b] = (color.match(/\d+(\.\d+)?/g) || [0, 0, 0]).map(Number);
        return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }

    // The bubble is the element that paints the green/grey background
    function findBubble(label, row) {
        const msgContainer = label.closest('[data-testid="msg-container"]');
        if (msgContainer) {
            return [...msgContainer.children].find(child => child.contains(label)) || null;
        }
        for (let el = label.parentElement; el && el !== row; el = el.parentElement) {
            if (!isTransparent(getComputedStyle(el).backgroundColor)) return el;
        }
        return null;
    }

    function findAndInjectButtons() {
        document.querySelectorAll(VOICE_SELECTOR).forEach(label => {
            const row = label.closest('[role="row"]');
            if (!row || row.querySelector('.wa-tr-wrap')) return;

            const bubble = findBubble(label, row);
            if (!bubble) return;
            const content = [...bubble.children].find(child => child.contains(label));
            if (!content) return;

            // WhatsApp pins the timestamp to the bottom of the bubble. Turning the original content into
            // its containing block keeps it next to the waveform instead of sliding under our buttons.
            if (getComputedStyle(content).position === 'static') {
                content.style.position = 'relative';
            }

            const idHolder = row.querySelector('[data-id]') || row.closest('[data-id]');
            const ui = createUI(bubble, idHolder ? idHolder.getAttribute('data-id') : null);
            content.after(ui.wrapper);
        });
    }

    function createUI(bubble, msgId) {
        const wrapper = document.createElement('div');
        wrapper.className = 'wa-tr-wrap ' + (isDark(getComputedStyle(bubble).backgroundColor) ? 'wa-tr-dark' : 'wa-tr-light');

        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'wa-tr-buttons';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'wa-tr-btn wa-tr-copy';
        copyBtn.textContent = '📋 Copy';
        copyBtn.hidden = true;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wa-tr-btn';

        buttonGroup.append(copyBtn, btn);
        wrapper.appendChild(buttonGroup);

        const ui = { bubble, wrapper, btn, copyBtn, msgId, text: '' };

        btn.onclick = (e) => {
            e.stopPropagation();
            if (btn.dataset.state === 'close' || btn.dataset.state === 'error') {
                const textDiv = wrapper.querySelector('.wa-tr-text');
                if (textDiv) textDiv.remove();
                if (msgId) transcripts.delete(msgId);
                copyBtn.hidden = true;
                setBtnState(btn, 'idle');
            } else if (btn.dataset.state === 'idle') {
                const currentKey = checkAndGetApiKey();
                if (currentKey && currentKey.trim() !== '') {
                    startDownloadTrick(ui);
                } else {
                    showError(ui, "Missing API Key");
                }
            }
        };

        copyBtn.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(ui.text).then(() => {
                copyBtn.textContent = '✅ Copied!';
                copyBtn.dataset.copied = 'true';
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy';
                    delete copyBtn.dataset.copied;
                }, 2000);
            });
        };

        if (msgId && transcripts.has(msgId)) {
            showResult(ui, transcripts.get(msgId));
        } else {
            setBtnState(btn, 'idle');
        }
        return ui;
    }

    function startDownloadTrick(ui) {
        setBtnState(ui.btn, 'menu');
        currentSession = ui;
        unsafeWindow.__transcriberTrapArmed = true;

        // Only accept a "Download" entry that appears after opening the menu, never one already on the page
        const existingDownloads = new Set(document.querySelectorAll(DOWNLOAD_SELECTOR));

        const playBtn = ui.bubble.querySelector('button[aria-label="Play voice message"], button[aria-label="Pause voice message"]');
        const targetElement = playBtn || ui.bubble;
        const rect = targetElement.getBoundingClientRect();

        const rightClickEvent = new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, view: unsafeWindow,
            button: 2, buttons: 2,
            clientX: rect.left + (rect.width / 2),
            clientY: rect.top + (rect.height / 2)
        });
        targetElement.dispatchEvent(rightClickEvent);

        let attempts = 0;
        const findMenuInterval = setInterval(() => {
            attempts++;
            const downloadBtn = [...document.querySelectorAll(DOWNLOAD_SELECTOR)].find(el => !existingDownloads.has(el));

            if (downloadBtn) {
                clearInterval(findMenuInterval);
                setBtnState(ui.btn, 'download');
                downloadBtn.click();
            } else if (attempts > 40) {
                clearInterval(findMenuInterval);
                unsafeWindow.__transcriberTrapArmed = false;
                currentSession = null;
                showError(ui, "Menu error");
                document.body.click();
            }
        }, 50);

        setTimeout(() => {
            if (unsafeWindow.__transcriberTrapArmed === true && currentSession === ui) {
                unsafeWindow.__transcriberTrapArmed = false;
                currentSession = null;
                showError(ui, "Timeout");
                document.body.click();
            }
        }, 4000);
    }

    // Groq picks the decoder by file extension, forwarded audio files are not always Opus
    function fileNameFor(blob) {
        const extensions = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac' };
        return 'voice_message.' + (extensions[blob.type.split(';')[0].trim()] || 'ogg');
    }

    function sendToAPI(blob, ui) {
        updateTextContent(getTextContainer(ui), "...", false);

        const formData = new FormData();
        formData.append('file', blob, fileNameFor(blob));
        formData.append('model', 'whisper-large-v3');

        if (targetLanguage && targetLanguage !== '') {
            formData.append('language', targetLanguage);
        }

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.groq.com/openai/v1/audio/transcriptions",
            headers: { "Authorization": `Bearer ${apiKey}` },
            data: formData,
            onload: function(res) {
                if (res.status === 200) {
                    try {
                        const resultText = JSON.parse(res.responseText).text.trim();
                        if (ui.msgId) transcripts.set(ui.msgId, resultText);
                        showResult(ui, resultText);
                    } catch (err) {
                        showError(ui, "Invalid API response");
                    }
                } else {
                    showError(ui, describeApiError(res));
                }
            },
            onerror: function() {
                showError(ui, "Offline");
            }
        });
    }

    function describeApiError(res) {
        let detail = '';
        try {
            detail = JSON.parse(res.responseText).error.message;
        } catch (err) { /* no JSON body */ }
        if (res.status === 401) detail = 'Invalid API key, change it via the Tampermonkey menu';
        return `API Error ${res.status}` + (detail ? `: ${detail}` : '');
    }

    function showResult(ui, text) {
        ui.text = text;
        updateTextContent(getTextContainer(ui), text, false);
        setBtnState(ui.btn, 'close');
        ui.copyBtn.hidden = false;
    }

    function showError(ui, msg) {
        setBtnState(ui.btn, 'error');
        ui.copyBtn.hidden = true;
        updateTextContent(getTextContainer(ui), msg, true);
    }

    function getTextContainer(ui) {
        let textDiv = ui.wrapper.querySelector('.wa-tr-text');
        if (!textDiv) {
            textDiv = document.createElement('div');
            textDiv.className = 'wa-tr-text';
            ui.wrapper.insertBefore(textDiv, ui.wrapper.firstChild);
        }
        return textDiv;
    }

    function updateTextContent(container, text, isError) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'wa-tr-icon';
        iconSpan.textContent = isError ? '🤖 ❌' : '🤖';

        const textSpan = document.createElement('span');
        textSpan.className = 'wa-tr-body';
        textSpan.textContent = text;

        container.replaceChildren(iconSpan, textSpan);
    }

    // Throttled, but mutations arriving during the pause still get one trailing pass
    let isThrottled = false;
    let hasPendingMutations = false;
    function scheduleScan() {
        if (isThrottled) {
            hasPendingMutations = true;
            return;
        }
        isThrottled = true;
        requestAnimationFrame(() => {
            findAndInjectButtons();
            setTimeout(() => {
                isThrottled = false;
                if (hasPendingMutations) {
                    hasPendingMutations = false;
                    scheduleScan();
                }
            }, 100);
        });
    }
    const observer = new MutationObserver(scheduleScan);

    setTimeout(() => {
        console.log("🚀 Voice Transcriber started.");
        setTimeout(checkAndGetApiKey, 1000);
        findAndInjectButtons();
        observer.observe(document.body, { childList: true, subtree: true });
    }, 1500);

})();
