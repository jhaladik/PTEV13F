-- Stock Divergence Analyzer Database Schema
-- Purpose: Store historical stock data for correlation analysis and prediction

-- 1. Daily Stock Snapshots
-- Stores daily price, volume, and valuation metrics for correlation analysis
CREATE TABLE IF NOT EXISTS stock_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    date DATE NOT NULL,

    -- Price data
    price REAL NOT NULL,
    open_price REAL,
    high_price REAL,
    low_price REAL,
    volume INTEGER,
    market_cap REAL,

    -- Valuation metrics
    pe_ratio REAL,
    price_to_sales REAL,
    price_to_book REAL,
    ev_to_revenue REAL,
    enterprise_value REAL,

    -- Performance metrics
    change_1d REAL,
    change_7d REAL,
    change_30d REAL,
    change_90d REAL,

    -- Divergence score (our calculated metric)
    divergence_score INTEGER,

    -- Metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Ensure one snapshot per symbol per day
    UNIQUE(symbol, date)
);

-- Index for fast symbol queries
CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON stock_snapshots(symbol);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON stock_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_date ON stock_snapshots(symbol, date);

-- 2. Analyst Ratings History
-- Track analyst recommendations over time to correlate with price movements
CREATE TABLE IF NOT EXISTS analyst_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    date DATE NOT NULL,

    -- Analyst breakdown
    strong_buy INTEGER DEFAULT 0,
    buy INTEGER DEFAULT 0,
    hold INTEGER DEFAULT 0,
    sell INTEGER DEFAULT 0,
    strong_sell INTEGER DEFAULT 0,

    -- Calculated metrics
    total_analysts INTEGER,
    buy_percentage REAL, -- (strong_buy + buy) / total
    consensus_score REAL, -- Weighted score

    -- Month over month change
    change_from_previous_month INTEGER,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_ratings_symbol ON analyst_ratings(symbol);
CREATE INDEX IF NOT EXISTS idx_ratings_date ON analyst_ratings(date);

-- 3. Earnings History
-- Track earnings beats/misses and surprises
CREATE TABLE IF NOT EXISTS earnings_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    quarter INTEGER NOT NULL,
    year INTEGER NOT NULL,
    report_date DATE NOT NULL,

    -- Earnings data
    actual_eps REAL,
    estimated_eps REAL,
    surprise REAL,
    surprise_percent REAL,

    -- Revenue data (if available)
    actual_revenue REAL,
    estimated_revenue REAL,

    -- Track beat/miss
    is_beat BOOLEAN,

    -- Stock reaction (can be updated post-earning)
    price_change_1d REAL,
    price_change_7d REAL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(symbol, year, quarter)
);

CREATE INDEX IF NOT EXISTS idx_earnings_symbol ON earnings_history(symbol);
CREATE INDEX IF NOT EXISTS idx_earnings_date ON earnings_history(report_date);

-- 4. News & Sentiment
-- Track news events for sentiment analysis
CREATE TABLE IF NOT EXISTS news_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    published_date DATETIME NOT NULL,

    headline TEXT NOT NULL,
    summary TEXT,
    source TEXT,
    url TEXT,

    -- Sentiment (can be calculated or manual)
    sentiment TEXT, -- 'positive', 'negative', 'neutral'
    sentiment_score REAL, -- -1 to 1

    -- Categories
    category TEXT, -- 'earnings', 'product', 'legal', 'general'

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_news_symbol ON news_events(symbol);
CREATE INDEX IF NOT EXISTS idx_news_date ON news_events(published_date);

-- 5. SEC Filings
-- Track important SEC filings (8-K material events, Form 4 insider trading)
CREATE TABLE IF NOT EXISTS sec_filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    cik TEXT NOT NULL,
    filing_type TEXT NOT NULL, -- '8-K', '10-K', '10-Q', '4'
    filing_date DATE NOT NULL,

    accession_number TEXT UNIQUE NOT NULL,

    -- For Form 4 (insider trading)
    is_insider_buy BOOLEAN,
    is_insider_sell BOOLEAN,
    shares_traded INTEGER,

    -- Price reaction
    price_change_1d REAL,
    price_change_7d REAL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_filings_symbol ON sec_filings(symbol);
CREATE INDEX IF NOT EXISTS idx_filings_type ON sec_filings(filing_type);
CREATE INDEX IF NOT EXISTS idx_filings_date ON sec_filings(filing_date);

-- 6. Correlation Analysis Results
-- Store calculated correlations for quick access
CREATE TABLE IF NOT EXISTS correlations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,

    -- What are we correlating?
    metric_1 TEXT NOT NULL, -- e.g., 'analyst_upgrades'
    metric_2 TEXT NOT NULL, -- e.g., 'price_change_30d'

    -- Correlation coefficient
    correlation REAL NOT NULL, -- -1 to 1

    -- Statistical significance
    p_value REAL,
    sample_size INTEGER,

    -- Time period
    start_date DATE,
    end_date DATE,

    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(symbol, metric_1, metric_2, start_date, end_date)
);

CREATE INDEX IF NOT EXISTS idx_correlations_symbol ON correlations(symbol);

-- 7. Prediction Results (optional - track prediction accuracy)
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    prediction_date DATE NOT NULL,

    -- What we predicted
    predicted_direction TEXT, -- 'up', 'down', 'neutral'
    predicted_change_percent REAL,
    confidence_score REAL, -- 0 to 1

    -- Time horizon
    target_days INTEGER, -- e.g., 30 days forward
    target_date DATE,

    -- Actual outcome (filled in later)
    actual_change_percent REAL,
    was_correct BOOLEAN,

    -- What signals drove the prediction
    factors_json TEXT, -- JSON of contributing factors

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_predictions_symbol ON predictions(symbol);
CREATE INDEX IF NOT EXISTS idx_predictions_date ON predictions(prediction_date);
