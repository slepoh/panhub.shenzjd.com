# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PanHub is a Nuxt-based web application that provides unified search across multiple cloud storage platforms (Aliyun, Quark, Baidu, 115, Xunlei, etc.) and Telegram channels. It features intelligent caching, concurrent search optimization, and a plugin-based architecture.

## Common Commands

```bash
# Development
pnpm dev                    # Start dev server
pnpm build                  # Build for production
pnpm preview                # Preview production build
pnpm generate               # Generate static site

# Testing
pnpm test                   # Run all unit tests
pnpm test:watch             # Run tests in watch mode
pnpm test:coverage          # Run tests with coverage
pnpm test:api               # Run API integration tests

# Deployment
pnpm deploy:cf              # Deploy to Cloudflare Workers
```

## Architecture

### Core Search Flow

```
User Input → useSearch (composable) → /api/search endpoint → SearchService → [TG Channels + Plugins] → Merged Results
```

### Key Components

**1. Search Service** (`server/core/services/searchService.ts`)
- Main orchestrator for search operations
- Supports two sources: Telegram channels and plugins
- Priority batch processing: high-priority channels first, then normal channels
- Built-in caching (TG cache + Plugin cache)
- Concurrent execution with `p-limit`

**2. Plugin System** (`server/core/plugins/`)
- Base class: `BaseAsyncPlugin` in `manager.ts`
- Plugins register globally via `registerGlobalPlugin()`
- Active plugins (10): pansearch, qupansou, panta, hunhepan, jikepan, labi, thepiratebay, duoduo, xuexizhinan, nyaa
- Each plugin implements `search(keyword, ext)` → `SearchResult[]`

**3. Memory Cache** (`server/core/cache/memoryCache.ts`)
- LRU eviction policy with memory monitoring
- Configurable: maxSize (1000), maxMemoryBytes (100MB), cleanupInterval (5min)
- Automatic cleanup at 80% memory threshold
- Tracks hits/misses/evictions

**4. Network Utilities** (`server/core/utils/fetch.ts`)
- `fetchWithRetry`: Automatic retry with exponential backoff (3 attempts, 1s/2s/4s)
- `safeExecute`: Error handling with fallback values
- Timeout control (default 8s)

**5. Hot Search System** (`server/core/services/hotSearchSQLite.ts`)
- SQLite-based persistent storage (with memory fallback)
- Records search terms with scoring
- Automatic cleanup (max 50 entries)
- REST API: `POST /api/hot-searches` (record), `GET /api/hot-searches` (retrieve)

**6. Telegram Channel Fetcher** (`server/core/services/tg.ts`)
- Scrapes t.me/s/{channel} for posts
- Uses Jina.ai proxy as fallback for CORS/caching
- Extracts links and passwords from messages
- Classifies by hostname (aliyun, baidu, quark, etc.)

### Frontend

**Composables**
- `useSearch.ts`: Manages search state, performs batched requests (fast + deep search), handles cancellation
- `useSettings.ts`: Manages user preferences (channels, plugins, concurrency) via localStorage

**UI Pattern**
- Fast results: First batch (concurrency count) returned immediately
- Deep results: Remaining batches loaded progressively
- Results merged by type (aliyun, baidu, quark, etc.)

### Configuration

**Runtime Config** (`nuxt.config.ts`)
```typescript
{
  priorityChannels: string[];    // High-priority TG channels
  defaultChannels: string[];     // All TG channels
  defaultConcurrency: number;    // Default: 4
  pluginTimeoutMs: number;       // Default: 5000ms
  cacheEnabled: boolean;         // Default: true
  cacheTtlMinutes: number;       // Default: 30min
}
```

**Channels Config** (`config/channels.json`)
- `priorityChannels`: 8 channels processed with 2x concurrency
- `defaultChannels`: 80+ channels total
- `defaultPlugins`: 10 active plugins

**Plugin Config** (`config/plugins.ts`)
- `ALL_PLUGIN_NAMES`: List of all available plugins
- `PLATFORM_INFO`: Platform metadata (name, color, icon)
- `DEFAULT_USER_SETTINGS`: Default concurrency (4), timeout (5000ms)

## Data Models

```typescript
interface SearchResult {
  message_id: string;
  unique_id: string;
  channel: string;
  datetime: string;      // ISO 8601
  title: string;
  content: string;
  links: Link[];
}

interface Link {
  type: string;          // aliyun, baidu, quark, etc.
  url: string;
  password: string;
}

interface MergedLinks {
  [platform: string]: MergedLink[];  // e.g., { aliyun: [...], baidu: [...] }
}
```

## API Endpoints

- `GET /api/search` - Main search endpoint
  - Params: `kw`, `channels`, `conc`, `refresh`, `res`, `src`, `plugins`, `cloud_types`, `ext`
- `GET /api/health` - Health check
- `POST /api/hot-searches` - Record search term
- `GET /api/hot-searches` - Get hot searches (with `limit` param)

## Testing

**Test Structure** (`test/unit/`)
- `fetch.test.ts`: Network retry, timeout, safe execution
- `memoryCache.test.ts`: LRU, memory monitoring, cleanup
- `pluginManager.test.ts`: Plugin registration, execution
- `tgSearchOptimization.test.ts`: Priority batch processing
- `hot-search.test.ts`: SQLite operations, memory fallback

**Running Specific Tests**
```bash
pnpm test test/unit/memoryCache.test.ts
pnpm test test/unit/tgSearchOptimization.test.ts
```

## Key Optimizations

1. **Priority Batch Processing**: Priority channels use 2x concurrency (up to 12), reducing initial latency by ~95%
2. **Smart Caching**: LRU + memory monitoring prevents leaks, auto-cleanup
3. **Error Isolation**: `safeExecute` ensures single plugin failure doesn't affect others
4. **Concurrent Control**: `p-limit` prevents resource exhaustion
5. **Progressive Results**: Fast results (first batch) shown immediately, deep results load in background

## Deployment

**Cloudflare Workers**: Uses `cloudflare-module` preset
**Vercel**: Uses `vercel` preset (detected via `VERCEL` env var)
**Docker**: Multi-stage build, exposes port 3000

## Important Notes

- better-sqlite3 requires native compilation - falls back to memory mode if unavailable
- TG scraping uses Jina.ai proxy to bypass CORS and improve reliability
- All network requests include user-agent spoofing
- Cache keys are deterministic: `tg:${keyword}:${sortedChannels}` or `plugin:${keyword}:${sortedPlugins}`
- Search cancellation uses AbortController + sequence tracking to prevent race conditions

## Environment Variables

- `LOG_LEVEL`: debug | info | warn | error (default: info)
- `HOT_SEARCH_PASSWORD`: Password for clearing/deleting hot searches (default: admin123)
- `NITRO_PRESET`: Deployment preset (auto-detected)
- `VERCEL`: Set by Vercel for preset detection
