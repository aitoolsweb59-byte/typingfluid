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

    const message = body?.message?.trim();
    if (!message) {
        return res.status(400).json({ error: 'Message required' });
    }

    const systemPrompt =
        'You are a typing practice assistant for FluidType. Generate a single concise, engaging 2 to 3 sentence paragraph suitable for typing practice about the requested topic. Output plain text only without markdown, bullet points, titles, or quotation marks. Keep it under 280 characters. Topic: ' +
        message;

    let lastErr = null;

    // Helper to clean any model output (strips <think> tags, markdown, and extra whitespace)
    function cleanModelText(raw) {
        if (!raw) return '';
        return raw
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/[*_#`~>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 1. Primary By Default: Groq Free API (keys starting with "gsk_")
    const groqKeys = [
        process.env.GROQ_API_KEY,
        process.env.GROQ_KEY_1,
        process.env.GROQ_KEY_2,
        process.env.GROQ_KEY
    ]
        .filter((k) => typeof k === 'string' && k.trim().length > 0)
        .map((k) => k.trim())
        .filter((k, idx, arr) => k.startsWith('gsk_') && arr.indexOf(k) === idx);

    // Active Groq Free Plan models in priority order:
    // - openai/gpt-oss-120b: Primary flagship production model on Groq Free Tier (replaces llama-3.3-70b-versatile)
    // - openai/gpt-oss-20b: Ultra-fast 1000 TPS production model on Groq Free Tier (replaces llama-3.1-8b-instant)
    // - qwen/qwen3.8-27b: Active free-tier general model
    // - llama-3.3-70b-versatile & llama-3.1-8b-instant: Retained as secondary fallbacks
    const groqModels = [
        { id: 'openai/gpt-oss-120b', extra: { include_reasoning: false, reasoning_effort: 'low' } },
        { id: 'openai/gpt-oss-20b', extra: { include_reasoning: false, reasoning_effort: 'low' } },
        { id: 'qwen/qwen3.8-27b', extra: { reasoning_format: 'hidden', reasoning_effort: 'none' } },
        { id: 'llama-3.3-70b-versatile', extra: {} },
        { id: 'llama-3.1-8b-instant', extra: {} }
    ];

    const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';

    if (groqKeys.length > 0) {
        for (const apiKey of groqKeys) {
            for (const modelConfig of groqModels) {
                try {
                    const response = await fetch(groqUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        },
                        body: JSON.stringify({
                            model: modelConfig.id,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: `Write a short typing practice paragraph about: ${message}` }
                            ],
                            temperature: 0.65,
                            max_completion_tokens: 300,
                            ...modelConfig.extra
                        })
                    });

                    if (response.ok) {
                        const data = await response.json();
                        const aiText = cleanModelText(data.choices?.[0]?.message?.content);
                        if (aiText) {
                            return res.status(200).json({
                                text: aiText,
                                provider: 'groq',
                                model: modelConfig.id
                            });
                        }
                        lastErr = 'Groq model returned empty content';
                        continue;
                    }

                    const errData = await response.json().catch(() => ({}));
                    lastErr = errData.error?.message || `Groq API Error (${modelConfig.id}): ${response.status}`;

                    // If unauthorized/invalid key, break inner model loop and try next key
                    if (response.status === 401 || response.status === 403) {
                        break;
                    }
                    // If rate-limited (429) or model unavailable/deprecated (400/404), try next Groq model
                    continue;
                } catch (e) {
                    lastErr = e.message;
                }
            }
        }
    } else {
        lastErr = 'GROQ_API_KEY (gsk_...) is not configured';
    }

    // 2. Secondary Fallback: Google AI Studio (Gemini API)
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    const geminiModels = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-2.0-flash'];

    if (geminiKey) {
        for (const geminiModel of geminiModels) {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;
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
                    const aiText = cleanModelText(data.candidates?.[0]?.content?.parts?.[0]?.text);
                    if (aiText) {
                        return res.status(200).json({
                            text: aiText,
                            provider: 'gemini',
                            model: geminiModel
                        });
                    }
                } else {
                    const errData = await geminiRes.json().catch(() => ({}));
                    lastErr = errData.error?.message || `Gemini API Error (${geminiModel}): ${geminiRes.status}`;
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
