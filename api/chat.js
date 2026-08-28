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
                    max_tokens: 1024 
                })
            });

            if (response.ok) {
                const data = await response.json();
                let aiText = data.choices?.[0]?.message?.content || "";
                
                // THE FIX: This Regex strips out the messy <think> blocks and leaves only the final text
                aiText = aiText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
                
                if (!aiText) {
                    aiText = "Sorry, the AI generated an empty response. Let's try again.";
                }
                
                return res.status(200).json({ text: aiText });
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
