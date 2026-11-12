import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { McpRegistry } from '../src/mcp-registry.mjs';

const tools = [
  ['search_documents', 'Search text documents and return matching passages.'],
  ['summarize_meeting', 'Summarize a meeting transcript into decisions and follow-up action items.'],
  ['translate_text', 'Translate text between supported languages.'],
  ['send_email', 'Send an email message to one or more recipients.'],
  ['find_calendar_events', 'Find calendar events by date, attendee, or availability.'],
  ['create_calendar_event', 'Create and schedule a new calendar event.'],
  ['list_files', 'List files and folders in cloud storage.'],
  ['read_file', 'Read the contents of a file.'],
  ['search_code', 'Find code symbols and text across source repositories.'],
  ['create_pull_request', 'Open a GitHub pull request for a branch.'],
  ['review_pull_request', 'Review pull request changes and identify code defects.'],
  ['deploy_application', 'Build and deploy an application to an environment.'],
  ['check_service_health', 'Check service health, availability, and recent failures.'],
  ['get_server_metrics', 'Read CPU, memory, disk, and network metrics for a server.'],
  ['query_database', 'Run a read-only SQL query against a database.'],
  ['create_issue', 'Create a task or issue in a project tracker.'],
  ['search_issues', 'Search project issues by text, label, or status.'],
  ['list_contacts', 'List contacts and email addresses.'],
  ['lookup_customer', 'Find customer account details and support history.'],
  ['get_stock_quote', 'Fetch a stock current market price and daily change.'],
  ['search_transactions', 'Search financial transactions by merchant, date, and amount.'],
  ['calculate_budget', 'Calculate monthly budget totals and spending categories.'],
  ['summarize_article', 'Summarize long-form article text.'],
  ['extract_table', 'Extract rows and columns from a document.'],
  ['transcribe_audio', 'Convert recorded speech and audio into text.'],
  ['generate_chart', 'Create a chart from structured data.'],
  ['upload_file', 'Upload a file to cloud storage.'],
  ['delete_file', 'Delete a file by identifier.'],
  ['restart_service', 'Restart a running service.'],
  ['get_user_profile', 'Read a user profile and account settings.'],
  ['search_web', 'Search public web pages.'],
  ['create_database', 'Create a database connection.'],
];

const queries = [
  ['en', 'extract follow-up tasks from the call transcript', 'summarize_meeting'],
  ['en', 'show appointments scheduled for next Tuesday', 'find_calendar_events'],
  ['en', 'book a new meeting with the team tomorrow', 'create_calendar_event'],
  ['en', 'find the refund policy in our documents', 'search_documents'],
  ['en', 'what is NVDA trading at now', 'get_stock_quote'],
  ['en', 'send an update to the customer by email', 'send_email'],
  ['en', 'locate the function implementation in the repository', 'search_code'],
  ['en', 'open a change request for the feature branch', 'create_pull_request'],
  ['en', 'inspect the proposed code changes for defects', 'review_pull_request'],
  ['en', 'ship the new build to production', 'deploy_application'],
  ['en', 'verify that the API is responding normally', 'check_service_health'],
  ['en', "show the server's current RAM and CPU usage", 'get_server_metrics'],
  ['ko', '회의 녹취에서 결정사항과 후속 할 일을 정리해줘', 'summarize_meeting'],
  ['ko', '다음 주 화요일에 등록된 일정을 찾아줘', 'find_calendar_events'],
  ['ko', '내일 오후 팀 회의를 새로 잡아줘', 'create_calendar_event'],
  ['ko', '문서 본문에서 환불 규정을 찾아줘', 'search_documents'],
  ['ko', 'NVDA 현재 주가와 등락 확인해줘', 'get_stock_quote'],
  ['ko', '고객에게 안내 메일을 작성하고 보내줘', 'send_email'],
  ['ko', '저장소에서 함수 정의를 찾아줘', 'search_code'],
  ['ko', '이 브랜치로 변경 요청을 만들어줘', 'create_pull_request'],
  ['ko', 'PR 바뀐 코드 검토해서 결함 찾아줘', 'review_pull_request'],
  ['ko', '새 버전을 서비스에 배포해줘', 'deploy_application'],
  ['ko', 'API 응답이 정상인지 상태 확인해줘', 'check_service_health'],
  ['ko', '서버 CPU와 메모리 사용량 보여줘', 'get_server_metrics'],
];

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summary(samples, hits) {
  return {
    top5Hits: hits,
    top5Recall: hits / queries.length,
    meanQueryMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95QueryMs: percentile(samples, 0.95),
  };
}

const registry = new McpRegistry(300_000);
registry.servers.set('benchmark', {
  spec: { id: 'benchmark' },
  allowedTools: null,
  client: {
    listTools: async () => ({ tools: tools.map(([name, description]) => ({ name, description, inputSchema: { type: 'object' } })) }),
    close: async () => {},
  },
  tools: new Map(),
  state: 'ready',
  retryAttempt: 0,
  retryTimer: null,
  reconnectTimer: null,
});
registry.status.set('benchmark', { serverId: 'benchmark', state: 'ready', stale: false });

try {
  await registry.refresh('benchmark');
  const hybridSearch = registry.embeddingSearch;
  const modelStart = performance.now();
  await hybridSearch.load();
  const modelLoadMs = performance.now() - modelStart;
  const catalog = [...registry.catalog.get('benchmark').values()];
  const indexStart = performance.now();
  await hybridSearch.rank('catalog warmup', catalog);
  const catalogEmbeddingMs = performance.now() - indexStart;

  const bm25Search = {
    syncCatalog() {},
    async rank() { throw new Error('BM25-only benchmark baseline'); },
    clear() {},
  };
  const bm25Times = [];
  const hybridTimes = [];
  let bm25Hits = 0;
  let hybridHits = 0;
  const byLanguage = Object.fromEntries(['en', 'ko'].map(language => [language, {
    queries: 0, bm25Hits: 0, hybridHits: 0, bm25Times: [], hybridTimes: [],
  }]));
  const misses = [];

  for (const [language, query, expected] of queries) {
    const languageStats = byLanguage[language];
    languageStats.queries += 1;
    registry.embeddingSearch = bm25Search;
    let started = performance.now();
    const baseline = await registry.search({ query, limit: 5 });
    const baselineMs = performance.now() - started;
    bm25Times.push(baselineMs);
    languageStats.bm25Times.push(baselineMs);
    if (baseline.tools.some(item => item.toolName === expected)) {
      bm25Hits += 1;
      languageStats.bm25Hits += 1;
    }

    registry.embeddingSearch = hybridSearch;
    started = performance.now();
    const fused = await registry.search({ query, limit: 5 });
    const hybridMs = performance.now() - started;
    hybridTimes.push(hybridMs);
    languageStats.hybridTimes.push(hybridMs);
    if (fused.tools.some(item => item.toolName === expected)) {
      hybridHits += 1;
      languageStats.hybridHits += 1;
    } else misses.push({ language, query, expected, top5: fused.tools.map(item => item.toolName) });
  }

  console.log(JSON.stringify({
    synthetic: true,
    model: 'hotchpotch/bekko-embedding-v1-a8m',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpuCount: os.availableParallelism() },
    corpusTools: tools.length,
    queries: queries.length,
    languages: { en: queries.filter(([language]) => language === 'en').length, ko: queries.filter(([language]) => language === 'ko').length },
    modelLoadMs,
    catalogEmbeddingMs,
    bm25: summary(bm25Times, bm25Hits),
    hybrid: summary(hybridTimes, hybridHits),
    byLanguage: Object.fromEntries(Object.entries(byLanguage).map(([language, stats]) => [language, {
      queries: stats.queries,
      bm25Top5Recall: stats.bm25Hits / stats.queries,
      hybridTop5Recall: stats.hybridHits / stats.queries,
      bm25MeanQueryMs: stats.bm25Times.reduce((sum, value) => sum + value, 0) / stats.queries,
      hybridMeanQueryMs: stats.hybridTimes.reduce((sum, value) => sum + value, 0) / stats.queries,
    }])),
    hybridMisses: misses,
  }, null, 2));
} finally {
  await registry.close();
}
