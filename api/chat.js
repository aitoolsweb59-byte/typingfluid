export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { message } = req.body;
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message required' });
    }

    const keys = [
        process.env.GROQ_KEY_1,
        process.env.GROQ_KEY_2,
        process.env.GROQ_KEY_3,
        process.env.GROQ_KEY_4,
        process.env.GROQ_KEY_5
    ].filter(k => k && k.startsWith('gsk_'));

    if (keys.length === 0) {
        return res.status(500).json({ error: 'No API keys configured' });
    }

    const systemPrompt = 'You are a helpful assistant. Generate concise 2-3 sentence paragraphs suitable for typing practice. Keep it under 280 characters. Topic: ' + message;
    const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
    const groqModel = 'llama3-8b-8192';

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
                lastErr = 'Key ' + (i + 1) + ' invalid';
                continue;
            }

            const errData = await response.json().catch(() => ({}));
            lastErr = errData.error?.message || 'API error';
            if (response.status === 429) continue;
            return res.status(502).json({ error: lastErr });
        } catch (e) {
            lastErr = e.message;
            if (i < keys.length - 1) continue;
        }
    }

    return res.status(502).json({ error: lastErr || 'All keys exhausted' });
}
