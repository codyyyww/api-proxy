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

function getNextApiKey() {
  if (apiKeys.length === 0) return null;
  const key = apiKeys[keyIndex];
  keyIndex = (keyIndex + 1) % apiKeys.length;
  return key.trim();
}

// === API 代理路由 ===
app.post('/api/chat', async (req, res) => {
  console.log('Incoming request body:', req.body);
  const apiKey = getNextApiKey();

  if (!apiKey) {
    return res.status(500).json({ error: 'No API key available' });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 可选：根路由返回简单消息
app.get('/', (req, res) => {
  res.send('OpenRouter Proxy is running.');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
