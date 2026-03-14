// server.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// === 多 API Key 支持 ===
const apiKeys = process.env.API_KEYS ? process.env.API_KEYS.split(',') : [];
let keyIndex = 0;

// === Gemini Key 支持 ===
const geminiKeys = process.env.GEMINI_KEYS ? process.env.GEMINI_KEYS.split(',') : [];
let geminiKeyIndex = 0;

function getNextApiKey() {
  if (apiKeys.length === 0) return null;
  const key = apiKeys[keyIndex];
  keyIndex = (keyIndex + 1) % apiKeys.length;
  return key.trim();
}

function getNextGeminiKey() {
  if (geminiKeys.length === 0) return null;
  const key = geminiKeys[geminiKeyIndex];
  geminiKeyIndex = (geminiKeyIndex + 1) % geminiKeys.length;
  return key.trim();
}

// === API 代理路由 ===
app.post('/api/chat', async (req, res) => {
  console.log('Incoming request body:', req.body);

  // 判断 company 字段
  const company = req.body.company || 'openrouter';

  let apiKey, apiUrl, headers, body;

  if (company === 'google') {
    // Google Gemini
    apiKey = getNextGeminiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'No Gemini API key available' });
    }
    apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + req.body.model + ':generateContent?key=' + apiKey;
    headers = {
      'Content-Type': 'application/json'
    };
    // Gemini expects a different body format
    body = JSON.stringify({
      contents: req.body.messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }))
    });

    // Gemini does not support SSE streaming in the same way, so just proxy the response
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.error('Gemini proxy error:', err);
      return res.status(500).json({ error: 'Gemini proxy error' });
    }
  } else {
    // OpenRouter
    apiKey = getNextApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'No API key available' });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...req.body, stream: true }) // Ensure streaming is enabled
      });

      if (!response.ok || !response.body) {
        const data = await response.json();
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // Stream using Node.js streams
      response.body.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        lines.forEach(line => {
          if (line.trim()) {
            res.write(`data: ${line.trim()}\n\n`);
          }
        });
      });

      response.body.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });

      response.body.on('error', (err) => {
        console.error('Stream error:', err);
        res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

    } catch (err) {
      console.error('Proxy error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

// 可选：根路由返回简单消息
app.get('/', (req, res) => {
  res.send('OpenRouter/Google Gemini Proxy is running.');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
