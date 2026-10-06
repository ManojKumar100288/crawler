// AI-powered report summary.
// Takes a crawl report and sends it to an LLM (OpenAI-compatible API) to get a
// clear, prioritized plain-English summary that a CTO or PM can read in seconds.
//
// Supports: OpenAI, Azure OpenAI, any OpenAI-compatible endpoint (Ollama, etc.)
// Gracefully skips if no API key is configured.

/**
 * Generate an AI summary for the given crawl report.
 * @param {object} report - The full crawl report object.
 * @param {object} cfg - The tool config (must have cfg.ai).
 * @param {(msg: string) => void} log
 * @returns {Promise<string|null>} The AI summary text, or null if skipped.
 */
export async function generateAiSummary(report, cfg, log = () => {}) {
  const ai = cfg.ai || {};
  if (!ai.enabled) {
    log('[ai] AI summary disabled (no API key configured). Skipping.');
    return null;
  }
  if (!ai.apiKey) {
    log('[ai] AI summary enabled but no API key provided. Skipping.');
    return null;
  }

  const model = ai.model || 'gpt-4o-mini';
  const baseUrl = (ai.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;

  // Build a compact version of the report to fit in the prompt (avoid sending
  // the full raw data which can be huge).
  const compact = buildCompactReport(report);

  const systemPrompt = `You are a senior QA engineer. You receive the results of an automated website crawl and must produce a clear, actionable summary for a CTO or engineering manager. Be concise, prioritize by severity, and use plain English. Structure your response as:

1. **Overall status** (one sentence: healthy / has issues / critical problems)
2. **Key findings** (bullet points, most important first)
3. **Recommended actions** (what the team should fix first)

Keep the summary under 300 words. Do not repeat raw URLs — reference pages by name/path. If there are blocked (bot-protected) links, mention them briefly but clarify they are likely fine.`;

  const userPrompt = `Here is the crawl report for ${report.baseUrl}:\n\n${JSON.stringify(compact, null, 2)}`;

  log(`[ai] Generating AI summary using ${model}...`);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`[ai] API error ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      log('[ai] Empty response from AI API.');
      return null;
    }

    log('[ai] AI summary generated successfully.');
    return summary;
  } catch (err) {
    log(`[ai] Failed to generate summary: ${err.message}`);
    return null;
  }
}

/**
 * Build a compact version of the report suitable for sending to the LLM.
 * Strips large fields and limits detail to keep token usage low.
 */
function buildCompactReport(report) {
  return {
    baseUrl: report.baseUrl,
    durationMs: report.durationMs,
    summary: report.summary,
    auth: report.auth,
    sitemap: report.sitemap ? {
      used: report.sitemap.used,
      urlsFound: report.sitemap.urlsFound,
    } : undefined,
    homeLinks: report.homeLinks ? {
      total: report.homeLinks.total,
      header: report.homeLinks.header,
      footer: report.homeLinks.footer,
      body: report.homeLinks.body,
    } : undefined,
    // Send only pages that have issues (keep it compact).
    pagesWithIssues: report.pages
      .filter((p) => p.issues.length > 0)
      .map((p) => ({
        url: p.url,
        status: p.status,
        loadMs: p.loadMs,
        title: p.title,
        issues: p.issues.map((i) => ({ severity: i.severity, type: i.type, message: i.message.slice(0, 200) })),
      })),
    brokenExternalLinks: report.externalLinks
      .filter((l) => !l.ok && !l.blocked)
      .map((l) => ({ url: l.url, status: l.status, error: l.error })),
    blockedLinks: report.externalLinks
      .filter((l) => l.blocked)
      .map((l) => ({ url: l.url, status: l.status }))
      .slice(0, 10), // cap to keep prompt small
  };
}
