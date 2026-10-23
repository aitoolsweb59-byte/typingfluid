```javascript
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
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
        return res.status(400).json({ error: 'Message required' });
    }

    const systemPrompt =
        'You are a helpful assistant for FluidType. Generate a concise 2 to 3 sentence paragraph suitable for typing practice. Output plain text only without markdown or bullet points. Keep it under 280 characters. Topic: ' +
        message;

    let lastErr = null;

    function cleanModelText(raw) {
        if (!raw) return '';
        return String(raw)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/[*_#>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 1. Primary By Default: Groq Free API
    // Automatically detects GROQ_API_KEY, GROQ_KEY_1, or any Vercel env variable starting with "gsk_"
    const rawGroqCandidates = [
        process.env.GROQ_API_KEY,
        process.env.GROQ_KEY_1,
        process.env.GROQ_KEY_2,
        process.env.GROQ_KEY,
        ...Object.values(process.env || {})
    ];

    const groqKeys = [];
    for (let i = 0; i < rawGroqCandidates.length; i++) {
        const val = rawGroqCandidates[i];
        if (typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed.startsWith('gsk_') && groqKeys.indexOf(trimmed) === -1) {
                groqKeys.push(trimmed);
            }
        }
    }

    const groqModels = [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'qwen/qwen3.8-27b'
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
                        lastErr = 'Groq model returned empty content';
                        continue;
                    }

                    const errData = await response.json().catch(function () {
                        return {};
                    });
                    lastErr =
                        (errData && errData.error && errData.error.message) ||
                        'Groq API Error (' + modelName + '): ' + response.status;

                    if (response.status === 401 || response.status === 403) {
                        break;
                    }
                    continue;
                } catch (e) {
                    lastErr = e.message;
                }
            }
        }
    } else {
        lastErr = 'No Groq API key (starting with gsk_) found in Vercel Environment Variables';
    }

    // 2. Secondary Fallback: Google Gemini API
    const geminiKey = process.env.GEMINI_API_KEY ? String(process.env.GEMINI_API_KEY).trim() : '';
    const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.8-flash'];

    if (geminiKey) {
        for (let g = 0; g < geminiModels.length; g++) {
            const gModel = geminiModels[g];
            try {
                const geminiUrl =
                    'https://generativelanguage.googleapis.com/v1beta/models/' +
                    gModel +
                    ':generateContent?key=' +
                    geminiKey;
                const geminiRes = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        system_instruction: { parts: [{ text: systemPrompt }] },
                        contents: [{ parts: [{ text: message }] }],
                        generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
                    })
                });

                if (geminiRes.ok) {
                    const data = await geminiRes.json();
                    const rawText =
                        data &&
                        data.candidates &&
                        data.candidates[0] &&
                        data.candidates[0].content &&
                        data.candidates[0].content.parts &&
                        data.candidates[0].content.parts[0] &&
                        data.candidates[0].content.parts[0].text
                            ? data.candidates[0].content.parts[0].text
                            : '';
                    const aiText = cleanModelText(rawText);
                    if (aiText) {
                        return res.status(200).json({
                            text: aiText,
                            provider: 'gemini',
                            model: gModel
                        });
                    }
                } else {
                    const errData = await geminiRes.json().catch(function () {
                        return {};
                    });
                    lastErr =
                        (errData && errData.error && errData.error.message) ||
                        'Gemini API Error (' + gModel + '): ' + geminiRes.status;
                }
            } catch (e) {
                lastErr = e.message;
            }
        }
    }

    return res.status(502).json({
        error: lastErr || 'All Groq and Gemini API keys exhausted or not configured'
    });
}
```
