// server.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '30000', 10);

// Middlewares
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// CORS config (use ALLOWED_ORIGINS env var to restrict, comma-separated)
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow server-to-server or tools without origin
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS not allowed'));
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Load API keys (comma-separated in env)
const apiKeys = process.env.API_KEYS ? process.env.API_KEYS.split(',').map(k => k.trim()).filter(Boolean) : [];
let keyIndex = 0;
const geminiKeys = process.env.GEMINI_KEYS ? process.env.GEMINI_KEYS.split(',').map(k => k.trim()).filter(Boolean) : [];
let geminiKeyIndex = 0;

function getNextApiKey() {
  if (apiKeys.length === 0) return null;
  const k = apiKeys[keyIndex];
  keyIndex = (keyIndex + 1) % apiKeys.length;
  return k;
}
function getNextGeminiKey() {
  if (geminiKeys.length === 0) return null;
  const k = geminiKeys[geminiKeyIndex];
  geminiKeyIndex = (geminiKeyIndex + 1) % geminiKeys.length;
  return k;
}

// Simple fetch wrapper with timeout using AbortController (Node 18+)
async function proxyFetch(url, opts = {}, timeout = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  opts.signal = controller.signal;
  try {
    const r = await fetch(url, opts);
    clearTimeout(id);
    return r;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Normalizers: try multiple shapes so we get a consistent text result
function extractTextFromOpenRouter(data) {
  try {
    if (!data) return null;
    if (data.choices && data.choices.length > 0) {
      const first = data.choices[0];
      const msg = first.message;
      if (!msg) {
        // some variants may have text directly
        if (first.text) return first.text;
      } else {
        if (typeof msg === 'string') return msg;
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content?.parts)) return msg.content.parts.map(p => (p.text || '')).join('');
      }
    }
    if (typeof data.output === 'string') return data.output;
    if (Array.isArray(data.outputs)) return data.outputs.map(o => (o.text || o.content || '')).join('\n');
  } catch (e) { /* ignore */ }
  return null;
}
function extractTextFromGemini(data) {
  try {
    if (!data) return null;
    if (data.candidates && data.candidates.length > 0) {
      const c = data.candidates[0];
      const parts = c.content?.parts;
      if (Array.isArray(parts)) return parts.map(p => (p.text || '')).join('');
      if (typeof c.content?.text === 'string') return c.content.text;
    }
    if (typeof data.output === 'string') return data.output;
  } catch (e) { /* ignore */ }
  return null;
}

// POST /api/chat  — proxies and normalizes
app.post('/api/chat', async (req, res) => {
  const company = (req.body.company || 'openrouter').toLowerCase();
  const model = req.body.model || '';
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];

  // Basic validation
  if (!Array.isArray(messages)) {
    return res.status(400).json({ success: false, error: 'messages must be an array' });
  }

  try {
    if (company === 'google') {
      // Gemini
      const apiKey = getNextGeminiKey();
      if (!apiKey) return res.status(500).json({ success: false, error: 'No Gemini API key available' });

      const chosenModel = model || 'models/text-bison-001';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent?key=${apiKey}`;

      // Using a simple content mapping (works for many generic cases). Adapt if you need exact Gemini prompt schema.
      const body = {
        contents: messages.map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          parts: [{ text: m.content }]
        }))
      };

      const resp = await proxyFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, API_TIMEOUT_MS);

      let data;
      try { data = await resp.json(); } catch (e) { const t = await resp.text().catch(()=>null); data = { raw: t }; }

      const text = extractTextFromGemini(data) || extractTextFromOpenRouter(data) || '[No content]';

      return res.status(resp.ok ? 200 : 502).json({
        success: resp.ok,
        provider: 'google',
        model: chosenModel,
        choices: [{ message: { role: 'assistant', content: text } }],
        raw: data
      });
    } else {
      // OpenRouter (default)
      const apiKey = getNextApiKey();
      if (!apiKey) return res.status(500).json({ success: false, error: 'No OpenRouter API key available' });

      const url = 'https://openrouter.ai/api/v1/chat/completions';

      // Ensure we don't accidentally pass `stream: true`
      const payload = { ...req.body };
      delete payload.stream;

      const resp = await proxyFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      }, API_TIMEOUT_MS);

      let data;
      try { data = await resp.json(); } catch (e) { const t = await resp.text().catch(()=>null); data = { raw: t }; }

      const text = extractTextFromOpenRouter(data) || extractTextFromGemini(data) || '[No content]';

      return res.status(resp.ok ? 200 : 502).json({
        success: resp.ok,
        provider: 'openrouter',
        model,
        choices: [{ message: { role: 'assistant', content: text } }],
        raw: data
      });
    }
  } catch (err) {
    console.error('Proxy error:', err?.message || err);
    return res.status(500).json({ success: false, error: 'Internal server error', details: err?.message });
  }
});

// Simple /api/models route: tries OpenRouter models, falls back to a static list (Gemini)
app.get('/api/models', async (req, res) => {
  const company = (req.query.company || 'openrouter').toLowerCase();

  if (company === 'openrouter') {
    try {
      const resp = await proxyFetch('https://openrouter.ai/api/v1/models', { method: 'GET' }, 10000);
      const data = await (async () => { try { return await resp.json(); } catch (e) { return null; } })();
      if (data && Array.isArray(data.data)) {
        return res.json({ success: true, provider: 'openrouter', models: data.data });
      }
    } catch (e) {
      console.warn('OpenRouter model fetch failed:', e?.message || e);
    }
  }

  // Fallback (Gemini-style list)
  const fallback = [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    // add more if you want
  ];
  return res.json({ success: true, provider: 'fallback', models: fallback });
});

app.get('/', (req, res) => res.send('OpenRouter / Gemini proxy is running (non-streaming & normalized).'));

app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
