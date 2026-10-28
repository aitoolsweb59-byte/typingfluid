
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

function extractKeysFromEnv(envObj, prefixRegex) {
    const found = [];
    if (!envObj || typeof envObj !== 'object') return found;
    const values = Object.values(envObj);
    for (let i = 0; i < values.length; i++) {
        const val = values[i];
        if (typeof val === 'string' && val.length > 10) {
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
    return found;
}

export default async function handler(req, res) {
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
    // Automatically extracts any "gsk_..." key from GROQ_API_KEY or any Vercel env variable
    // =========================================================================
    const groqKeys = extractKeysFromEnv(envObj, /gsk_[A-Za-z0-9_-]{20,}/g);

    const groqModels = [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'gemma2-9b-it',
        'mixtral-8x7b-32768'
    ];

    const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';

    if (groqKeys.length > 0) {
        for (let k = 0; k < groqKeys.length; k++) {
            const apiKey = groqKeys[k];
            for (let m = 0; m < groqModels.length; m++) {
                const modelName = groqModels[m];
                try {
                    const response = await fetch(groqUrl, {
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
                    });

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

                    if (response.status === 401 || response.status === 403) {
                        break;
                    }
                } catch (e) {
                    errors.push('Groq (' + modelName + '): ' + (e && e.message ? e.message : 'Network error'));
                }
            }
        }
    } else {
        errors.push('GROQ_API_KEY (starting with gsk_) not found in Vercel Environment Variables');
    }

    // =========================================================================
    // 2. Secondary Provider: Google Gemini API
    // Automatically extracts any "AIza..." key from GEMINI_API_KEY or any Vercel env variable
    // =========================================================================
    const geminiKeys = extractKeysFromEnv(envObj, /AIza[A-Za-z0-9_-]{25,}/g);

    const geminiModels = [
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash',
        'gemini-1.5-flash'
    ];

    if (geminiKeys.length > 0) {
        for (let k = 0; k < geminiKeys.length; k++) {
            const geminiKey = geminiKeys[k];
            for (let g = 0; g < geminiModels.length; g++) {
                const gModel = geminiModels[g];
                try {
                    const geminiUrl =
                        'https://generativelanguage.googleapis.com/v1beta/models/' +
                        gModel +
                        ':generateContent?key=' +
                        encodeURIComponent(geminiKey);

                    const geminiRes = await fetch(geminiUrl, {
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
                                maxOutputTokens: 1024
                            }
                        })
                    });

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
                    errors.push('Gemini (' + gModel + '): ' + (e && e.message ? e.message : 'Network error'));
                }
            }
        }
    } else {
        errors.push('GEMINI_API_KEY (starting with AIza) not found in Vercel Environment Variables');
    }

    // =========================================================================
    // 3. Keyless Live AI Backup (Pollinations OpenAI-compatible endpoint)
    // Guarantees a real, dynamic AI answer to the user's exact question even if
    // Vercel env keys were not redeployed yet or hit rate limits!
    // =========================================================================
    try {
        const backupRes = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'openai',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: message }
                ],
                temperature: 0.7
            })
        });

        if (backupRes.ok) {
            const backupData = await backupRes.json();
            const backupContent =
                backupData &&
                backupData.choices &&
                backupData.choices[0] &&
                backupData.choices[0].message &&
                backupData.choices[0].message.content
                    ? backupData.choices[0].message.content
                    : '';
            const cleanedBackup = cleanModelText(backupContent);
            if (cleanedBackup) {
                return res.status(200).json({
                    text: cleanedBackup,
                    provider: 'live-ai-backup',
                    diagnostics: errors
                });
            }
        }
    } catch (e) {
        errors.push('Live AI backup error: ' + (e && e.message ? e.message : 'Failed'));
    }

    // =========================================================================
    // 4. If all providers fail, return 502 so the frontend refunds the credit
    // =========================================================================
    return res.status(502).json({
        error: errors.join(' | ') || 'All AI providers failed. Check GROQ_API_KEY and GEMINI_API_KEY in Vercel and Redeploy.'
    });
}
