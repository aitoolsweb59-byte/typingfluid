export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Safely parse body if it arrives as a string
    let body = req.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON payload' });
        }
    }

    const message = body?.message;
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message required' });
    }

    // Collect all possible key variants and trim accidental whitespace/newlines
    const candidateKeys = [
        process.env.GROQ_API_KEY,
        process.env.GROQ_KEY,
        process.env.GROQ_KEY_1,
        process.env.GROQ_KEY_2,
        process.env.GROQ_KEY_3,
        process.env.GROQ_KEY_4,
        process.env.GROQ_KEY_5
    ];

    const keys = candidateKeys
        .map(k => (k ? k.trim() : ''))
        .filter(k => k && k.startsWith('gsk_'));

    if (keys.length === 0) {
        return res.status(500).json({ 
            error: 'No API keys found. Ensure GROQ_API_KEY or GROQ_KEY_1 is set in Vercel settings and the project is redeployed.' 
        });
    }

    const systemPrompt = 'You are a helpful assistant. Generate concise 2-3 sentence paragraphs suitable for typing practice. Keep it under 280 characters. Topic: ' + message;
    const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
    const groqModel = 'llama-3.1-8b-instant';

    let lastErr = null;
    for (let i = 0; i < keys.length; i++) {
        try {
            const response = await fetch(groqUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + keys[i]
                },
                body: JSON.stringify({
                    model: groqModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: message }
                    ],
                    temperature: 0.7,
                    max_tokens: 256
                })
            });

            if (response.ok) {
                const data = await response.json();
                const text = data.choices?.[0]?.message?.content || '';
                return res.status(200).json({ text });
            }

            if (response.status === 401 || response.status === 403) {
                lastErr = 'Key ' + (i + 1) + ' invalid or unauthorized';
                continue;
            }

            const errData = await response.json().catch(() => ({}));
            lastErr = errData.error?.message || `Groq API Error (${response.status})`;
            if (response.status === 429) continue; // Rate limit hit, try next key
            return res.status(502).json({ error: lastErr });
        } catch (e) {
            lastErr = e.message;
            if (i < keys.length - 1) continue;
        }
    }

    return res.status(502).json({ error: lastErr || 'All keys exhausted' });
}
