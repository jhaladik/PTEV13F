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
    const url = new URL(request.url);
    const path = url.pathname;

    // Try to serve static assets first (HTML, CSS, JS, etc.)
    if (env.ASSETS) {
      try {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
      } catch (e) {
        // Asset not found, continue to API routes
      }
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    try {

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
        const analysis = await analyzeStock(symbol, env);

        // Store in cache
        await setCache(cacheKey, analysis, CACHE_DURATION, env);

        return jsonResponse(analysis);
      }

      if (path === '/batch' || path === '/batch/') {
        return handleBatchAnalysis(request, env);
      }

      // API info route
      if (path === '/api' || path === '/api/') {
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
      }

      // 404 for unknown routes
      return jsonResponse({ error: 'Not found' }, 404);

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
async function analyzeStock(symbol, env) {
  const startTime = Date.now();

  try {
    // Fetch all data in parallel from multiple sources
    const [yahooData, finnhubData, institutionalData] = await Promise.all([
      getYahooData(symbol),
      getFinnhubData(symbol, env).catch(err => {
        console.warn(`Finnhub data unavailable for ${symbol}:`, err.message);
        return null;
      }),
      getAlphaVantageData(symbol, env).catch(err => {
        console.warn(`Alpha Vantage data unavailable for ${symbol}:`, err.message);
        return null;
      })
    ]);

    // Merge data from Yahoo and Finnhub (Finnhub takes priority for fundamentals)
    const priceData = {
      currentPrice: yahooData.currentPrice,
      price90dChange: yahooData.price90dChange,
      price90dChangePct: yahooData.price90dChangePct,
      marketCap: finnhubData?.marketCap || yahooData.marketCap || 0,
      enterpriseValue: finnhubData?.enterpriseValue || yahooData.enterpriseValue || 0,
      revenue: yahooData.revenue,
      evToRevenue: finnhubData?.evToRevenue || yahooData.evToRevenue,
      peRatio: finnhubData?.peRatio || yahooData.peRatio,
      priceToSales: finnhubData?.priceToSales || yahooData.priceToSales,
      priceToBook: finnhubData?.priceToBook || yahooData.priceToBook
    };

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
          change90dPct: priceData.price90dChangePct,
          history: yahooData.priceHistory || []
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
          insiderOwnership: institutionalData.insiderOwnership,
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
 * Fetch fundamental data from Finnhub
 */
async function getFinnhubData(symbol, env) {
  const apiKey = env?.FINNHUB_API_KEY;

  if (!apiKey) {
    // Return null if no API key configured
    return null;
  }

  try {
    // Fetch company metrics from Finnhub
    const metricsUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${apiKey}`;
    const metricsResp = await fetch(metricsUrl);

    if (!metricsResp.ok) {
      throw new Error(`Finnhub API error: ${metricsResp.status}`);
    }

    const metricsData = await metricsResp.json();

    if (metricsData.error) {
      throw new Error(metricsData.error);
    }

    const metric = metricsData.metric || {};

    return {
      marketCap: metric.marketCapitalization ? metric.marketCapitalization * 1000000 : null,
      enterpriseValue: metric.enterpriseValue ? metric.enterpriseValue * 1000000 : null,
      peRatio: metric.peBasicExclExtraTTM || metric.peTTM || null,
      priceToBook: metric.pbAnnual || metric.pbQuarterly || null,
      priceToSales: metric.psAnnual || metric.psTTM || null,
      evToRevenue: metric.enterpriseValueOverRevenueTTM || null
    };

  } catch (error) {
    console.warn(`Finnhub data fetch failed for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Fetch data from Yahoo Finance
 */
async function getYahooData(symbol) {
  try {
    // Fetch price data and 90-day history from Yahoo Finance chart API (still works)
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=3mo&interval=1d`;
    const chartResp = await fetch(chartUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!chartResp.ok) {
      throw new Error(`Yahoo Finance API error: ${chartResp.status}`);
    }

    const chartData = await chartResp.json();
    const result = chartData.chart?.result?.[0];

    if (!result) {
      throw new Error('Invalid symbol or no data available');
    }

    const meta = result.meta;
    const prices = result.indicators?.quote?.[0]?.close?.filter(p => p !== null) || [];
    const timestamps = result.timestamp || [];

    // Calculate 90-day price change
    let price90dChange = null;
    let price90dChangePct = null;

    if (prices.length >= 2) {
      const oldPrice = prices[0];
      const newPrice = prices[prices.length - 1];
      price90dChange = newPrice - oldPrice;
      price90dChangePct = (price90dChange / oldPrice) * 100;
    }

    // Prepare historical data for charting (combine timestamps and prices)
    const priceHistory = timestamps.slice(0, prices.length).map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().split('T')[0], // Convert to YYYY-MM-DD
      price: prices[index] ? parseFloat(prices[index].toFixed(2)) : null
    })).filter(item => item.price !== null);

    // Extract basic data from metadata
    const currentPrice = meta.regularMarketPrice || 0;
    const marketCap = meta.marketCap || 0;

    // Use Yahoo Finance's v6 endpoint for basic stats (sometimes works without auth)
    let peRatio = null;
    let priceToBook = null;
    let priceToSales = null;
    let evToRevenue = null;
    let enterpriseValue = marketCap; // Fallback to market cap
    let revenue = 0;

    try {
      const statsUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics,financialData`;
      const statsResp = await fetch(statsUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': `https://finance.yahoo.com/quote/${symbol}`
        }
      });

      if (statsResp.ok) {
        const statsData = await statsResp.json();
        const stats = statsData.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
        const financials = statsData.quoteSummary?.result?.[0]?.financialData || {};

        peRatio = stats.trailingPE?.raw || financials.currentPrice?.raw / (financials.trailingEps?.raw || 1) || null;
        priceToBook = stats.priceToBook?.raw || null;
        enterpriseValue = stats.enterpriseValue?.raw || financials.enterpriseValue?.raw || marketCap;
        revenue = financials.totalRevenue?.raw || 0;

        if (revenue && enterpriseValue) {
          evToRevenue = enterpriseValue / revenue;
        }

        if (financials.revenuePerShare?.raw && currentPrice) {
          priceToSales = currentPrice / financials.revenuePerShare?.raw;
        }
      }
    } catch (e) {
      // Stats API failed, continue with limited data
      console.warn('Failed to fetch detailed stats:', e.message);
    }

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
      price90dChangePct,
      priceHistory
    };

  } catch (error) {
    throw new Error(`Yahoo Finance fetch failed: ${error.message}`);
  }
}

/**
 * Fetch institutional ownership from Yahoo Finance (HTML fallback)
 */
async function getYahooInstitutionalData(symbol) {
  try {
    const statsUrl = `https://finance.yahoo.com/quote/${symbol}/key-statistics`;
    const response = await fetch(statsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance HTML fetch error: ${response.status}`);
    }

    const html = await response.text();

    // Parse institutional ownership percentage from HTML
    // Looking for pattern like "% Held by Institutions" followed by the percentage
    const institutionalMatch = html.match(/Held by Institutions[^>]*>\s*([0-9.]+)%/i) ||
                              html.match(/institutionsPercentHeld[^>]*>\s*([0-9.]+)%/i);

    const insiderMatch = html.match(/Held by Insiders[^>]*>\s*([0-9.]+)%/i) ||
                        html.match(/insidersPercentHeld[^>]*>\s*([0-9.]+)%/i);

    const institutionalOwnership = institutionalMatch ? parseFloat(institutionalMatch[1]) : null;
    const insiderOwnership = insiderMatch ? parseFloat(insiderMatch[1]) : null;

    if (institutionalOwnership === null && insiderOwnership === null) {
      throw new Error('Could not parse ownership data from HTML');
    }

    return {
      ownershipPercent: institutionalOwnership,
      insiderOwnership: insiderOwnership,
      sharesOutstanding: null,
      quarterlyChange: null,
      topHolders: [],
      source: 'Yahoo Finance HTML'
    };

  } catch (error) {
    console.warn(`Yahoo Finance HTML parse failed for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Fetch institutional ownership from Alpha Vantage (primary) with Yahoo Finance fallback
 */
async function getAlphaVantageData(symbol, env) {
  const apiKey = env?.ALPHAVANTAGE_API_KEY;

  // Try Alpha Vantage first if API key is available
  if (apiKey) {
    try {
      const overviewUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`;
      const response = await fetch(overviewUrl);

      if (!response.ok) {
        throw new Error(`Alpha Vantage API error: ${response.status}`);
      }

      const data = await response.json();

      // Check for rate limit or error
      if (data['Note'] && data['Note'].includes('rate limit')) {
        console.warn(`Alpha Vantage rate limit reached, falling back to Yahoo Finance for ${symbol}`);
        return await getYahooInstitutionalData(symbol);
      }

      if (data['Error Message']) {
        throw new Error(data['Error Message']);
      }

      const institutionalOwnership = parseFloat(data.PercentInstitutions) || null;
      const insiderOwnership = parseFloat(data.PercentInsiders) || null;
      const sharesOutstanding = parseFloat(data.SharesOutstanding) || null;

      return {
        ownershipPercent: institutionalOwnership,
        insiderOwnership: insiderOwnership,
        sharesOutstanding: sharesOutstanding,
        quarterlyChange: null,
        topHolders: [],
        source: 'Alpha Vantage'
      };

    } catch (error) {
      console.warn(`Alpha Vantage failed for ${symbol}, trying Yahoo Finance fallback:`, error.message);
      return await getYahooInstitutionalData(symbol);
    }
  }

  // No API key, use Yahoo Finance HTML parsing
  return await getYahooInstitutionalData(symbol);
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
  // High institutional ownership + price decline = smart money holding through pullback (bullish)
  if (institutionalData && institutionalData.ownershipPercent !== null && institutionalData.ownershipPercent !== undefined) {
    const ownership = institutionalData.ownershipPercent;
    const priceDown = priceData.price90dChangePct < 0;

    // Reward high institutional ownership, especially when price is down
    if (ownership >= 70) {
      score += priceDown ? 30 : 20; // Max points if institutions holding during decline
    } else if (ownership >= 50) {
      score += priceDown ? 25 : 15;
    } else if (ownership >= 40) {
      score += priceDown ? 20 : 10;
    } else if (ownership >= 30) {
      score += priceDown ? 15 : 5;
    }
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

  // Institutional ownership signal
  if (institutionalData && institutionalData.ownershipPercent !== null && institutionalData.ownershipPercent !== undefined) {
    const ownership = institutionalData.ownershipPercent;
    const priceDown = priceData.price90dChangePct < -10;

    if (ownership >= 50 && priceDown) {
      signals.push({
        type: 'INSTITUTIONAL',
        reason: `${ownership.toFixed(1)}% institutional ownership - smart money holding through ${Math.abs(priceData.price90dChangePct).toFixed(1)}% decline`
      });
    } else if (ownership >= 60) {
      signals.push({
        type: 'INSTITUTIONAL',
        reason: `High institutional ownership (${ownership.toFixed(1)}%)`
      });
    }
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
      symbols.map(symbol => analyzeStock(symbol.toUpperCase(), env))
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
