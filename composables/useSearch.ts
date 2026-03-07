import type {
  MergedLink,
  MergedLinks,
  GenericResponse,
  SearchResponse,
  SearchResult,
} from "~/server/core/types/models";
import { ALL_PLUGIN_NAMES } from "~/config/plugins";

/** 从 API 响应中提取 MergedLinks，兼容 merged_by_type、results 及扁平数组等多种格式 */
function extractMergedFromResponse(data: SearchResponse | Record<string, any> | undefined): MergedLinks {
  if (!data) return {};
  // 1. 标准 merged_by_type
  if (data.merged_by_type && typeof data.merged_by_type === "object") {
    const m = data.merged_by_type as MergedLinks;
    if (Object.keys(m).length > 0) return m;
  }
  // 2. results: SearchResult[] 或 MergedLink[]，需展开并分组
  const results = data.results;
  if (Array.isArray(results) && results.length > 0) {
    const out: MergedLinks = {};
    for (const r of results) {
      const rAny = r as any;
      // SearchResult 格式：有 links 数组
      const links = rAny.links;
      if (Array.isArray(links) && links.length > 0) {
        const note = rAny.title || rAny.content || "";
        const dt = rAny.datetime || "";
        for (const link of links) {
          const t = link.type || "others";
          if (!out[t]) out[t] = [];
          out[t].push({
            url: link.url,
            password: link.password || "",
            note,
            datetime: dt,
            source: rAny.channel ? `tg:${rAny.channel}` : undefined,
          });
        }
      } else if (rAny.url) {
        // 扁平 MergedLink 格式
        const t = rAny.type || "others";
        if (!out[t]) out[t] = [];
        out[t].push({
          url: rAny.url,
          password: rAny.password || "",
          note: rAny.note || "",
          datetime: rAny.datetime || "",
          source: rAny.source,
        });
      }
    }
    return out;
  }
  // 3. 扁平数组（data 本身为数组，或 data.items / data.list 等）
  const arr = Array.isArray(data) ? data : (data?.items ?? data?.list ?? data?.data);
  if (Array.isArray(arr) && arr.length > 0) {
    const out: MergedLinks = {};
    for (const item of arr as MergedLink[]) {
      if (item && item.url) {
        const t = (item as any).type || "others";
        if (!out[t]) out[t] = [];
        out[t].push({
          url: item.url,
          password: item.password || "",
          note: item.note || "",
          datetime: item.datetime || "",
          source: item.source,
        });
      }
    }
    return out;
  }
  return {};
}

export interface SearchOptions {
  apiBase: string;
  keyword: string;
  settings: {
    enabledPlugins: string[];
    enabledTgChannels: string[];
    concurrency: number;
    pluginTimeoutMs: number;
  };
}

export interface SearchState {
  loading: boolean;
  deepLoading: boolean;
  paused: boolean;
  error: string;
  searched: boolean;
  elapsedMs: number;
  total: number;
  merged: MergedLinks;
}

export function useSearch() {
  const state = ref<SearchState>({
    loading: false,
    deepLoading: false,
    paused: false,
    error: "",
    searched: false,
    elapsedMs: 0,
    total: 0,
    merged: {},
  });

  const setLoading = (v: boolean) => {
    state.value.loading = v;
  };
  const setDeepLoading = (v: boolean) => {
    state.value.deepLoading = v;
  };
  const setPaused = (v: boolean) => {
    state.value.paused = v;
  };
  const setError = (v: string) => {
    state.value.error = v;
  };
  const setSearched = (v: boolean) => {
    state.value.searched = v;
  };
  const setElapsedMs = (v: number) => {
    state.value.elapsedMs = v;
  };
  const setTotal = (v: number) => {
    state.value.total = v;
  };
  const setMerged = (v: MergedLinks) => {
    state.value.merged = v;
  };

  let searchSeq = 0;
  const activeControllers: AbortController[] = [];

  // 取消所有进行中的请求
  function cancelActiveRequests(): void {
    for (const controller of activeControllers) {
      try {
        controller.abort();
      } catch {}
    }
    activeControllers.length = 0;
  }

  // 暂停搜索
  function pauseSearch(): void {
    if (state.value.loading || state.value.deepLoading) {
      setPaused(true);
      // 取消当前的请求，但保留已获取的结果
      cancelActiveRequests();
    }
  }

  // 继续搜索（从暂停处继续）
  async function continueSearch(options: SearchOptions): Promise<void> {
    if (!state.value.paused || !state.value.searched) return;

    setPaused(false);
    setDeepLoading(true);

    // 继续执行深度搜索，使用当前 searchSeq（暂停时未递增）
    try {
      await performDeepSearch(options, searchSeq);
    } catch (error) {
      // 忽略错误
    } finally {
      setDeepLoading(false);
      setLoading(false);
    }
  }
  // 合并按类型分组的结果
  function mergeMergedByType(
    target: MergedLinks,
    incoming?: MergedLinks
  ): MergedLinks {
    if (!incoming) return target;
    const out: MergedLinks = { ...target };
    for (const type of Object.keys(incoming)) {
      const existed = out[type] || [];
      const next = incoming[type] || [];
      const seen = new Set<string>(existed.map((x) => x.url));
      const mergedArr = [...existed];
      for (const item of next) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          mergedArr.push(item);
        }
      }
      out[type] = mergedArr;
    }
    return out;
  }

  // 执行单个搜索请求
  async function executeSearchRequest(
    url: string,
    params: Record<string, any>,
    signal: AbortController
  ): Promise<SearchResponse | null> {
    try {
      const response = await $fetch<GenericResponse<SearchResponse>>(url, {
        method: "GET",
        query: params,
        signal: signal.signal,
      } as any);
      return response.data || null;
    } catch (error: any) {
      // 请求失败或被中止，返回 null
      return null;
    }
  }


  // 并发搜索 - 每个源独立请求
  async function performParallelSearch(options: SearchOptions, mySeq: number): Promise<void> {
    const { apiBase, keyword, settings } = options;
    const conc = Math.min(16, Math.max(1, Number(settings.concurrency || 3)));

    const enabledPlugins = settings.enabledPlugins.filter((n) =>
      ALL_PLUGIN_NAMES.includes(n as any)
    );

    const enabledTgChannels = settings.enabledTgChannels || [];

    if (enabledPlugins.length === 0 && enabledTgChannels.length === 0) {
      setError("请先在设置中选择至少一个搜索来源");
      return;
    }

    // 收集所有搜索任务
    const searchTasks: Array<() => Promise<MergedLinks>> = [];

    // 为每个插件创建独立的搜索任务（带 AbortController，支持重置/暂停时取消）
    for (const plugin of enabledPlugins) {
      const task = async () => {
        if (mySeq !== searchSeq || state.value.paused) return {};
        const ac = new AbortController();
        activeControllers.push(ac);
        try {
          const extParam = JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs });
          const response = await $fetch<GenericResponse<SearchResponse>>(
            `${apiBase}/search?kw=${encodeURIComponent(keyword)}&res=merged_by_type&src=plugin&plugins=${plugin}&conc=${conc}&ext=${encodeURIComponent(extParam)}`,
            { signal: ac.signal } as any
          );
          return extractMergedFromResponse(response.data);
        } catch (error: any) {
          if (error?.name === "AbortError") return {};
          console.warn(`Plugin ${plugin} search failed:`, error);
          return {};
        } finally {
          const idx = activeControllers.indexOf(ac);
          if (idx >= 0) activeControllers.splice(idx, 1);
        }
      };
      searchTasks.push(task);
    }

    // 为 TG 频道创建搜索任务（每批作为一个任务）
    const tgBatchSize = conc;
    for (let i = 0; i < enabledTgChannels.length; i += tgBatchSize) {
      const batch = enabledTgChannels.slice(i, i + tgBatchSize);
      const task = async () => {
        if (mySeq !== searchSeq || state.value.paused) return {};
        const ac = new AbortController();
        activeControllers.push(ac);
        try {
          const extParam = JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs });
          const response = await $fetch<GenericResponse<SearchResponse>>(
            `${apiBase}/search?kw=${encodeURIComponent(keyword)}&res=merged_by_type&src=tg&channels=${batch.join(',')}&conc=${conc}&ext=${encodeURIComponent(extParam)}`,
            { signal: ac.signal } as any
          );
          return extractMergedFromResponse(response.data);
        } catch (error: any) {
          if (error?.name === "AbortError") return {};
          console.warn(`TG batch ${Math.floor(i / tgBatchSize)} search failed:`, error);
          return {};
        } finally {
          const idx = activeControllers.indexOf(ac);
          if (idx >= 0) activeControllers.splice(idx, 1);
        }
      };
      searchTasks.push(task);
    }

    // 使用 p-limit 控制并发数
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(conc);

    // 执行所有搜索任务，每个任务完成后立即更新页面
    let currentMerged: MergedLinks = {};
    // mySeq 由外部传入，避免重复递增

    const limitedTasks = searchTasks.map((task) => limit(task));
    
    console.log('[performParallelSearch] 开始执行', searchTasks.length, '个搜索任务');

    for (const limitedTask of limitedTasks) {
      if (mySeq !== searchSeq) {
        console.log('[performParallelSearch] 新搜索已开始，停止当前搜索');
        break;
      }
      if (state.value.paused) {
        console.log('[performParallelSearch] 用户已暂停，停止执行');
        break;
      }

      try {
        const result = await limitedTask;
        console.log('[performParallelSearch] 任务完成，结果类型数:', Object.keys(result).length);
        
        if (Object.keys(result).length > 0) {
          currentMerged = mergeMergedByType(currentMerged, result);
          setMerged(currentMerged);
          const total = Object.values(currentMerged).reduce(
            (sum, arr) => sum + (arr?.length || 0),
            0
          );
          setTotal(total);
          console.log('[performParallelSearch] 当前聚合总数:', total);
        }
      } catch (error) {
        console.error('[performParallelSearch] 任务错误:', error);
      }
    }
    
    console.log('[performParallelSearch] 所有任务完成');
  }

  // 快速搜索（第一批）- 实时更新版本
  async function performFastSearch(
    options: SearchOptions,
    onProgress?: (incomingMerged: MergedLinks) => void
  ): Promise<MergedLinks> {
    const { apiBase, keyword, settings } = options;
    const conc = Math.min(16, Math.max(1, Number(settings.concurrency || 3)));
    const batchSize = conc;

    // 插件批次
    const fastPlugins = settings.enabledPlugins.slice(0, conc);
    // TG 频道批次
    const fastTg = settings.enabledTgChannels.slice(0, batchSize);

    // 收集所有请求的 promise
    const resultPromises: Array<Promise<SearchResponse | null>> = [];

    // 插件请求 - 立即发起并独立处理
    if (fastPlugins.length > 0) {
      const ac = new AbortController();
      activeControllers.push(ac);
      const pluginPromise = executeSearchRequest(
        `${apiBase}/search`,
        {
          kw: keyword,
          res: "merged_by_type",
          src: "plugin",
          plugins: fastPlugins.join(","),
          conc: conc,
          ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
        },
        ac
      );
      
      // 每个请求完成后立即触发回调
      pluginPromise.then(result => {
        const extracted = result ? extractMergedFromResponse(result) : {};
        if (Object.keys(extracted).length > 0 && onProgress) onProgress(extracted);
      });
      
      resultPromises.push(pluginPromise);
    }

    // TG 频道请求 - 立即发起并独立处理
    if (fastTg.length > 0) {
      const ac = new AbortController();
      activeControllers.push(ac);
      const tgPromise = executeSearchRequest(
        `${apiBase}/search`,
        {
          kw: keyword,
          res: "merged_by_type",
          src: "tg",
          channels: fastTg.join(","),
          conc: conc,
          ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
        },
        ac
      );
      
      // 每个请求完成后立即触发回调
      tgPromise.then(result => {
        const extracted = result ? extractMergedFromResponse(result) : {};
        if (Object.keys(extracted).length > 0 && onProgress) onProgress(extracted);
      });
      
      resultPromises.push(tgPromise);
    }

    // 等待所有请求完成，返回合并后的最终结果
    const results = await Promise.all(resultPromises);
    let merged: MergedLinks = {};
    for (const r of results) {
      const extracted = r ? extractMergedFromResponse(r) : {};
      if (Object.keys(extracted).length > 0) merged = mergeMergedByType(merged, extracted);
    }
    return merged;
  }

  // 深度搜索（后续批次）
  async function performDeepSearch(
    options: SearchOptions,
    mySeq: number
  ): Promise<void> {
    const { apiBase, keyword, settings } = options;
    const conc = Math.min(16, Math.max(1, Number(settings.concurrency || 3)));
    const batchSize = conc;

    // 剩余插件
    const restPlugins = settings.enabledPlugins.slice(conc);
    const pluginBatches: string[][] = [];
    for (let i = 0; i < restPlugins.length; i += batchSize) {
      pluginBatches.push(restPlugins.slice(i, i + batchSize));
    }

    // 剩余 TG 频道
    const restTg = settings.enabledTgChannels.slice(batchSize);
    const tgBatches: string[][] = [];
    for (let i = 0; i < restTg.length; i += batchSize) {
      tgBatches.push(restTg.slice(i, i + batchSize));
    }

    const maxLen = Math.max(pluginBatches.length, tgBatches.length);

    for (let i = 0; i < maxLen; i++) {
      if (mySeq !== searchSeq) break;
      // 检查是否暂停
      if (state.value.paused) break;

      const reqs: Array<Promise<SearchResponse | null>> = [];

      // 插件批次
      const pb = pluginBatches[i];
      if (pb && pb.length) {
        const ac = new AbortController();
        activeControllers.push(ac);
        reqs.push(
          executeSearchRequest(
            `${apiBase}/search`,
            {
              kw: keyword,
              res: "merged_by_type",
              src: "plugin",
              plugins: pb.join(","),
              conc: conc,
              ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
            },
            ac
          )
        );
      }

      // TG 批次
      const tb = tgBatches[i];
      if (tb && tb.length) {
        const ac = new AbortController();
        activeControllers.push(ac);
        reqs.push(
          executeSearchRequest(
            `${apiBase}/search`,
            {
              kw: keyword,
              res: "merged_by_type",
              src: "tg",
              channels: tb.join(","),
              conc: conc,
              ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
            },
            ac
          )
        );
      }

      if (reqs.length === 0) continue;

      try {
        const resps = await Promise.all(reqs);
        for (const r of resps) {
          if (!r || mySeq !== searchSeq) continue;
          const extracted = extractMergedFromResponse(r);
          if (Object.keys(extracted).length > 0) {
            const currentMerged = state.value.merged;
            const newMerged = mergeMergedByType(currentMerged, extracted);
            setMerged(newMerged);
          }
        }
        // 更新总数
        const currentMerged = state.value.merged;
        setTotal(
          Object.values(currentMerged).reduce(
            (sum, arr) => sum + (arr?.length || 0),
            0
          )
        );
      } catch (error) {
        // 单批失败忽略
      }
    }
  }

  // 主搜索函数
  async function performSearch(options: SearchOptions): Promise<void> {
    const { keyword, settings } = options;

    // 验证
    if (!keyword || keyword.trim().length === 0) {
      setError("请输入搜索关键词");
      return;
    }

    const enabledPlugins = settings.enabledPlugins.filter((n) =>
      ALL_PLUGIN_NAMES.includes(n as any)
    );

    if (
      (settings.enabledTgChannels?.length || 0) === 0 &&
      enabledPlugins.length === 0
    ) {
      setError("请先在设置中选择至少一个搜索来源");
      return;
    }

    // iOS Safari 兼容性：确保输入框失去焦点
    if (
      typeof window !== "undefined" &&
      document.activeElement instanceof HTMLInputElement
    ) {
      document.activeElement.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 重置状态
    setLoading(true);
    setError("");
    setSearched(true);
    setElapsedMs(0);
    setTotal(0);
    setMerged({});
    setDeepLoading(false);

    const mySeq = ++searchSeq;
    const start = performance.now();

    try {
      // 并行搜索 - 每个源独立请求，实时更新
      await performParallelSearch(options, mySeq);
      
      if (mySeq !== searchSeq) return;
    } catch (error: any) {
      setError(error?.data?.message || error?.message || "请求失败");
    } finally {
      setElapsedMs(Math.round(performance.now() - start));
      // 如果暂停了，保持 loading 状态，只取消 deepLoading
      if (!state.value.paused) {
        setLoading(false);
      }
      setDeepLoading(false);
    }
  }

  // 重置搜索
  function resetSearch(): void {
    cancelActiveRequests();
    searchSeq++;
    state.value = {
      loading: false,
      deepLoading: false,
      paused: false,
      error: "",
      searched: false,
      elapsedMs: 0,
      total: 0,
      merged: {},
    };
  }

  // 复制链接
  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      // 忽略复制失败
    }
  }

  // 响应式状态
  const loading = computed(() => state.value.loading);
  const deepLoading = computed(() => state.value.deepLoading);
  const paused = computed(() => state.value.paused);
  const error = computed(() => state.value.error);
  const searched = computed(() => state.value.searched);
  const elapsedMs = computed(() => state.value.elapsedMs);
  const total = computed(() => state.value.total);
  const merged = computed(() => state.value.merged);
  const hasResults = computed(() => Object.keys(state.value.merged).length > 0);

  return {
    state,
    loading,
    deepLoading,
    paused,
    error,
    searched,
    elapsedMs,
    total,
    merged,
    hasResults,
    performSearch,
    resetSearch,
    copyLink,
    cancelActiveRequests,
    pauseSearch,
    continueSearch,
  };
}
