
function cleanModelText(raw) {
    if (!raw) return '';
    const fenceRegex = new RegExp('\\x60{3}[\\s\\S]*?\\x60{3}', 'g');
    const inlineTickRegex = new RegExp('[\\x60*_#>~]', 'g');
    return String(raw)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(fenceRegex, '')
        .replace(inlineTickRegex, '')
        .replace(/[—–]/g, '-')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeKey(rawVal) {
    if (typeof rawVal !== 'string') return '';
    return rawVal
        .replace(/^["']|["']$/g, '')
        .replace(/^Bearer\s+/i, '')
        .trim();
}

function extractKeysFromEnv(envObj, prefixRegex, explicitNames) {
    const found = [];
    if (!envObj || typeof envObj !== 'object') return found;

    if (Array.isArray(explicitNames)) {
        for (let i = 0; i < explicitNames.length; i++) {
            const kName = explicitNames[i];
            const cleaned = normalizeKey(envObj[kName]);
            if (cleaned && cleaned.length > 10 && found.indexOf(cleaned) === -1) {
                if (!prefixRegex || prefixRegex.test(cleaned)) {
                    found.push(cleaned);
                }
                if (prefixRegex) prefixRegex.lastIndex = 0;
            }
        }
    }

    const values = Object.values(envObj);
    for (let i = 0; i < values.length; i++) {
        const val = values[i];
        if (typeof val === 'string' && val.length > 10) {
            if (prefixRegex) {
                prefixRegex.lastIndex = 0;
                const matches = val.match(prefixRegex);
                if (matches) {
                    for (let m = 0; m < matches.length; m++) {
                        const key = matches[m].trim();
                        if (key && found.indexOf(key) === -1) {
                            found.push(key);
                        }
                    }
                }
            }
        }
    }
    return found;
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
        controller.abort();
    }, timeoutMs);
    try {
        const opts = Object.assign({}, options, { signal: controller.signal });
        return await fetch(url, opts);
    } finally {
        clearTimeout(timer);
    }
}

function isGroqChatModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    const lower = modelId.toLowerCase();
    // Exclude audio, speech, guard, moderation, and embedding models
    const excluded = [
        'whisper',
        'tts',
        'playai',
        'guard',
        'orpheus',
        'embed',
        'moderation',
        'distil-whisper'
    ];
    for (let i = 0; i < excluded.length; i++) {
        if (lower.indexOf(excluded[i]) !== -1) return false;
    }
    return true;
}

async function getAvailableGroqModels(apiKey) {
    // Priority order of current 2026 Groq production & preview chat models
    const preferredOrder = [
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'qwen/qwen3-32b',
        'meta-llama/llama-4-scout-17b-16e-instruct',
        'meta-llama/llama-4-maverick-17b-128e-instruct',
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant'
    ];

    try {
        const res = await fetchWithTimeout(
            'https://api.groq.com/openai/v1/models',
            {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + apiKey }
            },
            2000
        );

        if (res.ok) {
            const data = await res.json();
            const list = data && Array.isArray(data.data) ? data.data : [];
            const activeIds = [];
            for (let i = 0; i < list.length; i++) {
                const item = list[i];
                if (item && item.id && item.active !== false && isGroqChatModel(item.id)) {
                    activeIds.push(item.id);
                }
            }

            if (activeIds.length > 0) {
                // Sort activeIds so preferred chat models are tried first, followed by any other active chat model on the account
                const ordered = [];
                for (let p = 0; p < preferredOrder.length; p++) {
                    if (activeIds.indexOf(preferredOrder[p]) !== -1) {
                        ordered.push(preferredOrder[p]);
                    }
                }
                for (let a = 0; a < activeIds.length; a++) {
                    if (ordered.indexOf(activeIds[a]) === -1) {
                        ordered.push(activeIds[a]);
                    }
                }
                return ordered.slice(0, 4);
            }
        }
    } catch (e) {
        // Ignore model list fetch failure and fall back to preferredOrder
    }

    return preferredOrder.slice(0, 4);
}

export default async function handler(req, res) {
    const fnStart = Date.now();
    // Strict 8.2-second ceiling so Vercel Hobby (10s limit) NEVER hits HTTP 504 Gateway Timeout
    function timeRemainingMs() {
        return Math.max(0, 8200 - (Date.now() - fnStart));
    }

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    let body = req.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON payload' });
        }
    }

    const message = body && body.message ? String(body.message).trim() : '';
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const systemPrompt =
        'You are FluidType AI, a helpful and knowledgeable assistant. Directly and accurately answer the user question or explain the requested topic in a clear, engaging 2 to 4 sentence paragraph (under 280 characters). Output plain English text only without markdown, bullet points, or special symbols so the user gets a direct answer they can also practice typing.';

    const errors = [];
    const envObj = process.env || {};

    // =========================================================================
    // 1. Primary Provider: Groq Free API
    // Dynamically queries /openai/v1/models first so it only calls models
    // your GROQ_API_KEY actually has access to (like openai/gpt-oss-120b, qwen3, llama-4, etc.)
    // =========================================================================
    const groqKeys = extractKeysFromEnv(
        envObj,
        /gsk_[A-Za-z0-9_-]{20,}/g,
        ['GROQ_API_KEY', 'GROQ_KEY', 'GROQ_KEY_1', 'GROQ_KEY_2', 'NEXT_PUBLIC_GROQ_API_KEY']
    );

    const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';

    if (groqKeys.length > 0) {
        for (let k = 0; k < groqKeys.length; k++) {
            if (timeRemainingMs() < 1500) break;
            const apiKey = groqKeys[k];
            const groqModels = await getAvailableGroqModels(apiKey);

            for (let m = 0; m < groqModels.length; m++) {
                const rem = timeRemainingMs();
                if (rem < 1200) break;
                const modelName = groqModels[m];

                try {
                    const response = await fetchWithTimeout(
                        groqUrl,
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + apiKey
                            },
                            body: JSON.stringify({
                                model: modelName,
                                messages: [
                                    { role: 'system', content: systemPrompt },
                                    { role: 'user', content: message }
                                ],
                                temperature: 0.7,
                                max_tokens: 300
                            })
                        },
                        Math.min(3200, rem)
                    );

                    if (response.ok) {
                        const data = await response.json();
                        const content =
                            data &&
                            data.choices &&
                            data.choices[0] &&
                            data.choices[0].message &&
                            data.choices[0].message.content
                                ? data.choices[0].message.content
                                : '';
                        const aiText = cleanModelText(content);
                        if (aiText) {
                            return res.status(200).json({
                                text: aiText,
                                provider: 'groq',
                                model: modelName
                            });
                        }
                        errors.push('Groq (' + modelName + '): Empty response');
                        continue;
                    }

                    const errData = await response.json().catch(function () {
                        return {};
                    });
                    const errMsg =
                        (errData && errData.error && errData.error.message) ||
                        'HTTP ' + response.status;
                    errors.push('Groq (' + modelName + '): ' + errMsg);

                    if (response.status === 401) {
                        break;
                    }
                } catch (e) {
                    errors.push('Groq (' + modelName + '): ' + (e && e.name === 'AbortError' ? 'Timed out' : (e && e.message ? e.message : 'Network error')));
                }
            }
        }
    } else {
        errors.push('GROQ_API_KEY not found in Vercel');
    }

    // =========================================================================
    // 2. Secondary Provider: Google Gemini API
    // =========================================================================
    const geminiKeys = extractKeysFromEnv(
        envObj,
        /AIza[A-Za-z0-9_-]{20,}/g,
        ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY', 'GEMINI_KEY_1', 'NEXT_PUBLIC_GEMINI_API_KEY']
    );

    const geminiModels = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash'
    ];

    if (geminiKeys.length > 0 && timeRemainingMs() >= 1500) {
        for (let k = 0; k < geminiKeys.length; k++) {
            const geminiKey = geminiKeys[k];
            for (let g = 0; g < geminiModels.length; g++) {
                const rem = timeRemainingMs();
                if (rem < 1200) break;
                const gModel = geminiModels[g];

                try {
                    const geminiUrl =
                        'https://generativelanguage.googleapis.com/v1beta/models/' +
                        gModel +
                        ':generateContent?key=' +
                        encodeURIComponent(geminiKey);

                    const geminiRes = await fetchWithTimeout(
                        geminiUrl,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [
                                    {
                                        role: 'user',
                                        parts: [{ text: systemPrompt + '\n\nUser Question: ' + message }]
                                    }
                                ],
                                generationConfig: {
                                    temperature: 0.7,
                                    maxOutputTokens: 800
                                }
                            })
                        },
                        Math.min(3200, rem)
                    );

                    if (geminiRes.ok) {
                        const data = await geminiRes.json();
                        const parts =
                            data &&
                            data.candidates &&
                            data.candidates[0] &&
                            data.candidates[0].content &&
                            Array.isArray(data.candidates[0].content.parts)
                                ? data.candidates[0].content.parts
                                : [];

                        const textChunks = [];
                        for (let p = 0; p < parts.length; p++) {
                            const partObj = parts[p];
                            if (partObj && typeof partObj.text === 'string' && !partObj.thought) {
                                textChunks.push(partObj.text);
                            }
                        }

                        const aiText = cleanModelText(textChunks.join(' '));
                        if (aiText) {
                            return res.status(200).json({
                                text: aiText,
                                provider: 'gemini',
                                model: gModel
                            });
                        }
                        errors.push('Gemini (' + gModel + '): Empty response');
                    } else {
                        const errData = await geminiRes.json().catch(function () {
                            return {};
                        });
                        const errMsg =
                            (errData && errData.error && errData.error.message) ||
                            'HTTP ' + geminiRes.status;
                        errors.push('Gemini (' + gModel + '): ' + errMsg);

                        if (geminiRes.status === 400 && errMsg.toLowerCase().indexOf('api key not valid') !== -1) {
                            break;
                        }
                        if (geminiRes.status === 401 || geminiRes.status === 403) {
                            break;
                        }
                    }
                } catch (e) {
                    errors.push('Gemini (' + gModel + '): ' + (e && e.name === 'AbortError' ? 'Timed out' : (e && e.message ? e.message : 'Network error')));
                }
            }
        }
    }

    // =========================================================================
    // 3. Fast Keyless Live AI Backup (with strict timeout so 504 never happens)
    // =========================================================================
    const backupRem = timeRemainingMs();
    if (backupRem >= 1200) {
        try {
            const promptEncoded = encodeURIComponent(
                'Answer this question or topic clearly in 2 to 3 plain text sentences (under 260 characters, no markdown): ' + message
            );
            const backupRes = await fetchWithTimeout(
                'https://text.pollinations.ai/' + promptEncoded + '?model=openai',
                { method: 'GET' },
                Math.min(3000, backupRem)
            );

            if (backupRes.ok) {
                const rawBackup = await backupRes.text();
                const cleanedBackup = cleanModelText(rawBackup);
                if (cleanedBackup) {
                    return res.status(200).json({
                        text: cleanedBackup,
                        provider: 'live-ai-backup'
                    });
                }
            }
        } catch (e) {
            errors.push('Backup AI timed out');
        }
    }

    return res.status(502).json({
        error: errors.join(' | ') || 'AI request timed out. Please try again.'
    });
}
