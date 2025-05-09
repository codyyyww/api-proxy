const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// 代理转发 OpenRouter 的 /chat 请求
app.post('/api/chat', async (req, res) => {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Proxy error', details: err.message });
  }
});

// 测试环境变量是否读取成功
app.get('/test-env', (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  res.json({
    keyLoaded: !!key,
    startsWithSk: key?.startsWith('sk-'),
    preview: key?.slice(0, 8) || 'Not found'
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
