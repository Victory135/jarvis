// Local language model client. The desktop app starts llama.cpp's server on 127.0.0.1 with a per-launch key;
// this module streams replies from it. Conversation history lives in memory only (this session) and is trimmed.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { NATIVE } from './native'
import { log } from './activity'
import { contextBlock, EXAMPLES, PERSONA } from './persona'

type Endpoint = { url: string; key: string; model: string; loadMs: number | null }
type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

// Two models share the work: a small quick one for everyday talk and the large one for real thinking.
// They are never asked at the same moment (the processor has two cores).
const endpoints: { fast: Promise<Endpoint> | null; deep: Promise<Endpoint> | null } = { fast: null, deep: null }

export type ModelState = 'off' | 'loading' | 'ready' | 'unavailable'
let modelState: ModelState = 'off'
let modelName = ''
const stateListeners = new Set<() => void>()
const setModelState = (s: ModelState) => { modelState = s; stateListeners.forEach((l) => l()) }
export function useModelState(): { state: ModelState; name: string } {
  const state = useSyncExternalStore((l) => { stateListeners.add(l); return () => stateListeners.delete(l) }, () => modelState)
  return { state, name: modelName }
}
const history: Msg[] = []
const MAX_TURNS = 6 // user+assistant pairs kept for follow-up questions
let contextProvider: () => Record<string, string | null | undefined> = () => ({})

export function setContextProvider(fn: typeof contextProvider) {
  contextProvider = fn
}

export function clearConversation() {
  history.length = 0
}

function getEndpoint(deep: boolean): Promise<Endpoint> {
  const k = deep ? 'deep' : 'fast'
  if (!endpoints[k]) {
    endpoints[k] = invoke<Endpoint>('llm_endpoint', { fast: !deep }).catch((e) => { endpoints[k] = null; throw e })
  }
  return endpoints[k]!
}

/** Exact same system prompt + examples every turn so the server can reuse its cache of them. */
function prefix(): Msg[] {
  return [
    { role: 'system', content: PERSONA },
    ...EXAMPLES.flatMap(([u, a]): Msg[] => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
  ]
}

/** Start the model and pre-read the personality brief so the first question is answered quickly. */
let warming: Promise<void> | null = null
let deepReady = false
/** True when the large thinking model is loaded (it is skipped when memory is short). */
export const thinkingReady = () => deepReady
export function warmModel(): Promise<void> {
  // Once per app run (React's development mode calls start-up effects twice).
  if (!warming) warming = doWarm()
  return warming
}

async function doWarm() {
  if (!NATIVE) return
  const read = async (deep: boolean) => {
    const t = performance.now()
    const ep = await getEndpoint(deep)
    await fetch(`${ep.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify({ messages: [...prefix(), { role: 'user', content: 'Jarvis?' }], max_tokens: 1, cache_prompt: true }),
    })
    return { ep, s: ((performance.now() - t) / 1000).toFixed(0) }
  }
  try {
    setModelState('loading')
    const quick = await read(false)
    modelName = quick.ep.model
    log('info', `Language model ready: ${quick.ep.model} (${quick.s} s)`)
    setModelState('ready')
    // The thinking model is prepared afterwards, so everyday talk is available first. It is left out when it
    // does not fit in free memory; the quick model then answers everything.
    try {
      const deep = await read(true)
      deepReady = true
      if (deep.ep.model !== quick.ep.model) {
        modelName = `${quick.ep.model} + ${deep.ep.model}`
        log('info', `Thinking model ready: ${deep.ep.model} (${deep.s} s)`)
        setModelState('ready')
      }
    } catch (e) {
      log('warn', `Thinking model not loaded: ${String(e)}. The quick model will answer everything; close other apps and restart me to use it`)
    }
  } catch (e) {
    if (modelState !== 'ready') setModelState('unavailable')
    log('warn', `Language model unavailable: ${String(e)}`)
  }
}

export type ChatResult = { text: string; firstTokenMs: number | null; totalMs: number; tokens: number; model: string }

/**
 * Ask the model. `onText` receives the reply as it is written. The live status (time, system readings) is sent
 * with the user's message rather than in the system prompt, so the cached prefix stays identical.
 */
export async function chat(user: string, maxTokens: number, onText: (delta: string) => void, signal: AbortSignal, deep = false, note = ''): Promise<ChatResult> {
  deep = deep && deepReady
  const ep = await getEndpoint(deep)
  // Machine readings only when the question is about the machine; otherwise they derail the answer.
  const all = contextProvider()
  const aboutSystem = /\b(cpu|processor|memory|ram|disk|drive|storage|space|battery|charge|power|wi-?fi|network|internet|online|laptop|computer|pc|system|machine|slow|fast|performance|hot|running)\b/i.test(user)
  // Every extra word the model must read costs about 0.15 s here, so the clock is only sent when it could matter.
  const aboutTime = /\b(time|date|day|today|tonight|tomorrow|yesterday|morning|afternoon|evening|night|late|early|hour|clock|week|month|year|when|now|soon|lunch|dinner|breakfast|bed|sleep)\b/i.test(user)
  const facts = aboutSystem ? all : aboutTime ? { Time: all.Time } : {}
  const ctx = contextBlock(facts)
  const messages: Msg[] = [
    ...prefix(),
    // The thinking model reads only about 8 words a second, so it is given the last exchange alone, and only when
    // the request refers back to it ("explain that in detail"). The quick model gets the whole recent conversation.
    ...(deep ? (/\b(?:that|this|it|those|these|them|more|again|above|earlier|you said)\b/i.test(user) ? history.slice(-2) : []) : history),
    { role: 'user', content: [user, note, ctx ? `(${ctx})` : ''].filter(Boolean).join('\n\n') },
  ]
  const t0 = performance.now()
  const r = await fetch(`${ep.url}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
    body: JSON.stringify({
      messages, stream: true, cache_prompt: true,
      max_tokens: maxTokens, temperature: 0.4, top_p: 0.8, top_k: 20, repeat_penalty: 1.05,
    }),
  })
  if (!r.ok || !r.body) throw new Error(`model returned ${r.status}`)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  let first: number | null = null
  let tokens = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue
      try {
        const delta: string | undefined = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content
        if (delta) {
          if (first == null) first = performance.now() - t0
          tokens++
          text += delta
          onText(delta)
        }
      } catch { /* partial line */ }
    }
  }
  history.push({ role: 'user', content: user }, { role: 'assistant', content: text.trim() })
  while (history.length > MAX_TURNS * 2) history.splice(0, 2)
  return { text: text.trim(), firstTokenMs: first, totalMs: performance.now() - t0, tokens, model: ep.model }
}

/** Make model text suitable for speech: drop markdown and stock chatbot phrases. */
export function forSpeech(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/[*_#`>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}
