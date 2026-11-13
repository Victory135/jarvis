// Hands-free wake word: "Hey Jarvis".
// The microphone stays open, but nothing is done with what it hears until someone speaks. Each spoken phrase is
// checked on this PC; unless it starts with the assistant's name it is dropped at once: not logged, not shown,
// not kept. Only a phrase addressed to JARVIS is treated as a request.

// How speech engines tend to hear the name, including with an Indian-English accent.
const NAMES = ['jarvis', "jarvis's", 'jervis', 'jarvus', 'jarvas', 'jarves', 'jarvice', 'jarvish', 'jarwis', 'jarviz', 'jarvi', 'jarvies', 'javis',
  'garvis', 'charvis', 'travis', 'jarvys', "jerry's", 'jarbis', 'jorvis', 'jarviss', 'jarvest', 'jarvez', 'jaris', 'jarris', 'darvis', 'yarvis', 'zarvis']
const GREET = new Set(['hey', 'hay', 'hi', 'hello', 'ok', 'okay', 'yo', 'oh', 'a', 'and', 'he', 'they', 'hey,'])

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return d[a.length][b.length]
}
/** Is this word (or pair of words, "jar vis") his name as a speech engine might write it? */
export function isName(w: string): boolean {
  if (NAMES.includes(w)) return true
  // close misspellings: starts like the name, ends in an s-sound, one or two letters off
  return /^(?:j|g|ch|dj|z|y)[aeo]r?[rvwbf]/.test(w) && /(?:s|z|sh|ce|x)$/.test(w) && w.length >= 5 && w.length <= 8 && distance(w, 'jarvis') <= 2
}

/** If the phrase is addressed to JARVIS, returns the request that follows his name ('' when only the name was said). */
export function heardWake(text: string): { command: string } | null {
  const words = text.toLowerCase().replace(/[’]/g, "'").replace(/[.,!?;:"-]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  let i = 0
  while (i < 2 && i < words.length - 1 && GREET.has(words[i])) i++
  if (i < words.length && isName(words[i])) return { command: words.slice(i + 1).join(' ') }
  if (i + 1 < words.length && isName(words[i] + words[i + 1])) return { command: words.slice(i + 2).join(' ') }
  // "wake up Jarvis", "wake up daddy's home"
  if (words[0] === 'wake' && words[1] === 'up') return { command: 'wake up' }
  return null
}
