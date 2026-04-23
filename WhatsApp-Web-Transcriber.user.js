// ==UserScript==
// @name         WhatsApp Web Transcriber
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Transcribes WhatsApp voice messages with one click
// @author       DevEmperor
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
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
                GM_setValue(API_KEY_NAME, apiKey.trim());
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

        // If user clicks "Cancel", newLang is null. If they click "OK", it's a string.
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
    unsafeWindow.HTMLAnchorElement.prototype.click = function() {
        if (unsafeWindow.__transcriberTrapArmed === true && this.download) {
            unsafeWindow.__transcriberTrapArmed = false;
            document.dispatchEvent(new CustomEvent('AudioCaught', { detail: this.href }));
            return;
        }
        return originalClick.apply(this, arguments);
    };

    // --- 2. TAMPERMONKEY LOGIC ---
    let currentSession = null;

    document.addEventListener('AudioCaught', async (e) => {
        if (!currentSession) return;
        const blobUrl = e.detail;
        const { btnWrapper, btn, isOut } = currentSession;
        currentSession = null;

        setBtnState(btn, 'upload', isOut);

        try {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            sendToAPI(blob, btnWrapper, btn, isOut);
        } catch (err) {
            console.error("Fetch error:", err);
            showError(btn, btnWrapper, "File error", isOut);
        }
    });

    // Manages dynamic button states and colors
    function setBtnState(btn, state, isOut) {
        btn.dataset.state = state;

        // Colors: Green for sent, dark grey for received
        const defaultColor = isOut ? '#144d37' : '#242626';

        if (state === 'idle') {
            btn.innerHTML = '📄 Transcribe';
            btn.style.backgroundColor = defaultColor;
        } else if (state === 'menu') {
            btn.innerHTML = '🔍 Finding menu...';
            btn.style.backgroundColor = '#8696a0';
        } else if (state === 'download') {
            btn.innerHTML = '⏳ Extracting...';
            btn.style.backgroundColor = '#8696a0';
        } else if (state === 'upload') {
            btn.innerHTML = '🚀 Transcribing...';
            btn.style.backgroundColor = '#8696a0';
        } else if (state === 'close') {
            btn.innerHTML = '✖ Close';
            btn.style.backgroundColor = '#d14553'; // Red
        } else if (state === 'error') {
            btn.innerHTML = '🔄 Try again';
            btn.style.backgroundColor = '#d14553'; // Red
        }
    }

    function findAndInjectButtons() {
        const voiceMessageLabels = document.querySelectorAll('span[aria-label="Voice message"]');
        voiceMessageLabels.forEach(label => {
            const messageContainer = label.closest('.message-in, .message-out');
            if (!messageContainer) return;

            const isOut = messageContainer.classList.contains('message-out');

            // Locate the main colored bubble
            const coloredBubble = messageContainer.querySelector('._ak4a, ._ak49') || messageContainer.querySelector('[data-id] > div > div > div');
            if (!coloredBubble || coloredBubble.querySelector('.wa-transcribe-wrapper')) return;

            // --- EXACT TIMESTAMP ANCHORING ---
            const timeStampContainer = coloredBubble.querySelector('._ak4s');
            if (timeStampContainer && !timeStampContainer.dataset.anchored) {
                if (window.getComputedStyle(coloredBubble).position === 'static') {
                    coloredBubble.style.position = 'relative';
                }

                const tsRect = timeStampContainer.getBoundingClientRect();
                const bubbleRect = coloredBubble.getBoundingClientRect();

                const topOffset = tsRect.top - bubbleRect.top;
                const rightOffset = bubbleRect.right - tsRect.right;

                timeStampContainer.style.position = 'absolute';
                timeStampContainer.style.top = topOffset + 'px';
                timeStampContainer.style.right = rightOffset + 'px';
                timeStampContainer.style.bottom = 'auto';
                timeStampContainer.style.left = 'auto';
                timeStampContainer.style.margin = '0';
                timeStampContainer.dataset.anchored = "true";
            }

            // --- TRANSCRIBER WRAPPER ---
            const btnWrapper = document.createElement('div');
            btnWrapper.className = 'wa-transcribe-wrapper';
            Object.assign(btnWrapper.style, {
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                marginTop: '26px',
                paddingTop: '8px',
                borderTop: isOut ? '1px solid rgba(255, 255, 255, 0.15)' : '1px solid rgba(255, 255, 255, 0.05)',
                clear: 'both'
            });

            // Flex container for the buttons
            const buttonGroup = document.createElement('div');
            Object.assign(buttonGroup.style, {
                display: 'flex',
                gap: '8px',
                width: '100%'
            });

            // --- COPY BUTTON ---
            const copyBtn = document.createElement('button');
            copyBtn.className = 'wa-copy-btn';
            copyBtn.innerHTML = '📋 Copy';
            Object.assign(copyBtn.style, {
                padding: '6px 12px',
                color: 'white',
                backgroundColor: '#404a4e',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 'bold',
                flex: '1',
                display: 'none',
                textAlign: 'center',
                transition: 'background-color 0.2s'
            });

            // --- MAIN BUTTON ---
            const btn = document.createElement('button');
            btn.className = 'wa-transcribe-btn';
            Object.assign(btn.style, {
                padding: '6px 12px',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 'bold',
                flex: '2',
                boxSizing: 'border-box',
                textAlign: 'center',
                transition: 'background-color 0.2s'
            });

            setBtnState(btn, 'idle', isOut);

            btn.onclick = () => {
                if (btn.dataset.state === 'close' || btn.dataset.state === 'error') {
                    const textDiv = btnWrapper.querySelector('.wa-transcript-text');
                    if (textDiv) textDiv.remove();
                    setBtnState(btn, 'idle', isOut);
                    copyBtn.style.display = 'none';
                } else if (btn.dataset.state === 'idle') {
                    // Check for API key before starting download/API call
                    const currentKey = checkAndGetApiKey();
                    if (currentKey && currentKey.trim() !== '') {
                        startDownloadTrick(messageContainer, coloredBubble, btnWrapper, btn, isOut);
                    } else {
                        showError(btn, btnWrapper, "Missing API Key", isOut);
                    }
                }
            };

            buttonGroup.appendChild(copyBtn);
            buttonGroup.appendChild(btn);
            btnWrapper.appendChild(buttonGroup);
            coloredBubble.appendChild(btnWrapper);
        });
    }

    function startDownloadTrick(messageContainer, coloredBubble, btnWrapper, btn, isOut) {
        setBtnState(btn, 'menu', isOut);
        currentSession = { btnWrapper: btnWrapper, btn: btn, isOut: isOut };
        unsafeWindow.__transcriberTrapArmed = true;

        const playBtn = messageContainer.querySelector('button[aria-label="Play voice message"], button[aria-label="Pause voice message"]');
        const targetElement = playBtn || coloredBubble;
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
            const downloadBtn = document.querySelector('[aria-label="Download"][role="menuitem"]');

            if (downloadBtn) {
                clearInterval(findMenuInterval);
                setBtnState(btn, 'download', isOut);
                downloadBtn.click();
            } else if (attempts > 40) {
                clearInterval(findMenuInterval);
                showError(btn, btnWrapper, "Menu error", isOut);
                document.body.click();
                unsafeWindow.__transcriberTrapArmed = false;
            }
        }, 50);

        setTimeout(() => {
            if (unsafeWindow.__transcriberTrapArmed === true) {
                unsafeWindow.__transcriberTrapArmed = false;
                if (currentSession && currentSession.btn === btn) {
                    showError(btn, btnWrapper, "Timeout", isOut);
                    document.body.click();
                    currentSession = null;
                }
            }
        }, 4000);
    }

    function sendToAPI(blob, btnWrapper, btn, isOut) {
        let textDiv = btnWrapper.querySelector('.wa-transcript-text');

        if (!textDiv) {
            textDiv = createTextContainer("...", isOut);
            btnWrapper.insertBefore(textDiv, btnWrapper.firstChild);
        }

        const formData = new FormData();
        formData.append('file', blob, 'voice_message.ogg');
        formData.append('model', 'whisper-large-v3');

        // --- NEW: Inject Language if specified ---
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
                    const resultText = JSON.parse(res.responseText).text;
                    textDiv.innerText = "🤖 " + resultText;
                    setBtnState(btn, 'close', isOut);

                    const copyBtn = btnWrapper.querySelector('.wa-copy-btn');
                    if (copyBtn) {
                        copyBtn.style.display = 'block';
                        copyBtn.onclick = () => {
                            navigator.clipboard.writeText(resultText).then(() => {
                                copyBtn.innerHTML = '✅ Copied!';
                                copyBtn.style.backgroundColor = '#144d37';
                                setTimeout(() => {
                                    copyBtn.innerHTML = '📋 Copy';
                                    copyBtn.style.backgroundColor = '#404a4e';
                                }, 2000);
                            });
                        };
                    }
                } else {
                    showError(btn, btnWrapper, `API Error ${res.status}`, isOut);
                }
            },
            onerror: function() {
                showError(btn, btnWrapper, "Offline", isOut);
            }
        });
    }

    function showError(btn, btnWrapper, msg, isOut) {
        setBtnState(btn, 'error', isOut);
        let textDiv = btnWrapper.querySelector('.wa-transcript-text');
        if (textDiv) textDiv.innerText = "🤖 ❌ " + msg;
    }

    function createTextContainer(text, isOut) {
        const div = document.createElement('div');
        div.className = 'wa-transcript-text';

        const bgColor = isOut ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.05)';

        Object.assign(div.style, {
            padding: '8px 12px',
            marginBottom: '8px',
            backgroundColor: bgColor,
            borderRadius: '8px',
            fontStyle: 'italic',
            fontSize: '14px',
            lineHeight: '1.4',
            color: 'var(--primary-text)',
            wordWrap: 'break-word',
            width: '100%',
            boxSizing: 'border-box'
        });
        div.innerText = text;
        return div;
    }

    // --- Performance Update: Throttling instead of Debouncing ---
    let isThrottled = false;
    const observer = new MutationObserver(() => {
        if (!isThrottled) {
            isThrottled = true;
            requestAnimationFrame(() => {
                findAndInjectButtons();
                setTimeout(() => { isThrottled = false; }, 100);
            });
        }
    });

    // --- Start Call ---
    setTimeout(() => {
        console.log("🚀 Voice Transcriber started.");

        // Initial API key check when the script loads for the first time
        setTimeout(checkAndGetApiKey, 1000);

        findAndInjectButtons();
        observer.observe(document.body, { childList: true, subtree: true });
    }, 1500);

})();
