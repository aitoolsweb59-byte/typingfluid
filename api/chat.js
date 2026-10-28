
const PREWRITTEN_TOPICS = {
    'black hole': 'A black hole is a region of spacetime where gravity is so intense that nothing, not even light, can escape its pull. The boundary of no return is called the event horizon, where time itself appears to slow down relative to distant observers.',
    'ai': 'Artificial intelligence transforms raw data into pattern recognition, enabling machines to learn, reason, and generate human-like text. Modern neural networks process billions of parameters in milliseconds to assist coders, scientists, and creators.',
    'science': 'The scientific method relies on curiosity, rigorous observation, and repeatable experimentation to uncover how nature works. Every disproven hypothesis brings humanity one step closer to understanding the fundamental laws of matter and energy.',
    'universe': 'The observable universe stretches roughly ninety-three billion light-years across and contains trillions of galaxies spiraling through cosmic webs. Every heavy atom in our bodies was forged inside the nuclear heart of an ancient dying star.',
    'quantum': 'Quantum mechanics reveals a subatomic realm where particles exist in superpositions of multiple states until measured. Entangled particles can correlate instantaneously across vast distances, defying classical intuitions about space and time.',
    'cybersecurity': 'Modern cybersecurity defends digital infrastructure through zero-trust architecture, end-to-end encryption, and continuous threat hunting. A single patched vulnerability can prevent cascading breaches across global cloud networks.'
};

function getFallbackParagraph(topic) {
    const lower = String(topic || '').toLowerCase();
    const keys = Object.keys(PREWRITTEN_TOPICS);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (lower.indexOf(key) !== -1) {
            return PREWRITTEN_TOPICS[key];
        }
    }
    const sanitizedTopic = String(topic || 'focused practice')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .trim()
        .slice(0, 45) || 'focused practice';
    return 'Mastering ' + sanitizedTopic + ' requires consistent daily curiosity, deep focus, and deliberate execution. Every keystroke sharpens your neural pathways and builds lasting precision as you race against your own personal best.';
}

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
        return res.status(400).json({ error: 'Message topic is required' });
    }

    const systemPrompt =
        'You are a typing drill generator for FluidType. Write a single, engaging 2 to 3 sentence paragraph about the requested topic suitable for typing practice. Output plain English text only: no markdown, no bullet points, no quotes around the paragraph, and keep it between 160 and 280 characters.';

    const errors = [];
    const envObj = process.env || {};
    const envEntries = Object.entries(envObj);

    // =========================================================================
    // 1. Collect Groq API Keys (Zero backticks used anywhere)
    // Recommended env variable name: GROQ_API_KEY
    // =========================================================================
    const rawGroqCandidates = [
        envObj.GROQ_API_KEY,
        envObj.NEXT_PUBLIC_GROQ_API_KEY,
        envObj.GROQ_KEY,
        envObj.GROQ_KEY_1,
        envObj.GROQ_KEY_2
    ];

    for (let i = 0; i < envEntries.length; i++) {
        const envName = String(envEntries[i][0] || '').toUpperCase();
        const envVal = envEntries[i][1];
        if (envName.indexOf('GROQ') !== -1 || (typeof envVal === 'string' && envVal.indexOf('gsk_') !== -1)) {
            rawGroqCandidates.push(envVal);
        }
    }

    const groqKeys = [];
    for (let i = 0; i < rawGroqCandidates.length; i++) {
        const cleaned = normalizeKey(rawGroqCandidates[i]);
        if (cleaned && cleaned.startsWith('gsk_') && groqKeys.indexOf(cleaned) === -1) {
            groqKeys.push(cleaned);
        }
    }

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
                                { role: 'user', content: 'Topic: ' + message }
                            ],
                            temperature: 0.7,
                            max_tokens: 250
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
                        if (aiText && aiText.length >= 20) {
                            return res.status(200).json({
                                text: aiText,
                                provider: 'groq',
                                model: modelName
                            });
                        }
                        errors.push('Groq (' + modelName + '): Returned empty text');
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
                    errors.push('Groq (' + modelName + '): ' + (e && e.message ? e.message : 'Request failed'));
                }
            }
        }
    } else {
        errors.push('No Groq API key found (set GROQ_API_KEY starting with gsk_)');
    }

    // =========================================================================
    // 2. Collect Google Gemini API Keys
    // Recommended env variable name: GEMINI_API_KEY
    // =========================================================================
    const rawGeminiCandidates = [
        envObj.GEMINI_API_KEY,
        envObj.GOOGLE_API_KEY,
        envObj.NEXT_PUBLIC_GEMINI_API_KEY,
        envObj.GEMINI_KEY,
        envObj.GEMINI_KEY_1
    ];

    for (let i = 0; i < envEntries.length; i++) {
        const envName = String(envEntries[i][0] || '').toUpperCase();
        const envVal = envEntries[i][1];
        if (
            envName.indexOf('GEMINI') !== -1 ||
            envName.indexOf('GOOGLE_API') !== -1 ||
            (typeof envVal === 'string' && envVal.indexOf('AIza') !== -1)
        ) {
            rawGeminiCandidates.push(envVal);
        }
    }

    const geminiKeys = [];
    for (let i = 0; i < rawGeminiCandidates.length; i++) {
        const cleaned = normalizeKey(rawGeminiCandidates[i]);
        if (cleaned && cleaned.startsWith('AIza') && geminiKeys.indexOf(cleaned) === -1) {
            geminiKeys.push(cleaned);
        }
    }

    const geminiModels = [
        'gemini-2.5-flash',
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
                                    parts: [{ text: systemPrompt + '\n\nTopic: ' + message }]
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
                        if (aiText && aiText.length >= 20) {
                            return res.status(200).json({
                                text: aiText,
                                provider: 'gemini',
                                model: gModel
                            });
                        }
                        errors.push('Gemini (' + gModel + '): Returned empty text');
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
                    errors.push('Gemini (' + gModel + '): ' + (e && e.message ? e.message : 'Request failed'));
                }
            }
        }
    } else {
        errors.push('No Gemini API key found (set GEMINI_API_KEY starting with AIza)');
    }

    // =========================================================================
    // 3. Resilient Fallback so the user's typing session never crashes
    // =========================================================================
    const fallbackText = getFallbackParagraph(message);
    return res.status(200).json({
        text: fallbackText,
        provider: 'fallback',
        warning: 'Used built-in topic generator because external API keys failed or were not configured.',
        diagnostics: errors
    });
}
