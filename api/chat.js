export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON payload' });
        }
    }

    const message = body?.message;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const keys = [
        process.env.GROQ_KEY_1,
        process.env.GROQ_API_KEY
    ].filter(k => k != null).map(k => k.trim()).filter(k => k.startsWith('gsk_'));

    if (keys.length === 0) {
        console.error("Vercel did not find any variables starting with gsk_");
        return res.status(500).json({ error: 'No API keys configured' });
    }

    const systemPrompt = 'You are a helpful assistant. Generate concise 2-3 sentence paragraphs suitable for typing practice. Keep it under 280 characters. Topic: ' + message;
    const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';

    // Confirmed current/active model on Groq (as of Aug 2026).
    const groqModel = 'qwen/qwen3.6-27b';

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
                    max_tokens: 1024,
                    // Root cause of the empty-response bug: Qwen 3.6 defaults to
                    // "thinking mode" (reasoning_effort: "default") when this is
                    // omitted. In thinking mode it can burn the entire max_tokens
                    // budget on hidden reasoning and emit zero visible output,
                    // which comes back as a 200 OK with content: "".
                    // "none" = non-thinking mode, the mode Groq recommends for
                    // short general-purpose text like these typing drills.
                    reasoning_effort: 'none',
                    reasoning_format: 'hidden' // extra safety net, in case reasoning leaks through
                })
            });

            if (response.ok) {
                const data = await response.json();
                const aiText = (data.choices?.[0]?.message?.content || "").trim();

                if (aiText) {
                    return res.status(200).json({ text: aiText });
                }

                // Still got 200 + empty content (shouldn't happen now, but just
                // in case) — treat as a soft failure and try the next key
                // instead of showing the user a fake "success" placeholder.
                lastErr = 'Model returned empty content';
                console.error(`Key ${i + 1} returned 200 with empty content, trying next key`);
                continue;
            }

            const errData = await response.json().catch(() => ({}));
            lastErr = errData.error?.message || `Groq API Error: ${response.status}`;

            console.error(`Key ${i + 1} failed with status ${response.status}:`, errData);

            if (response.status === 429 || response.status === 401 || response.status === 403) {
                continue;
            }

            return res.status(502).json({ error: lastErr });
        } catch (e) {
            console.error("Network fetch failed:", e.message);
            lastErr = e.message;
        }
    }
    return res.status(502).json({ error: lastErr || 'All keys exhausted' });
}
