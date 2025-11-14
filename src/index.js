/**
 * Stock Divergence Analyzer - Cloudflare Worker
 * Identifies stocks trading below fundamentals using free data sources
 */

// Cache duration in seconds
const CACHE_DURATION = 3600; // 1 hour

/**
 * Main Worker Entry Point
 */
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Route handling
      if (path === '/analyze' || path === '/analyze/') {
        const symbol = url.searchParams.get('symbol')?.toUpperCase();

        if (!symbol) {
          return jsonResponse({ error: 'Symbol parameter required' }, 400);
        }

        const cacheKey = `stock-data-${symbol}`;

        // Check cache first
        const cached = await getCache(cacheKey, env);
        if (cached) {
          return jsonResponse({ ...cached, cached: true });
        }

        // Fetch and analyze data
        const analysis = await analyzeStock(symbol);

        // Store in cache
        await setCache(cacheKey, analysis, CACHE_DURATION, env);

        return jsonResponse(analysis);
      }

      if (path === '/batch' || path === '/batch/') {
        return handleBatchAnalysis(request, env);
      }

      // Default route - API info
      return jsonResponse({
        name: 'Stock Divergence Analyzer API',
        version: '1.0.0',
        endpoints: {
          analyze: '/analyze?symbol=TICKER - Analyze single stock',
          batch: '/batch (POST) - Analyze multiple stocks'
        },
        dataSources: ['Yahoo Finance', 'SEC EDGAR', 'FINRA'],
        example: '/analyze?symbol=AKBA'
      });

    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({
        error: 'Internal server error',
        message: error.message
      }, 500);
    }
  }
};

/**
 * Analyze a single stock
 */
async function analyzeStock(symbol) {
  const startTime = Date.now();

  try {
    // Fetch all data in parallel
    const [priceData, institutionalData] = await Promise.all([
      getYahooData(symbol),
      getSECData(symbol).catch(err => {
        console.warn(`SEC data unavailable for ${symbol}:`, err.message);
        return null;
      })
    ]);

    // Calculate divergence score
    const score = calculateDivergenceScore(priceData, institutionalData);

    return {
      symbol,
      timestamp: new Date().toISOString(),
      processingTime: Date.now() - startTime,
      data: {
        price: {
          current: priceData.currentPrice,
          change90d: priceData.price90dChange,
          change90dPct: priceData.price90dChangePct
        },
        valuation: {
          marketCap: priceData.marketCap,
          enterpriseValue: priceData.enterpriseValue,
          evToRevenue: priceData.evToRevenue,
          peRatio: priceData.peRatio,
          priceToSales: priceData.priceToSales,
          priceToBook: priceData.priceToBook
        },
        institutional: institutionalData ? {
          ownership: institutionalData.ownershipPercent,
          quarterlyChange: institutionalData.quarterlyChange,
          topHolders: institutionalData.topHolders
        } : null
      },
      divergenceScore: score,
      signals: generateSignals(priceData, institutionalData, score)
    };

  } catch (error) {
    throw new Error(`Failed to analyze ${symbol}: ${error.message}`);
  }
}

/**
 * Fetch data from Yahoo Finance
 */
async function getYahooData(symbol) {
  try {
    // Fetch quote summary
    const summaryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=price,defaultKeyStatistics,financialData,summaryDetail`;
    const summaryResp = await fetch(summaryUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!summaryResp.ok) {
      throw new Error(`Yahoo Finance API error: ${summaryResp.status}`);
    }

    const summaryData = await summaryResp.json();
    const result = summaryData.quoteSummary?.result?.[0];

    if (!result) {
      throw new Error('Invalid symbol or no data available');
    }

    // Fetch historical prices for 90-day change
    const histUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=3mo&interval=1d`;
    const histResp = await fetch(histUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    let price90dChange = null;
    let price90dChangePct = null;

    if (histResp.ok) {
      const histData = await histResp.json();
      const prices = histData.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(p => p !== null);

      if (prices && prices.length >= 2) {
        const oldPrice = prices[0];
        const newPrice = prices[prices.length - 1];
        price90dChange = newPrice - oldPrice;
        price90dChangePct = (price90dChange / oldPrice) * 100;
      }
    }

    // Extract data with safe navigation
    const price = result.price || {};
    const stats = result.defaultKeyStatistics || {};
    const financials = result.financialData || {};
    const summary = result.summaryDetail || {};

    const currentPrice = price.regularMarketPrice?.raw || 0;
    const marketCap = price.marketCap?.raw || 0;
    const enterpriseValue = stats.enterpriseValue?.raw || financials.enterpriseValue?.raw || 0;
    const revenue = financials.totalRevenue?.raw || 0;
    const evToRevenue = revenue > 0 ? enterpriseValue / revenue : null;
    const peRatio = summary.trailingPE?.raw || null;
    const priceToSales = summary.priceToSalesTrailing12Months?.raw || null;
    const priceToBook = stats.priceToBook?.raw || null;

    return {
      currentPrice,
      marketCap,
      enterpriseValue,
      revenue,
      evToRevenue,
      peRatio,
      priceToSales,
      priceToBook,
      price90dChange,
      price90dChangePct
    };

  } catch (error) {
    throw new Error(`Yahoo Finance fetch failed: ${error.message}`);
  }
}

/**
 * Fetch institutional ownership from SEC
 */
async function getSECData(symbol) {
  try {
    // Get CIK (Central Index Key) for the symbol
    const tickerUrl = 'https://www.sec.gov/files/company_tickers.json';
    const tickerResp = await fetch(tickerUrl, {
      headers: {
        'User-Agent': 'Stock Analyzer research@example.com'
      }
    });

    if (!tickerResp.ok) {
      throw new Error('Failed to fetch ticker data');
    }

    const tickers = await tickerResp.json();
    const company = Object.values(tickers).find(
      t => t.ticker.toUpperCase() === symbol.toUpperCase()
    );

    if (!company) {
      return null; // Symbol not found in SEC database
    }

    const cik = String(company.cik_str).padStart(10, '0');

    // Fetch recent 13F filings
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const submissionsResp = await fetch(submissionsUrl, {
      headers: {
        'User-Agent': 'Stock Analyzer research@example.com'
      }
    });

    if (!submissionsResp.ok) {
      throw new Error('Failed to fetch SEC submissions');
    }

    const submissions = await submissionsResp.json();

    // Parse institutional ownership data (simplified)
    // In production, you'd parse actual 13F-HR filings
    return {
      cik,
      companyName: company.title,
      ownershipPercent: null, // Would need to parse 13F filings
      quarterlyChange: null,
      topHolders: []
    };

  } catch (error) {
    throw new Error(`SEC data fetch failed: ${error.message}`);
  }
}

/**
 * Calculate divergence score (0-100)
 * Higher score = more divergence (potentially undervalued)
 */
function calculateDivergenceScore(priceData, institutionalData) {
  let score = 0;
  const weights = {
    valuation: 40,
    priceAction: 30,
    institutional: 30
  };

  // Valuation component (40 points)
  if (priceData.evToRevenue !== null) {
    if (priceData.evToRevenue < 2) score += 20;
    else if (priceData.evToRevenue < 4) score += 15;
    else if (priceData.evToRevenue < 6) score += 10;
    else if (priceData.evToRevenue < 10) score += 5;
  }

  if (priceData.peRatio !== null) {
    if (priceData.peRatio < 10) score += 20;
    else if (priceData.peRatio < 15) score += 15;
    else if (priceData.peRatio < 20) score += 10;
    else if (priceData.peRatio < 30) score += 5;
  }

  // Price action component (30 points)
  if (priceData.price90dChangePct !== null) {
    if (priceData.price90dChangePct < -30) score += 30;
    else if (priceData.price90dChangePct < -20) score += 25;
    else if (priceData.price90dChangePct < -10) score += 20;
    else if (priceData.price90dChangePct < 0) score += 10;
    // Positive price action reduces divergence
  }

  // Institutional component (30 points)
  if (institutionalData?.quarterlyChange !== null) {
    if (institutionalData.quarterlyChange > 10) score += 30;
    else if (institutionalData.quarterlyChange > 5) score += 20;
    else if (institutionalData.quarterlyChange > 0) score += 10;
  }

  return Math.min(Math.round(score), 100);
}

/**
 * Generate trading signals
 */
function generateSignals(priceData, institutionalData, score) {
  const signals = [];

  if (score >= 70) {
    signals.push({
      type: 'STRONG_BUY',
      reason: 'High divergence score indicates significant undervaluation'
    });
  } else if (score >= 50) {
    signals.push({
      type: 'BUY',
      reason: 'Moderate divergence suggests potential opportunity'
    });
  } else if (score >= 30) {
    signals.push({
      type: 'WATCH',
      reason: 'Some divergence present, monitor for entry'
    });
  }

  if (priceData.evToRevenue !== null && priceData.evToRevenue < 2) {
    signals.push({
      type: 'VALUE',
      reason: `EV/Revenue of ${priceData.evToRevenue.toFixed(2)} indicates deep value`
    });
  }

  if (priceData.price90dChangePct !== null && priceData.price90dChangePct < -20) {
    signals.push({
      type: 'MOMENTUM',
      reason: `Price down ${Math.abs(priceData.price90dChangePct).toFixed(1)}% in 90 days`
    });
  }

  return signals;
}

/**
 * Handle batch analysis
 */
async function handleBatchAnalysis(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await request.json();
    const symbols = body.symbols;

    if (!Array.isArray(symbols) || symbols.length === 0) {
      return jsonResponse({ error: 'Symbols array required' }, 400);
    }

    if (symbols.length > 50) {
      return jsonResponse({ error: 'Maximum 50 symbols per batch' }, 400);
    }

    // Analyze all symbols in parallel
    const results = await Promise.allSettled(
      symbols.map(symbol => analyzeStock(symbol.toUpperCase()))
    );

    const response = {
      total: symbols.length,
      successful: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length,
      results: results.map((result, index) => ({
        symbol: symbols[index].toUpperCase(),
        status: result.status,
        data: result.status === 'fulfilled' ? result.value : null,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };

    return jsonResponse(response);

  } catch (error) {
    return jsonResponse({
      error: 'Batch processing failed',
      message: error.message
    }, 500);
  }
}

/**
 * Cache helpers
 */
async function getCache(key, env) {
  if (!env?.CACHE) return null;

  try {
    const cached = await env.CACHE.get(key, 'json');
    return cached;
  } catch {
    return null;
  }
}

async function setCache(key, value, ttl, env) {
  if (!env?.CACHE) return;

  try {
    await env.CACHE.put(key, JSON.stringify(value), {
      expirationTtl: ttl
    });
  } catch (error) {
    console.warn('Cache write failed:', error);
  }
}

/**
 * Helper functions
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'public, max-age=300'
    }
  });
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
