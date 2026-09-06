export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } 
        catch (e) { return res.status(400).json({ error: 'Invalid JSON payload' }); }
    }

    const message = body?.message;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const systemPrompt = 'You are a helpful assistant. Generate concise 2-3 sentence paragraphs suitable for typing practice. Keep it under 280 characters. Topic: ' + message;
    let lastErr = null;

    // 1. Primary: Google AI Studio (Gemini 1.5 Flash)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
        try {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
            const geminiRes = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ parts: [{ text: message }] }],
                    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
                })
            });

            if (geminiRes.ok) {
                const data = await geminiRes.json();
                const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (aiText) return res.status(200).json({ text: aiText });
            } else {
                const errData = await geminiRes.json().catch(() => ({}));
                console.error("Gemini failed, falling back to Groq:", errData);
            }
        } catch (e) {
            console.error("Gemini network fetch failed:", e.message);
        }
    }

    // 2. Fallback: Groq API
    const groqKeys = [process.env.GROQ_KEY_1, process.env.GROQ_API_KEY].filter(k => k != null).map(k => k.trim()).filter(k => k.startsWith('gsk_'));
    const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
    const groqModel = 'qwen/qwen3.6-27b';

    for (let i = 0; i < groqKeys.length; i++) {
        try {
            const response = await fetch(groqUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + groqKeys[i]
                },
                body: JSON.stringify({
                    model: groqModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: message }
                    ],
                    temperature: 0.7,
                    max_tokens: 1024,
                    reasoning_effort: 'none',
                    reasoning_format: 'hidden'
                })
            });

            if (response.ok) {
                const data = await response.json();
                const aiText = (data.choices?.[0]?.message?.content || "").trim();
                if (aiText) return res.status(200).json({ text: aiText });
                lastErr = 'Model returned empty content';
                continue;
            }

            const errData = await response.json().catch(() => ({}));
            lastErr = errData.error?.message || `Groq API Error: ${response.status}`;
            if (response.status === 429 || response.status === 401 || response.status === 403) continue;
            
            return res.status(502).json({ error: lastErr });
        } catch (e) {
            lastErr = e.message;
        }
    }

    return res.status(502).json({ error: lastErr || 'All API keys exhausted' });
}
