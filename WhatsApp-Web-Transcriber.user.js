// ==UserScript==
// @name         WhatsApp Web Transcriber
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Transcribes and summarizes WhatsApp voice messages with one click
// @author       DevEmperor
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
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
    const CACHE_NAME = 'TRANSCRIPT_CACHE';

    const TRANSCRIPTION_MODEL = 'whisper-large-v3';
    const SUMMARY_MODEL = 'openai/gpt-oss-120b';
    const SUMMARY_MIN_CHARS = 280; // Roughly 30 seconds of speech
    const CACHE_LIMIT = 500;

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

    // Menu: Clear Cache
    GM_registerMenuCommand("🗑️ Clear Transcript Cache", () => {
        if (confirm(`Delete all ${cache.size} saved transcripts and summaries?`)) {
            cache.clear();
            GM_setValue(CACHE_NAME, {});
            alert("✅ Transcript cache cleared!");
        }
    });

    // Menu: Diagnostics
    GM_registerMenuCommand("🩺 Copy Diagnostics", () => copyDiagnostics());


    // === TRANSCRIPT CACHE ===
    // Message id -> { text, summary, open, ts }. Persisted, so transcripts survive reloads and scrolling.
    const storedCache = GM_getValue(CACHE_NAME, {});
    const cache = new Map(storedCache && typeof storedCache === 'object' ? Object.entries(storedCache) : []);
    let saveTimer = null;

    function updateCache(msgId, changes) {
        if (!msgId) return;
        cache.set(msgId, Object.assign({ text: '', summary: '', open: false }, cache.get(msgId), changes, { ts: Date.now() }));

        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const newest = [...cache.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, CACHE_LIMIT);
            cache.clear();
            newest.forEach(([id, entry]) => cache.set(id, entry));
            GM_setValue(CACHE_NAME, Object.fromEntries(newest));
        }, 500);
    }

    // Recent events for the diagnostics report (never message content)
    const eventLog = [];
    function logEvent(msg) {
        eventLog.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
        if (eventLog.length > 20) eventLog.shift();
    }


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

    // --- 2. WHATSAPP INTERNALS ---
    // Same modules whatsapp-web.js uses. They download the audio without the context menu and without
    // depending on the UI language. If WhatsApp renames them, everything falls back to the UI.
    let store = null;
    let nextStoreProbe = 0;
    let storeProbes = 0;

    // Probes every 5s while WhatsApp is still loading, gives up after a minute
    function getStore() {
        if (store || storeProbes >= 12 || Date.now() < nextStoreProbe) return store;
        nextStoreProbe = Date.now() + 5000;
        storeProbes++;
        try {
            const req = unsafeWindow.require;
            const collections = typeof req === 'function' ? req('WAWebCollections') : null;
            if (collections && collections.Msg) store = { req, Msg: collections.Msg };
        } catch (err) {
            if (storeProbes === 1) logEvent('store unavailable: ' + err.message);
        }
        if (!store && storeProbes === 12) logEvent('store: gave up, using the context menu');
        return store;
    }

    // In Firefox's sandbox, objects handed to page functions must be cloned into the page
    // and page promises can only call back into exported functions
    function toPage(obj) {
        return typeof cloneInto === 'function' ? cloneInto(obj, unsafeWindow) : obj;
    }

    function awaitPage(promise) {
        if (!promise || typeof promise.then !== 'function') return Promise.resolve();
        const exported = fn => (typeof exportFunction === 'function' ? exportFunction(fn, unsafeWindow) : fn);
        return new Promise((resolve, reject) => {
            promise.then(exported(() => resolve()), exported(err => reject(new Error(String(err)))));
        });
    }

    function allMessages(s) {
        if (typeof s.Msg.getModelsArray === 'function') return s.Msg.getModelsArray();
        return s.Msg.models || s.Msg._models || [];
    }

    // The ids in the DOM and in the store can differ (e.g. phone number vs. LID of the chat),
    // but both contain the same message key
    function messageKeys(row) {
        const idHolder = row.querySelector('[data-id]') || row.closest('[data-id]');
        if (!idHolder) return [];
        const raw = `${idHolder.getAttribute('data-id')} ${idHolder.getAttribute('data-testid') || ''}`;
        return raw.match(/(?<![0-9A-Za-z])(?=[0-9A-F]*[A-F])[0-9A-F]{12,}(?![0-9A-Za-z])/g) || [];
    }

    function findMessage(row) {
        const s = getStore();
        if (!s || !row) return { msg: null, via: 'none' };
        try {
            const direct = s.Msg.get(getMessageId(row));
            if (direct) return { msg: direct, via: 'id' };

            const keys = messageKeys(row);
            if (keys.length) {
                const models = allMessages(s);
                for (let i = models.length - 1; i >= 0; i--) {
                    const model = models[i];
                    if (model && model.id && keys.includes(model.id.id)) return { msg: model, via: 'key' };
                }
            }
        } catch (err) { /* collection API changed */ }
        return { msg: null, via: 'none' };
    }

    async function extractViaStore(row) {
        const s = getStore();
        const { msg } = findMessage(row);
        if (!s || !msg || !msg.mediaData) return null;

        await awaitPage(msg.downloadMedia(toPage({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true })));
        const stage = String(msg.mediaData.mediaStage);
        if (stage.includes('ERROR') || stage === 'FETCHING') return null;

        let pageBlob = null;
        try {
            pageBlob = s.req('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache.get(msg.mediaObject?.filehash);
        } catch (err) { /* module renamed, try the media object below */ }
        if (!pageBlob && msg.mediaObject?.mediaBlob) pageBlob = msg.mediaObject.mediaBlob.forceToBlob();
        if (!pageBlob) return null;

        // Read the page's blob through an object URL, like the context menu download does
        const url = unsafeWindow.URL.createObjectURL(pageBlob);
        try {
            const blob = await (await fetch(url)).blob();
            return new Blob([blob], { type: msg.mimetype || blob.type });
        } finally {
            unsafeWindow.URL.revokeObjectURL(url);
        }
    }

    // --- 3. STYLES ---
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
        .wa-tr-box {
            box-sizing: border-box;
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
        .wa-tr-text { max-height: 350px; overflow-y: auto; }
        .wa-tr-text .wa-tr-body { font-style: italic; }
        .wa-tr-summary { border-left: 3px solid #00a884; }
        .wa-tr-title { margin-bottom: 2px; font-size: 12px; font-weight: bold; opacity: 0.75; }
        .wa-tr-line { padding-left: 0.6em; text-indent: -0.6em; } /* wrapped lines align with the text after the bullet */
        .wa-tr-icon { font-style: normal; margin-right: 4px; } /* Emojis must not be italic */
        .wa-tr-buttons { display: flex; gap: 8px; }
        .wa-tr-btn {
            flex: 1;
            min-width: 0;
            margin: 0;
            padding: 8px 6px;
            border: none;
            border-radius: 8px;
            background: transparent;
            color: var(--wa-tr-fg);
            font-family: inherit;
            font-size: 13px;
            font-weight: bold;
            line-height: 1.2;
            text-align: center;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: pointer;
            transition: background-color 0.2s, filter 0.2s;
        }
        .wa-tr-btn[hidden] { display: none; }
        .wa-tr-main { flex: 2; }
        .wa-tr-buttons:has(.wa-tr-sum:not([hidden])) .wa-tr-main { flex: 1; }
        .wa-tr-copy, .wa-tr-sum { background: var(--wa-tr-soft); }
        .wa-tr-main[data-state="idle"]:hover { background: var(--wa-tr-hover); }
        .wa-tr-main[data-state="menu"], .wa-tr-main[data-state="download"], .wa-tr-main[data-state="upload"], .wa-tr-sum[data-state="busy"] {
            background: #8696a0; color: white; cursor: progress;
        }
        .wa-tr-main[data-state="close"], .wa-tr-main[data-state="error"], .wa-tr-sum[data-state="error"] { background: #d14553; color: white; }
        .wa-tr-copy[data-copied] { background: #00a884; color: white; }
        .wa-tr-copy:hover, .wa-tr-sum:hover, .wa-tr-main[data-state="close"]:hover, .wa-tr-main[data-state="error"]:hover { filter: brightness(1.12); }
    `);

    // --- 4. TAMPERMONKEY LOGIC ---
    // The progress slider exists in every UI language, the labels are a fallback for older layouts
    const AUDIO_ANCHOR_SELECTOR = '[role="row"] [role="slider"], span[aria-label="Voice message"], span[aria-label="Sprachnachricht"]';
    const AUDIO_TYPES = ['ptt', 'audio'];
    const DOWNLOAD_SELECTOR = ['Download', 'Herunterladen', 'Descargar', 'Télécharger', 'Scarica', 'Baixar']
        .map(label => `[aria-label="${label}"]`).concat('[role="menuitem"]:has([data-icon*="download"])').join(', ');

    const MAIN_LABELS = {
        idle: '📄 Transcribe',
        menu: '🔍 Finding menu...',
        download: '⏳ Extracting...',
        upload: '🚀 Transcribing...',
        close: '✖ Close',
        error: '🔄 Try again'
    };
    const SUMMARY_LABELS = {
        idle: '✨ Summary',
        busy: '⏳ Thinking...',
        error: '🔄 Summary'
    };
    const SUMMARY_PROMPT = "You summarize transcripts of WhatsApp voice messages. Answer in the same language as the transcript. " +
        "Write 2 to 5 bullet points depending on the length, each on its own line starting with '• ' and at most about 20 words long. " +
        "Only the key points: no introduction, no closing remark, no markdown.";

    let currentSession = null;
    let warnedLayout = false;

    document.addEventListener('AudioCaught', async (e) => {
        if (!currentSession) return;
        const blobUrl = e.detail;
        const ui = currentSession;
        currentSession = null;

        setBtnState(ui.btn, 'upload');
        logEvent('audio via context menu');

        try {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            sendToAPI(blob, ui);
        } catch (err) {
            console.error("Fetch error:", err);
            showError(ui, "File error");
        }
    });

    function setBtnState(btn, state, labels = MAIN_LABELS) {
        btn.dataset.state = state;
        btn.textContent = labels[state];
    }

    function isTransparent(color) {
        return color === 'transparent' || /,\s*0\)$/.test(color);
    }

    function isDark(color) {
        const [r, g, b] = (color.match(/\d+(\.\d+)?/g) || [0, 0, 0]).map(Number);
        return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }

    // The bubble is the element that paints the green/grey background
    function findBubble(anchor, row) {
        const msgContainer = anchor.closest('[data-testid="msg-container"]');
        if (msgContainer) {
            return [...msgContainer.children].find(child => child.contains(anchor)) || null;
        }
        for (let el = anchor.parentElement; el && el !== row; el = el.parentElement) {
            if (!isTransparent(getComputedStyle(el).backgroundColor)) return el;
        }
        return null;
    }

    function getMessageId(row) {
        const idHolder = row.querySelector('[data-id]') || row.closest('[data-id]');
        return idHolder ? idHolder.getAttribute('data-id') : null;
    }

    function findAndInjectButtons() {
        document.querySelectorAll(AUDIO_ANCHOR_SELECTOR).forEach(anchor => {
            const row = anchor.closest('[role="row"]');
            if (!row || row.querySelector('.wa-tr-wrap')) return;

            const { msg } = findMessage(row);
            if (msg && !AUDIO_TYPES.includes(msg.type)) return;

            const bubble = findBubble(anchor, row);
            const content = bubble && [...bubble.children].find(child => child.contains(anchor));
            if (!content) {
                if (!warnedLayout) {
                    warnedLayout = true;
                    logEvent('layout: voice message found, but no bubble');
                    console.warn("🤖 Voice Transcriber: Found a voice message but could not attach the button. WhatsApp probably changed its layout, please use '🩺 Copy Diagnostics' from the Tampermonkey menu and open an issue.");
                }
                return;
            }

            // WhatsApp pins the timestamp to the bottom of the bubble. Turning the original content into
            // its containing block keeps it next to the waveform instead of sliding under our buttons.
            if (getComputedStyle(content).position === 'static') {
                content.style.position = 'relative';
            }

            content.after(createUI(bubble, row).wrapper);
        });
    }

    function createUI(bubble, row) {
        const msgId = getMessageId(row);

        const wrapper = document.createElement('div');
        wrapper.className = 'wa-tr-wrap ' + (isDark(getComputedStyle(bubble).backgroundColor) ? 'wa-tr-dark' : 'wa-tr-light');

        const buttons = document.createElement('div');
        buttons.className = 'wa-tr-buttons';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'wa-tr-btn wa-tr-copy';
        copyBtn.textContent = '📋 Copy';
        copyBtn.hidden = true;

        const sumBtn = document.createElement('button');
        sumBtn.type = 'button';
        sumBtn.className = 'wa-tr-btn wa-tr-sum';
        sumBtn.hidden = true;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wa-tr-btn wa-tr-main';

        buttons.append(copyBtn, sumBtn, btn);
        wrapper.appendChild(buttons);

        const ui = { bubble, row, wrapper, buttons, btn, copyBtn, sumBtn, msgId, text: '', summary: '' };

        btn.onclick = (e) => {
            e.stopPropagation();
            if (btn.dataset.state === 'close' || btn.dataset.state === 'error') {
                wrapper.querySelectorAll('.wa-tr-box').forEach(box => box.remove());
                copyBtn.hidden = true;
                sumBtn.hidden = true;
                setBtnState(btn, 'idle');
                if (cache.has(msgId)) updateCache(msgId, { open: false });
            } else if (btn.dataset.state === 'idle') {
                const cached = msgId && cache.get(msgId);
                if (cached && cached.text) {
                    showResult(ui, cached.text, cached.summary);
                    updateCache(msgId, { open: true });
                    return;
                }
                const currentKey = checkAndGetApiKey();
                if (currentKey && currentKey.trim() !== '') {
                    startTranscription(ui);
                } else {
                    showError(ui, "Missing API Key");
                }
            }
        };

        sumBtn.onclick = (e) => {
            e.stopPropagation();
            if (sumBtn.dataset.state !== 'busy') requestSummary(ui);
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

        const cached = msgId && cache.get(msgId);
        if (cached && cached.text && cached.open) {
            showResult(ui, cached.text, cached.summary);
        } else {
            setBtnState(btn, 'idle');
        }
        return ui;
    }

    async function startTranscription(ui) {
        setBtnState(ui.btn, 'download');
        let blob = null;
        try {
            blob = await extractViaStore(ui.row);
        } catch (err) {
            logEvent('store download failed: ' + err.message);
        }

        if (blob) {
            logEvent(`audio via store: ${blob.size} bytes, ${blob.type}`);
            setBtnState(ui.btn, 'upload');
            sendToAPI(blob, ui);
        } else {
            startDownloadTrick(ui);
        }
    }

    // Prefer the play button, the slider exists in every UI language
    function contextMenuTarget(root) {
        return root.querySelector('button[aria-label="Play voice message"], button[aria-label="Pause voice message"]')
            || root.querySelector('[role="slider"]')
            || root;
    }

    function openContextMenu(target) {
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, view: unsafeWindow,
            button: 2, buttons: 2,
            clientX: rect.left + (rect.width / 2),
            clientY: rect.top + (rect.height / 2)
        }));
    }

    function startDownloadTrick(ui) {
        setBtnState(ui.btn, 'menu');
        currentSession = ui;
        unsafeWindow.__transcriberTrapArmed = true;

        // Only accept a "Download" entry that appears after opening the menu, never one already on the page
        const existingDownloads = new Set(document.querySelectorAll(DOWNLOAD_SELECTOR));
        openContextMenu(contextMenuTarget(ui.bubble));

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
                logEvent('menu: no download entry found');
                showError(ui, "Menu error");
                document.body.click();
            }
        }, 50);

        setTimeout(() => {
            if (unsafeWindow.__transcriberTrapArmed === true && currentSession === ui) {
                unsafeWindow.__transcriberTrapArmed = false;
                currentSession = null;
                logEvent('menu: download timed out');
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
        updateTextContent(getBox(ui, 'wa-tr-text'), '🤖', "...");

        const formData = new FormData();
        formData.append('file', blob, fileNameFor(blob));
        formData.append('model', TRANSCRIPTION_MODEL);

        if (targetLanguage && targetLanguage !== '') {
            formData.append('language', targetLanguage);
        }

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.groq.com/openai/v1/audio/transcriptions",
            headers: { "Authorization": `Bearer ${apiKey}` },
            data: formData,
            onload: function(res) {
                logEvent(`transcription API ${res.status}`);
                if (res.status === 200) {
                    try {
                        const resultText = JSON.parse(res.responseText).text.trim();
                        updateCache(ui.msgId, { text: resultText, summary: '', open: true });
                        showResult(ui, resultText, '');
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

    function requestSummary(ui) {
        setBtnState(ui.sumBtn, 'busy', SUMMARY_LABELS);

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.groq.com/openai/v1/chat/completions",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            data: JSON.stringify({
                model: SUMMARY_MODEL,
                messages: [
                    { role: 'system', content: SUMMARY_PROMPT },
                    { role: 'user', content: ui.text }
                ],
                reasoning_effort: 'low',
                include_reasoning: false,
                max_completion_tokens: 1024
            }),
            onload: function(res) {
                logEvent(`summary API ${res.status}`);
                if (res.status === 200) {
                    try {
                        const summary = cleanSummary(JSON.parse(res.responseText).choices[0].message.content);
                        if (!summary) throw new Error('empty summary');
                        updateCache(ui.msgId, { summary });
                        showSummary(ui, summary);
                    } catch (err) {
                        showSummaryError(ui, "Invalid API response");
                    }
                } else {
                    showSummaryError(ui, describeApiError(res));
                }
            },
            onerror: function() {
                showSummaryError(ui, "Offline");
            }
        });
    }

    // Models sometimes answer with markdown bullets or bold text despite the prompt
    function cleanSummary(text) {
        return (text || '').replace(/\*\*/g, '').split('\n')
            .map(line => line.trim()).filter(Boolean)
            .map(line => line.replace(/^([-*•]|\d+[.)])\s*/, '• '))
            .join('\n');
    }

    function describeApiError(res) {
        let detail = '';
        try {
            detail = JSON.parse(res.responseText).error.message;
        } catch (err) { /* no JSON body */ }
        if (res.status === 401) detail = 'Invalid API key, change it via the Tampermonkey menu';
        if (res.status === 429) {
            const retryAfter = /retry-after:\s*(\d+)/i.exec(res.responseHeaders || '');
            detail = 'Rate limit reached' + (retryAfter ? `, try again in ${retryAfter[1]}s` : ', try again later');
        }
        return `API Error ${res.status}` + (detail ? `: ${detail}` : '');
    }

    function showResult(ui, text, summary) {
        ui.text = text;
        updateTextContent(getBox(ui, 'wa-tr-text'), '🤖', text);
        setBtnState(ui.btn, 'close');
        ui.copyBtn.hidden = false;
        if (summary) {
            showSummary(ui, summary);
        } else {
            setBtnState(ui.sumBtn, 'idle', SUMMARY_LABELS);
            ui.sumBtn.hidden = text.length < SUMMARY_MIN_CHARS;
        }
    }

    function showSummary(ui, summary) {
        ui.summary = summary;

        const title = document.createElement('div');
        title.className = 'wa-tr-title';
        title.textContent = '✨ Summary';

        const lines = summary.split('\n').map(line => {
            const lineDiv = document.createElement('div');
            lineDiv.className = 'wa-tr-line';
            lineDiv.textContent = line;
            return lineDiv;
        });

        getBox(ui, 'wa-tr-summary').replaceChildren(title, ...lines);
        ui.sumBtn.hidden = true;
    }

    function showSummaryError(ui, msg) {
        updateTextContent(getBox(ui, 'wa-tr-summary'), '✨ ❌', msg);
        setBtnState(ui.sumBtn, 'error', SUMMARY_LABELS);
    }

    function showError(ui, msg) {
        setBtnState(ui.btn, 'error');
        ui.copyBtn.hidden = true;
        ui.sumBtn.hidden = true;
        updateTextContent(getBox(ui, 'wa-tr-text'), '🤖 ❌', msg);
    }

    // Boxes stack as summary, transcript, buttons
    function getBox(ui, className) {
        let box = ui.wrapper.querySelector('.' + className);
        if (!box) {
            box = document.createElement('div');
            box.className = 'wa-tr-box ' + className;
            const before = className === 'wa-tr-summary' ? (ui.wrapper.querySelector('.wa-tr-text') || ui.buttons) : ui.buttons;
            ui.wrapper.insertBefore(box, before);
        }
        return box;
    }

    function updateTextContent(container, icon, text) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'wa-tr-icon';
        iconSpan.textContent = icon;

        const textSpan = document.createElement('span');
        textSpan.className = 'wa-tr-body';
        textSpan.textContent = text;

        container.replaceChildren(iconSpan, textSpan);
    }

    // --- 5. DIAGNOSTICS ---
    // Structure only: message texts are replaced by their length, numbers and sender names are masked
    const TIME_LIKE = /^[\d:.\s]{3,8}(\s?[AaPp]\.?\s?[Mm]\.?)?$/;

    function maskLabel(label) {
        const text = label.replace(/\+?\d[\d\s()-]{6,}\d/g, '#').trim();
        if (text.endsWith(':') || /^(\p{Lu}[\p{L}'.-]*\s*){2,}$/u.test(text)) return '«name»';
        // Names inside labels like "React to message from Jane Doe": capitalized words after the first one
        return text.replace(/(\s)\p{Lu}[\p{L}'.-]*(\s+\p{Lu}[\p{L}'.-]*)*/gu, '$1«name»').slice(0, 40);
    }

    // Keeps the shape of an id ("false_#@lid_KEY") without the numbers or the message key
    function maskId(id) {
        return String(id || '-')
            .replace(/(?<![0-9A-Za-z])(?=[0-9A-F]*[A-F])[0-9A-F]{12,}(?![0-9A-Za-z])/g, 'KEY')
            .replace(/\d{4,}/g, '#');
    }

    function describeElement(el, base) {
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const box = prop => ['Top', 'Right', 'Bottom', 'Left'].map(side => cs[prop + side]).join(' ');
        const out = [el.tagName.toLowerCase()];

        const cls = el.getAttribute('class');
        if (cls && cls.trim()) out.push('.' + cls.trim().split(/\s+/).join('.'));
        for (const attr of ['role', 'aria-label', 'data-icon', 'data-testid', 'dir', 'tabindex']) {
            if (el.hasAttribute(attr)) out.push(`[${attr}="${maskLabel(el.getAttribute(attr))}"]`);
        }
        for (const attr of ['data-id', 'data-state']) {
            if (el.hasAttribute(attr)) out.push(`[${attr}]`);
        }
        out.push(`@${Math.round(rect.left - base.left)},${Math.round(rect.top - base.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        if (!['block', 'inline'].includes(cs.display)) out.push('d:' + cs.display);
        if (cs.position !== 'static') out.push(`pos:${cs.position}(t:${cs.top} r:${cs.right} b:${cs.bottom} l:${cs.left})`);
        if (box('padding') !== '0px 0px 0px 0px') out.push('pad:' + box('padding'));
        if (box('margin') !== '0px 0px 0px 0px') out.push('mar:' + box('margin'));
        if (!isTransparent(cs.backgroundColor)) out.push('bg:' + cs.backgroundColor);

        const texts = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim());
        if (texts.length) out.push('txt:' + texts.map(t => TIME_LIKE.test(t) ? `"${t}"` : `«${t.length}»`).join('|'));
        return out.join(' ');
    }

    function dumpTree(el, base, indent, out, depth, maxDepth) {
        out.push(indent + describeElement(el, base));
        if (el.tagName.toLowerCase() === 'svg') return;
        if (depth >= maxDepth) {
            if (el.children.length) out.push(indent + '  …');
            return;
        }
        const signature = node => node.tagName + '|' + node.getAttribute('class');
        const kids = [...el.children];
        for (let i = 0; i < kids.length;) {
            let j = i + 1;
            while (j < kids.length && signature(kids[j]) === signature(kids[i])) j++;
            dumpTree(kids[i], base, indent + '  ', out, depth + 1, maxDepth);
            if (j - i > 3) {
                out.push(`${indent}  … +${j - i - 1}x same`);
                i = j;
            } else {
                i++;
            }
        }
    }

    async function dumpContextMenu(bubble) {
        const added = [];
        const observer = new MutationObserver(records => records.forEach(record =>
            record.addedNodes.forEach(node => { if (node.nodeType === 1) added.push(node); })));
        observer.observe(document.body, { childList: true, subtree: true });
        openContextMenu(contextMenuTarget(bubble));
        await new Promise(resolve => setTimeout(resolve, 600));
        observer.disconnect();

        const out = [];
        added.filter(node => node.isConnected && !node.closest('.wa-tr-wrap') && !added.some(other => other !== node && other.contains(node)))
            .slice(0, 5)
            .forEach(node => dumpTree(node, node.getBoundingClientRect(), '', out, 0, 10));
        document.body.click();
        return out.length ? out : ['(no menu appeared)'];
    }

    async function copyDiagnostics() {
        const anchors = document.querySelectorAll(AUDIO_ANCHOR_SELECTOR);
        const lines = [
            `Script ${GM_info.script.version} | ${GM_info.scriptHandler} ${GM_info.version} | ${navigator.userAgent}`,
            `lang=${document.documentElement.lang} exportFunction=${typeof exportFunction} store=${!!getStore()} cache=${cache.size}`,
            `anchors=${anchors.length} wrappers=${document.querySelectorAll('.wa-tr-wrap').length} rows=${document.querySelectorAll('[role="row"]').length}`
        ];

        // Newest voice message, preferably one that got a button
        const rows = [...anchors].map(el => el.closest('[role="row"]')).filter(Boolean).reverse();
        const row = rows.find(r => r.querySelector('.wa-tr-wrap')) || rows[0];
        const anchor = row && row.querySelector(AUDIO_ANCHOR_SELECTOR);
        if (row) {
            const { msg, via } = findMessage(row);
            lines.push(`message: lookup=${via} type=${msg && msg.type} mimetype=${msg && msg.mimetype} stage=${msg && msg.mediaData && msg.mediaData.mediaStage}`);
            const s = getStore();
            if (s) {
                try {
                    const models = allMessages(s);
                    const sample = models[models.length - 1];
                    const serialized = model => model && model.id && (model.id._serialized || model.id.$1);
                    lines.push(`ids: dom=${maskId(getMessageId(row))} keys=${messageKeys(row).length} model=${maskId(serialized(msg))} sample=${maskId(serialized(sample))} models=${models.length}`);
                } catch (err) {
                    lines.push('ids: error ' + err.message);
                }
            }
            if (!msg || AUDIO_TYPES.includes(msg.type)) {
                try {
                    const blob = await extractViaStore(row);
                    lines.push('store download: ' + (blob ? `${blob.size} bytes, ${blob.type}` : 'no audio'));
                } catch (err) {
                    lines.push('store download error: ' + err.message);
                }
            }
            lines.push('', '=== Row ===');
            dumpTree(row, row.getBoundingClientRect(), '', lines, 0, 18);
            const bubble = findBubble(anchor, row);
            if (bubble) lines.push('', '=== Context menu ===', ...await dumpContextMenu(bubble));
        } else {
            lines.push('(no voice message visible, open a chat with one and try again)');
        }

        lines.push('', '=== Events ===', ...eventLog);
        GM_setClipboard(lines.join('\n'), 'text');
        alert("🩺 Diagnostics copied to the clipboard.\n\nMessage texts are not included, but please skim it before sharing.");
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
