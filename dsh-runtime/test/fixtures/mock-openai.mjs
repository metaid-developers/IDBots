// Test fixture: OpenAI-compatible SSE gateway for M3 E2E tests.
//
// Records every request (method, url, auth, parsed body). A user message
// containing CALL_BIG_TOOL gets a tool_calls response (so the real pi-ai path
// executes the fixture tool and exercises commit-time shaping); anything else
// gets a plain text reply echoing the last user message.

import http from 'node:http'

export function startMockServer(port = 48787) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '(none)', body: parsed, finished: false })
      // RETRY_ME prompts: fail the first attempt with a transient 503 so retry
      // policies are exercised end to end.
      const isRetryProbe = (parsed.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('RETRY_ME'))
      if (isRetryProbe && !startMockServer.retryServed) {
        startMockServer.retryServed = true
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'transient upstream failure', type: 'server_error' } }))
        return
      }
      const record = seen[seen.length - 1]
      res.on('finish', () => { record.finished = true })
      // Aux Anthropic-compatible endpoint used by dsh-web-search-deepseek (the
      // LEGACY provider, still mounted but no longer the selected one): a
      // POST ending in /messages must answer with server_tool_use search
      // blocks (plain JSON — the provider does not stream). Served on the same
      // port so one mock gateway covers the main loop AND the search seam.
      if (req.method === 'POST' && req.url.endsWith('/messages')) {
        // Failure branch: a search whose query carries the fail marker gets a
        // 503 — exercises the kernel's endpoint-diagnostics error path
        // (searchEndpointError names the endpoint and recovery guidance).
        if (JSON.stringify(parsed ?? {}).includes('fail please')) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'mock search backend overloaded' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg-mock-search', type: 'message', role: 'assistant', model: parsed.model ?? 'mock-1',
          content: [
            { type: 'thinking', thinking: 'searching', signature: 'sig' },
            { type: 'server_tool_use', id: 'call_srv_1', name: 'web_search', input: { query: 'latest stable Node.js version' } },
            {
              type: 'web_search_tool_result', tool_use_id: 'call_srv_1',
              content: [
                { type: 'web_search_result', title: 'Node.js — Node.js 26.0.0 (Current)', url: 'https://nodejs.org/en/blog/release/v26.0.0', encrypted_content: 'enc' },
                { type: 'web_search_result', title: 'Node.js 24.x LTS releases', url: 'https://nodejs.org/en/blog/release/v24.18.0', encrypted_content: 'enc' },
              ],
            },
            {
              type: 'text', text: 'The latest Current release is Node.js 26.0.0; the LTS line is 24.18.0.',
              citations: [{ url: 'https://nodejs.org/en/blog/release/v26.0.0', cited_text: 'Node.js 26.0.0 (Current) release notes' }],
            },
          ],
          usage: { input_tokens: 40, output_tokens: 20 },
        }))
        return
      }
      // 0.2.1 DeepSeek Search/Fetch APIs (dsh-web-deepseek-api, the selected
      // providers): direct JSON endpoints on the same mock port. The search
      // response must satisfy the provider's strict mapping (url + title +
      // snippet strings, date string-or-null).
      if (req.method === 'POST' && req.url.endsWith('/v1/tools/search')) {
        if (JSON.stringify(parsed ?? {}).includes('fail please')) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'mock search backend overloaded', type: 'server_error', param: null, code: 'server_error' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          results: [
            { rerank_score: 2.4, title: 'Node.js — Node.js 26.0.0 (Current)', url: 'https://nodejs.org/en/blog/release/v26.0.0', snippet: 'Node.js 26.0.0 (Current) release notes', summary: 'Node.js 26.0.0 shipped as the Current release.', content: '', site_name: 'Node.js', site_icon: null, date: '2026-05-01T00:00:00+00:00', authority: 3 },
            { rerank_score: 2.0, title: 'Node.js 24.x LTS releases', url: 'https://nodejs.org/en/blog/release/v24.18.0', snippet: 'Node.js 24.18.0 LTS release', summary: 'The 24.x LTS line continues.', content: '', site_name: 'Node.js', site_icon: null, date: null, authority: 3 },
          ],
        }))
        return
      }
      if (req.method === 'POST' && req.url.endsWith('/v1/tools/fetch')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ title: 'Example article', content: '# Example article\n\nFETCHED_PAGE_CONTENT_MARKER' }))
        return
      }
      // Skip runtime-injected user-role messages (they can land before OR
      // after the real prompt depending on the create path) — markers key on
      // the actual human input only. Injected messages share stable prefixes:
      // the dsh-system-prompt runtime-context snapshot, the
      // dsh-agent-instructions workspace baseline/replacement frames, and the
      // dsh-time-context clock reading (mounted since 0.1.7 — it is appended
      // last, so without this every marker scan would read the clock instead
      // of the prompt).
      const INJECTED_USER_PREFIXES = [
        'Current runtime context.',
        'Time sampled while preparing turn ',
        '<system-reminder>\nThe following workspace instructions',
        '<system-reminder>\nThis complete workspace instruction baseline',
        '<system-reminder>\nWorkspace instructions were omitted',
      ]
      const isRealUserMessage = (m) => m.role === 'user'
        && !INJECTED_USER_PREFIXES.some((prefix) => String(m.content).startsWith(prefix))
      const lastUser = [...(parsed.messages ?? [])].reverse().find(isRealUserMessage)
      const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : ''
      // A tool result rides as role 'tool'; only the FIRST request of a
      // CALL_BIG_TOOL turn asks for the tool — afterwards answer in plain text
      // so the turn terminates.
      // Tool results ride as role 'tool'; only the CURRENT turn's window
      // (after the last user message) matters — earlier turns already settled.
      const msgs = parsed.messages ?? []
      const lastUserIdx = msgs.map((m) => isRealUserMessage(m) ? 1 : 0).lastIndexOf(1)
      const alreadyHasToolResult = msgs.slice(Math.max(lastUserIdx, 0)).some((m) => m.role === 'tool')

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
        return
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'mock-1' }

      // Continuable-child orchestration (0.1.2-alpha.4): the kernel appends a
      // reporting instruction naming the parent agent id to the child's first
      // user message. A child request without a delivered send_message result
      // answers with a send_message tool call reporting CHILD_REPORT_BG_DONE;
      // after delivery it wraps the turn in plain text.
      const raw = JSON.stringify(parsed.messages ?? [])
      // The instruction text quotes the parent id, which JSON.stringify escapes
      // as \"...\" — match the escaped form.
      const childParentId = /Your parent agent id is \\"([^"\\]+)\\"/.exec(raw)?.[1]
      const isChildRequest = childParentId !== undefined
      // send_message's tool result renders as "message delivered to agent X";
      // once visible in history the child has reported and must wrap up.
      const childHasDelivered = raw.includes('message delivered')
      if (isChildRequest && !childHasDelivered) {
        frame({
          ...base, choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_send_message_1', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ agent_id: childParentId, message: 'CHILD_REPORT_BG_DONE' }) } }] },
            finish_reason: null,
          }],
        })
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        const requestChars = (parsed.messages ?? []).reduce((sum, m) => sum + String(m.content ?? '').length + String(JSON.stringify(m.tool_calls ?? '')).length, 0)
        const promptTokens = Math.max(1, Math.ceil(requestChars / 4))
        frame({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      const cuaCall = /CALL_CUA:([A-Za-z0-9_]+)/.exec(lastUserText)
      // CALL_CUA_FG:<tool> — the cua call carries delivery_mode:"foreground",
      // the pointer-moving route the idbots-cu-route-guard plugin denies.
      const cuaFgCall = /CALL_CUA_FG:([A-Za-z0-9_]+)/.exec(lastUserText)
      const finalizationCandidate = lastUserText.includes('CALL_FINALIZATION')
      const finalizingReply = lastUserText.includes('The execution phase has stopped')
      const toolCallFor = isChildRequest ? null
        : cuaFgCall ? `cua_driver_native__${cuaFgCall[1]}`
        : finalizationCandidate ? 'owner_update'
        : lastUserText.includes('CALL_BIG_TOOL') ? 'big_output_tool'
        : lastUserText.includes('CALL_MID_TOOL') ? 'mid_output_tool'
        : lastUserText.includes('CALL_DANGEROUS') ? 'dangerous_tool'
        : lastUserText.includes('STEER_TEST') ? 'slow_tool'
        : lastUserText.includes('CALL_OWNER_UPDATE') ? 'owner_update'
        : lastUserText.includes('CALL_HOST_TOOL_IMAGE') ? 'host_echo_tool'
        : lastUserText.includes('CALL_HOST_TOOL') ? 'host_echo_tool'
        : lastUserText.includes('CALL_MCP_TOOL') ? 'mcp__echo__echo'
        : lastUserText.includes('CALL_BROWSER_NAV') ? 'mcp__playwright-mcp__browser_navigate'
        : lastUserText.includes('CALL_BROWSER_READ') ? 'mcp__playwright-mcp__browser_network_requests'
        : cuaCall ? `cua_driver_native__${cuaCall[1]}`
        : lastUserText.includes('CALL_WEB_FETCH') ? 'web_fetch'
        : lastUserText.includes('CALL_WEB_SEARCH_FAIL') ? 'web_search'
        // CALL_ASK_TOOL_TIMED:<seconds> — the ask carries an explicit per-call
        // timeout so the test can watch the timed-mode deadline go pending
        // without waiting out the 300s row default. Must precede the plain
        // CALL_ASK_TOOL match (its trigger is a substring of this one).
        : /CALL_ASK_TOOL_TIMED:\d+/.test(lastUserText) ? 'ask_user_question'
        : lastUserText.includes('CALL_ASK_TOOL') ? 'ask_user_question'
        : lastUserText.includes('CALL_WEB_SEARCH') ? 'web_search'
        : lastUserText.includes('LOOP_GREP') ? 'grep'
        : lastUserText.includes('CALL_GREP') ? 'grep'
        : lastUserText.includes('CALL_GLOB') ? 'glob'
        : lastUserText.includes('CALL_EXIT_PLAN') ? 'exit_plan_mode'
        : lastUserText.includes('CALL_READ') ? 'read'
        : lastUserText.includes('RUN_LONG_BASH') ? 'bash'
        : lastUserText.includes('RUN_BASH_WRITE') ? 'bash'
        : lastUserText.includes('RUN_BASH') ? 'bash'
        : lastUserText.includes('DELEGATE_BAD_MODEL') ? 'subagent'
        : lastUserText.includes('DELEGATE_MODEL') ? 'subagent'
        : lastUserText.includes('DELEGATE_FG') ? 'subagent'
        : lastUserText.includes('LIST_MODELS') ? 'list_subagent_models'
        : lastUserText.includes('FOLLOWUP_AGENT') ? 'send_message'
        : lastUserText.includes('DELEGATE') ? 'subagent'
        : null
      // HANG_TEST: open the SSE stream, emit one delta, and never finish —
      // simulates a wedged provider for the stall-watchdog app test. (Headers
      // were already written above; just never end the stream.)
      if (lastUserText.includes('HANG_TEST')) {
        frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hanging' }, finish_reason: null }] })
        return
      }
      let reply = ''
      // LOOP_GREP keeps re-issuing the identical grep call so the
      // repeat-tool-reminder guard fires; stop after four results so the
      // turn terminates.
      const loopRepeating = lastUserText.includes('LOOP_GREP')
        && (parsed.messages ?? []).filter((m) => m?.role === 'tool').length < 4
      if (toolCallFor !== null && (!alreadyHasToolResult || loopRepeating)) {
        const writeMatch = /RUN_BASH_WRITE:([A-Za-z0-9_-]+)/.exec(lastUserText)
        // FOLLOWUP_AGENT:<childId> — the parent sends a follow-up to an
        // existing (possibly dematerialized) continuable child; drives the
        // cold-resume path (subagent-cold-resume test).
        const followupMatch = /FOLLOWUP_AGENT:([A-Za-z0-9-]+)/.exec(lastUserText)
        const args = JSON.stringify(toolCallFor === 'dangerous_tool' ? { payload: 5 } : toolCallFor === 'owner_update' ? { message: 'Owner milestone from runtime', kind: 'milestone' } : toolCallFor === 'host_echo_tool' ? { message: 'ping the host' } : toolCallFor === 'mcp__playwright-mcp__browser_navigate' ? { url: 'data:text/html,<h1>BROWSER_SMOKE_OK</h1>' } : toolCallFor === 'mcp__playwright-mcp__browser_network_requests' ? {} : cuaFgCall ? { delivery_mode: 'foreground' } : toolCallFor?.startsWith('cua_driver_native__') ? {} : toolCallFor === 'mcp__echo__echo' ? { note: 'hello mcp' }
          : toolCallFor === 'send_message' ? { agent_id: followupMatch?.[1] ?? 'unknown-agent', message: 'FOLLOWUP_PING please answer this' }
          : toolCallFor === 'ask_user_question' ? (() => {
            const timedMatch = /CALL_ASK_TOOL_TIMED:(\d+)/.exec(lastUserText)
            return {
              questions: [{ id: 'q1', question: 'Pick a color', header: 'auto-confirm', detail: 'Picking a color refreshes the theme; Red is warm, Blue is calm.', options: [{ label: 'Red' }, { label: 'Blue' }] }],
              ...timedMatch ? { timeout: Number(timedMatch[1]) } : {},
            }
          })()
          : toolCallFor === 'web_search' ? { queries: [lastUserText.includes('CALL_WEB_SEARCH_FAIL') ? 'fail please' : 'latest stable Node.js version'] }
          : toolCallFor === 'web_fetch' ? { url: 'https://example.com/article' }
          : toolCallFor === 'read' ? { file_path: 'readable.txt' } : toolCallFor === 'glob' ? { pattern: '**/*.marker.txt' } : toolCallFor === 'grep' ? { pattern: 'NEEDLE_ALPHA' } : toolCallFor === 'exit_plan_mode' ? { plan: '# Test Plan\n\nDo the thing.' } : toolCallFor === 'bash' ? (lastUserText.includes('RUN_LONG_BASH')
            ? { command: 'sleep 5 && echo LONG_BASH_DONE', description: 'long-running foreground command for the stall-watchdog test' }
            : writeMatch
              ? { command: `echo ${writeMatch[1]} > marker.txt`, description: 'write workspace marker' }
              : { command: 'echo BASH_WORKS && date', description: 'echo test' })
          : toolCallFor === 'subagent' ? (lastUserText.includes('DELEGATE_BAD_MODEL')
            ? { prompt: 'say SUBAGENT_DONE', description: 'unauthorized route', provider: 'mockgw', model: 'mock-9' }
            : lastUserText.includes('DELEGATE_MODEL')
              ? { prompt: 'say SUBAGENT_DONE', description: 'model-selected delegation', provider: 'mockgw', model: 'mock-2' }
              : lastUserText.includes('DELEGATE_FG')
                ? { prompt: 'say SUBAGENT_DONE', description: 'foreground delegation', run_in_background: false }
                : { prompt: 'say SUBAGENT_DONE', description: 'delegation test' })
          : toolCallFor === 'list_subagent_models' ? {} : { note: 'please dump the big blob' })
        frame({
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              ...(finalizationCandidate ? { content: `找到了，本机已经有可复用的文件。${'包含直接回答、验证结果、限制和下一步。'.repeat(12)}` } : {}),
              tool_calls: [{ index: 0, id: `call_${toolCallFor}_1`, type: 'function', function: { name: toolCallFor, arguments: args } }],
            },
            finish_reason: null,
          }],
        })
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        reply = finalizingReply
          ? '找到了，本机已有可复用文件。验证已完成，下一步只需要你提供编号。'
          : finalizationCandidate
            ? '权限已收紧。接下来还需要你提供编号。'
            : alreadyHasToolResult ? 'mock says: tool finished, result was huge but bounded' : `mock says: ${lastUserText.slice(0, 40)}`
        frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        for (const part of [reply.slice(0, Math.ceil(reply.length / 2)), reply.slice(Math.ceil(reply.length / 2))]) {
          frame({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
        }
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      // Realistic usage so token-meter accounting can cross compaction
      // thresholds: ~4 chars per token over the actual payload sizes.
      const requestChars = (parsed.messages ?? []).reduce((sum, m) => sum + String(m.content ?? '').length + String(JSON.stringify(m.tool_calls ?? '')).length, 0)
      const rawPromptTokens = Math.max(1, Math.ceil(requestChars / 4))
      // Compaction AUX calls (the summarization replay, identified by the
      // upstream instruction) report a capped usage instead: pi-ai 0.1.7
      // classifies any stop whose reported usage exceeds the catalog window
      // as CONTEXT_WINDOW_EXCEEDED, and the tiny windows compaction tests
      // run against are always exceeded by the full-history replay. The cap
      // models a provider that accepts the summary request; conversation
      // calls keep their honest (threshold-driving, eventually overflowing)
      // sizes.
      const isCompactionAux = (parsed.messages ?? []).some((m) => String(m?.content ?? '').includes('summarization request'))
      const promptTokens = isCompactionAux ? Math.min(rawPromptTokens, 64) : rawPromptTokens
      const usage = { prompt_tokens: promptTokens, completion_tokens: Math.max(1, Math.ceil(reply.length / 4)) }
      // CACHE_HIT marker: report half the prompt as served from cache so
      // usage-projection tests exercise the cacheRead bucket (pi-ai maps
      // prompt_tokens_details.cached_tokens to cache-read and subtracts it
      // from uncached input).
      if (lastUserText.includes('CACHE_HIT')) {
        usage.prompt_tokens_details = { cached_tokens: Math.floor(promptTokens / 2) }
      }
      frame({ ...base, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen })))
}
