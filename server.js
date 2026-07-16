const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// CORS for local file:// testing if needed
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/**
 * Grok proxy for LO + borrower calculators (and same pattern as coaching tools).
 * Deploy this service on Render with GROK_API_KEY set in the environment.
 * The browser only POSTs { model, messages, ... } — never a key.
 *
 * Production URL (current): https://ruofflorefinancecalculator.onrender.com/grok
 */
app.post('/grok', async (req, res) => {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GROK_API_KEY is not configured on the server'
    });
  }

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(req.body)
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: 'Invalid response from xAI', raw: text.slice(0, 500) });
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Grok proxy error:', err);
    res.status(500).json({ error: 'Failed to reach Grok API', message: err.message });
  }
});

app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/borrower', (req, res) => {
  res.sendFile(path.join(__dirname, 'borrower.html'));
});

const APP_VERSION = '3.2.1';
const APP_RELEASE_DATE = '2026-07-16';

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.GROK_API_KEY),
    version: APP_VERSION,
    releaseDate: APP_RELEASE_DATE
  });
});

app.listen(port, () => {
  console.log(`Ruoff calculator v${APP_VERSION} (${APP_RELEASE_DATE}) on http://localhost:${port}`);
  console.log(`  LO tool:       http://localhost:${port}/`);
  console.log(`  Borrower tool: http://localhost:${port}/borrower.html`);
  console.log(`  GROK_API_KEY:  ${process.env.GROK_API_KEY ? 'set' : 'NOT SET (AI features will use offline fallback)'}`);
});
