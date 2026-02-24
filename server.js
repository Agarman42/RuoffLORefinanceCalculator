const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

app.post('/grok', async (req, res) => {
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      throw new Error(`xAI API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reach Grok API' });
  }
});

const port = process.env.PORT || 3000;
// Add at bottom of server.js (before app.listen)
app.use(express.static('.'));  // serves index.html from root
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.listen(port, () => console.log(`Proxy running on port ${port}`));
