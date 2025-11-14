# Stock Divergence Analyzer

A Cloudflare Worker that identifies stocks trading below their fundamental value using free data sources. This tool systematically finds "AKBA-like" opportunities where price action diverges from strong fundamentals.

## Features

- **100% Free Data Sources**
  - Yahoo Finance: Price, valuation metrics, historical data
  - SEC EDGAR: Institutional ownership data
  - No API keys required for basic functionality

- **Smart Divergence Scoring**
  - Analyzes valuation metrics (EV/Revenue, P/E, P/S, P/B)
  - Tracks 90-day price action
  - Monitors institutional ownership changes
  - Generates 0-100 divergence score

- **Fast & Cached**
  - 1-hour intelligent caching
  - Parallel data fetching
  - Edge computing via Cloudflare

- **Multiple Analysis Modes**
  - Single stock analysis
  - Batch processing (up to 50 stocks)
  - RESTful API

## Quick Start

### Prerequisites

```bash
npm install -g wrangler
```

### Installation

```bash
# Clone and install
npm install

# Login to Cloudflare
wrangler login

# Deploy
npm run deploy
```

### Local Development

```bash
npm run dev
```

## API Usage

### Analyze Single Stock

```bash
GET /analyze?symbol=AKBA
```

**Response:**
```json
{
  "symbol": "AKBA",
  "timestamp": "2025-01-15T10:30:00Z",
  "processingTime": 1234,
  "data": {
    "price": {
      "current": 12.45,
      "change90d": -5.32,
      "change90dPct": -29.95
    },
    "valuation": {
      "marketCap": 450000000,
      "enterpriseValue": 420000000,
      "evToRevenue": 1.8,
      "peRatio": 8.5,
      "priceToSales": 2.1,
      "priceToBook": 1.2
    },
    "institutional": {
      "ownership": 45.2,
      "quarterlyChange": 8.3,
      "topHolders": []
    }
  },
  "divergenceScore": 75,
  "signals": [
    {
      "type": "STRONG_BUY",
      "reason": "High divergence score indicates significant undervaluation"
    },
    {
      "type": "VALUE",
      "reason": "EV/Revenue of 1.80 indicates deep value"
    },
    {
      "type": "MOMENTUM",
      "reason": "Price down 30.0% in 90 days"
    }
  ]
}
```

### Batch Analysis

```bash
POST /batch
Content-Type: application/json

{
  "symbols": ["AKBA", "AAPL", "MSFT", "GOOGL"]
}
```

**Response:**
```json
{
  "total": 4,
  "successful": 4,
  "failed": 0,
  "results": [
    {
      "symbol": "AKBA",
      "status": "fulfilled",
      "data": { ... }
    },
    ...
  ]
}
```

## Divergence Score Breakdown

The divergence score (0-100) is calculated from three components:

### 1. Valuation (40 points)
- **EV/Revenue ratio:**
  - < 2: 20 points (Deep value)
  - < 4: 15 points (Good value)
  - < 6: 10 points (Fair value)
  - < 10: 5 points (Moderate value)

- **P/E ratio:**
  - < 10: 20 points (Very cheap)
  - < 15: 15 points (Cheap)
  - < 20: 10 points (Fair)
  - < 30: 5 points (Reasonable)

### 2. Price Action (30 points)
- **90-day price change:**
  - Down >30%: 30 points (Maximum divergence)
  - Down 20-30%: 25 points (High divergence)
  - Down 10-20%: 20 points (Moderate divergence)
  - Down 0-10%: 10 points (Low divergence)

### 3. Institutional Activity (30 points)
- **Quarterly ownership change:**
  - +10% or more: 30 points (Strong buying)
  - +5% to +10%: 20 points (Moderate buying)
  - 0% to +5%: 10 points (Slight buying)

## Signal Types

- **STRONG_BUY (Score ≥70)**: Significant undervaluation detected
- **BUY (Score 50-69)**: Moderate opportunity present
- **WATCH (Score 30-49)**: Some divergence, monitor for entry
- **VALUE**: Low EV/Revenue indicates deep value
- **MOMENTUM**: Significant recent price decline

## Data Sources

### Yahoo Finance
- **Endpoint**: `query2.finance.yahoo.com`
- **Cost**: Free
- **Rate Limit**: None (use responsibly)
- **Data**: Price, market cap, valuation ratios, historical prices

### SEC EDGAR
- **Endpoint**: `data.sec.gov`
- **Cost**: Free
- **Rate Limit**: 10 requests/second
- **Data**: Institutional ownership, 13F filings

## Configuration

### Wrangler Configuration

Edit `wrangler.toml`:

```toml
name = "stock-divergence-analyzer"
main = "src/index.js"
compatibility_date = "2024-01-01"

# Optional: Add KV namespace for caching
[[kv_namespaces]]
binding = "CACHE"
id = "your-kv-namespace-id"
```

### Create KV Namespace (Optional)

```bash
wrangler kv:namespace create "CACHE"
wrangler kv:namespace create "CACHE" --preview
```

Then add the IDs to `wrangler.toml`.

## Caching Strategy

- **Duration**: 1 hour per symbol
- **Storage**: Cloudflare KV (optional)
- **Invalidation**: Automatic TTL-based
- **Benefits**: Reduced API calls, faster responses

## Example Use Cases

### 1. Screen for Undervalued Stocks

```javascript
const watchlist = ['AKBA', 'XYZ', 'ABC', 'DEF'];

const response = await fetch('https://your-worker.workers.dev/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbols: watchlist })
});

const data = await response.json();

// Filter high-score opportunities
const opportunities = data.results
  .filter(r => r.status === 'fulfilled')
  .filter(r => r.data.divergenceScore >= 60)
  .sort((a, b) => b.data.divergenceScore - a.data.divergenceScore);

console.log('Top opportunities:', opportunities);
```

### 2. Monitor Single Stock

```javascript
const checkStock = async (symbol) => {
  const response = await fetch(`https://your-worker.workers.dev/analyze?symbol=${symbol}`);
  const data = await response.json();

  if (data.divergenceScore >= 70) {
    console.log(`🚨 Strong buy signal for ${symbol}`);
    console.log(`Score: ${data.divergenceScore}`);
    console.log(`Signals:`, data.signals);
  }

  return data;
};

checkStock('AKBA');
```

### 3. Build a Screener Dashboard

```html
<!DOCTYPE html>
<html>
<head>
  <title>Stock Screener</title>
</head>
<body>
  <input type="text" id="symbol" placeholder="Enter symbol">
  <button onclick="analyze()">Analyze</button>
  <div id="results"></div>

  <script>
    async function analyze() {
      const symbol = document.getElementById('symbol').value;
      const response = await fetch(`https://your-worker.workers.dev/analyze?symbol=${symbol}`);
      const data = await response.json();

      document.getElementById('results').innerHTML = `
        <h2>${data.symbol}</h2>
        <p>Score: ${data.divergenceScore}/100</p>
        <p>Current Price: $${data.data.price.current}</p>
        <p>EV/Revenue: ${data.data.valuation.evToRevenue?.toFixed(2)}</p>
        <h3>Signals:</h3>
        <ul>
          ${data.signals.map(s => `<li>${s.type}: ${s.reason}</li>`).join('')}
        </ul>
      `;
    }
  </script>
</body>
</html>
```

## Limitations

1. **SEC Data**: Institutional ownership data is simplified. Production use would require parsing actual 13F-HR XML filings.

2. **Rate Limits**: Yahoo Finance doesn't publish official limits. Use responsibly with caching.

3. **Data Accuracy**: Free data sources may have delays or occasional inaccuracies.

4. **Not Financial Advice**: This tool is for educational and research purposes only.

## Upgrade Path

When the free tier proves the model, consider upgrading to:

- **IEX Cloud** ($9/month): Better reliability, official API
- **Financial Modeling Prep** ($14/month): Enhanced fundamentals
- **Alpha Vantage Premium** ($49/month): Higher rate limits

## Development

### Project Structure

```
.
├── src/
│   └── index.js         # Main worker code
├── wrangler.toml        # Cloudflare configuration
├── package.json         # Dependencies
└── README.md           # Documentation
```

### Testing Locally

```bash
# Start dev server
npm run dev

# Test single stock
curl "http://localhost:8787/analyze?symbol=AKBA"

# Test batch
curl -X POST http://localhost:8787/batch \
  -H "Content-Type: application/json" \
  -d '{"symbols": ["AKBA", "AAPL"]}'
```

### Deploy to Production

```bash
# Deploy to default environment
npm run deploy

# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy:production
```

## Contributing

This is a research project. Contributions welcome!

## License

MIT

## Disclaimer

This tool is for educational and research purposes only. Not financial advice. Always do your own research and consult with financial professionals before making investment decisions.
