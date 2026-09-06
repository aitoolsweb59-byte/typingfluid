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

    // Which backend to use for this request. FluidType (index.html) does not
    // send this field, so it keeps using Groq exactly as before. FluidGhost
    // (ghost-race.html) explicitly sends provider: 'gemini' to use Google AI
    // Studio's free Gemini API instead. Everything else about this endpoint —
    // URL, request shape, response shape — is unchanged for both callers.
    const provider = body?.provider === 'gemini' ? 'gemini' : 'groq';

    if (provider === 'gemini') {
        return handleGemini(message, res);
    }
    return handleGroq(message, res);
}

async function handleGroq(message, res) {
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

async function handleGemini(message, res) {
    // Google AI Studio keys look like "AIza..." — filtering on that prefix
    // mirrors the gsk_ filter above and avoids accidentally trying to use a
    // Groq (or other) key against the Gemini endpoint.
    const keys = [
        process.env.GEMINI_KEY_1,
        process.env.GEMINI_API_KEY,
        process.env.GOOGLE_AI_API_KEY
    ].filter(k => k != null).map(k => k.trim()).filter(k => k.startsWith('AIza'));

    if (keys.length === 0) {
        console.error("Vercel did not find any variables starting with AIza (Google AI Studio key)");
        return res.status(500).json({ error: 'No API keys configured' });
    }

    const systemPrompt = 'You are a helpful assistant. Generate concise 2-3 sentence paragraphs suitable for typing practice. Keep it under 280 characters. Topic: ' + message;

    // gemini-3.1-flash-lite: GA (since May 2026) Gemini 3 tier model with a
    // free Google AI Studio tier and no announced shutdown date, unlike the
    // older Gemini 2.5 line (scheduled to be retired Oct 16 2026).
    const geminiModel = 'gemini-3.1-flash-lite';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;

    let lastErr = null;
    for (let i = 0; i < keys.length; i++) {
        try {
            const response = await fetch(geminiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': keys[i]
                },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents: [
                        { role: 'user', parts: [{ text: message }] }
                    ],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 300
                    }
                })
            });

            if (response.ok) {
                const data = await response.json();
                const aiText = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

                if (aiText) {
                    return res.status(200).json({ text: aiText });
                }

                // 200 OK but no usable text — e.g. blocked by safety filters
                // or the model hit maxOutputTokens with nothing emitted yet.
                // Treat as a soft failure and try the next key.
                const blockReason = data.promptFeedback?.blockReason;
                lastErr = blockReason ? `Blocked: ${blockReason}` : 'Model returned empty content';
                console.error(`Gemini key ${i + 1} returned 200 with empty content (${lastErr}), trying next key`);
                continue;
            }

            const errData = await response.json().catch(() => ({}));
            lastErr = errData.error?.message || `Gemini API Error: ${response.status}`;

            console.error(`Gemini key ${i + 1} failed with status ${response.status}:`, errData);

            if (response.status === 429 || response.status === 401 || response.status === 403) {
                continue;
            }

            return res.status(502).json({ error: lastErr });
        } catch (e) {
            console.error("Gemini network fetch failed:", e.message);
            lastErr = e.message;
        }
    }
    return res.status(502).json({ error: lastErr || 'All keys exhausted' });
                }
