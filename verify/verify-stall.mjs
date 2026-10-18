// Regression suite for the bound that was missing after the first frame.
//
// The shipped suites are correct about what they assert and silent about the
// runtime: their sandbox captures timers without firing them, and their media stub
// reports readyState 0, so `reveal()` never runs and none of the wall-clock
// behaviour — the hold window, the no-frame watchdog, the tail loop, the stall
// watchdog — is ever executed. The scenario this file pins is exactly one of
// those, and it is the one with no bound before the patch:
//
//   a clip paints a frame, `reveal()` disarms the six-second no-frame watchdog,
//   and the clip then wedges on the network. `ended` never fires, `currentTime`
//   freezes, the tail check declines every frame, and the hold timer returns
//   immediately because the kernel is already ready. Before the patch the
//   overlay stayed up indefinitely.
//
// Usage:  node verify/verify-stall.mjs [path/to/boot-screen.js]
//
// The argument exists so the same scenario can be replayed against a pristine
// copy of the file — that is how the contrast below is produced. Omit it and the
// suite tests the one in this package.

import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCREEN_PATH = process.argv[2] ?? resolve(root, 'src/boot-screen.js')
const SCREEN = readFileSync(SCREEN_PATH, 'utf8')

let checks = 0
let failures = 0
function check(label, condition, detail) {
  checks++
  console.log((condition ? '  ok   ' : '  FAIL ') + label
    + (detail === undefined || detail === '' ? '' : '   [' + detail + ']'))
  if (!condition) failures++
}

/**
 * A timer queue driven by hand.
 *
 * The shipped sandbox swallows timers because its assertions are about decisions
 * the screen makes before any clock runs. Everything asserted here is the clock.
 */
function makeClock() {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map()
  const schedule = (handler, ms, repeat) => {
    const id = nextId++
    timers.set(id, { handler, at: now + Math.max(Number(ms) || 0, 0), repeat })
    return id
  }
  return {
    now: () => now,
    setTimeout: (handler, ms) => schedule(handler, ms, 0),
    setInterval: (handler, ms) => schedule(handler, ms, Math.max(Number(ms) || 1, 1)),
    clear: (id) => { timers.delete(id) },
    /** Run every timer due within `span`, in deadline order. */
    advance(span) {
      const until = now + span
      for (;;) {
        let due = null
        let dueId = null
        for (const [id, timer] of timers) {
          if (timer.at > until) continue
          if (due === null || timer.at < due.at) { due = timer; dueId = id }
        }
        if (due === null) break
        now = due.at
        if (due.repeat > 0) due.at = now + due.repeat
        else timers.delete(dueId)
        due.handler()
      }
      now = until
    },
    pending: () => timers.size,
  }
}

function matches(element, selector) {
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1))
  if (selector.startsWith('[')) return element.attrs[selector.slice(1, -1)] !== undefined
  return element.tagName === String(selector).toUpperCase()
}

function find(element, selector) {
  if (element === null || element === undefined) return null
  if (element.matches(selector)) return element
  for (const child of element.children) {
    const hit = find(child, selector)
    if (hit !== null) return hit
  }
  return null
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this.listeners = {}
    this.style = {}
    this.className = ''
    this.textContent = ''
    this.muted = false
    this.readyState = 0
    this.currentTime = 0
    this.duration = 8
    this.paused = true
    this.ended = false
    this.loop = false
    this.playsInline = false
    this.preload = ''
    this.src = ''
    this.error = null
    this.activation = { policy: 'allow', gesture: false }
  }

  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  replaceChild(next, old) {
    const index = this.children.indexOf(old)
    if (index >= 0) this.children[index] = next
    next.parentNode = this
    old.parentNode = null
    return old
  }
  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    node.parentNode = null
    return node
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler) }
  removeEventListener() {}
  dispatch(type, event) {
    if (type === 'pointerdown') this.activation.gesture = true
    for (const handler of this.listeners[type] ?? []) handler(event ?? {})
  }
  matches(selector) { return matches(this, selector) }
  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }
  querySelector(selector) { return find(this, selector) }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 } }
  play() {
    const { policy, gesture } = this.activation
    const refused = this.muted === false && (policy === 'refuse-always' || (policy === 'refuse-unmuted' && !gesture))
    if (refused) {
      return Promise.reject(Object.assign(new Error('play() failed'), { name: 'NotAllowedError' }))
    }
    this.paused = false
    return Promise.resolve()
  }
  pause() { this.paused = true }
  requestVideoFrameCallback(handler) { this.frameHandler = handler }
}

function mount(cfg) {
  const activation = { policy: 'allow', gesture: false }
  const make = (tag) => {
    const element = new Element(tag)
    element.activation = activation
    return element
  }
  const doc = {
    head: make('head'),
    body: make('body'),
    documentElement: make('html'),
    createElement: (tag) => make(tag),
    querySelector: (selector) => find(doc.body, selector),
    getElementById: () => null,
    addEventListener: () => {},
  }
  const clock = makeClock()
  const sandbox = {
    __DSH_BOOT_ANIM_CFG__: {
      manifest: '/clips.json',
      holdMs: 15000,
      fadeMs: 2000,
      enterMode: 'tail',
      sound: false,
      clickToEnter: false,
      showHint: true,
      ...cfg,
    },
    document: doc,
    location: { search: '' },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    Date: { now: clock.now, ...Date },
    fetch: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        clips: [{ name: 'clip.mp4', src: '/clip/clip.mp4', enabled: true }],
      }),
    }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clear,
    setInterval: clock.setInterval,
    clearInterval: clock.clear,
    addEventListener: () => {},
    console,
  }
  createContext(sandbox)
  runInContext(SCREEN, sandbox, { filename: 'boot-screen.js' })
  return { sandbox, doc, clock }
}

async function settle() {
  for (let turn = 0; turn < 60; turn++) await Promise.resolve()
}

const videoOf = (bundle) => find(bundle.doc.body, 'video')
const stateOf = (bundle) => bundle.sandbox.__DSH_BOOT_ANIM__.el.getAttribute('data-state')

console.log('\nsource: ' + SCREEN_PATH.replace(root + '/', ''))

// ---------------------------------------------------------------------------
console.log('\n[1] a clip that paints a frame and then wedges is released')
// ---------------------------------------------------------------------------
// Sound is off so the audio policy stays out of it, and the kernel is not told the
// boot finished — the scenario that matters is the one where it HAS: the hold timer
// returns on `bootedAt !== null`, so a ready kernel is exactly what leaves the
// screen with no bound at all.
const stuck = mount({})
await settle()

const clip = videoOf(stuck)
check('the clip is mounted and started', clip !== undefined && clip.src === '/clip/clip.mp4')
check('it is playing before it wedges', clip !== undefined && clip.paused === false)

// The first frame arrives: readyState >= 2 is what `whenFramePresents` waits for.
clip.readyState = 4
clip.dispatch('loadeddata')
check('the frame was revealed', clip.style.opacity === '1', 'opacity ' + clip.style.opacity)
check('the screen is still up right after the frame', stateOf(stuck) === 'idle', stateOf(stuck))

// Seven seconds of a clock that runs, with media time frozen. This is the wedge:
// `timeupdate` never fires again, `ended` never fires, `currentTime` stays put.
stuck.clock.advance(7000)
check(
  'seven seconds later the screen has let the app in',
  stateOf(stuck) === 'leaving',
  'data-state=' + stateOf(stuck),
)

// ---------------------------------------------------------------------------
console.log('\n[2] a clip that keeps advancing is left alone')
// ---------------------------------------------------------------------------
const playing = mount({})
await settle()
const live = videoOf(playing)
live.readyState = 4
live.dispatch('loadeddata')
// Eight seconds of playback, heart-beating the way a playing element does.
for (let tick = 0; tick < 8; tick++) {
  playing.clock.advance(1000)
  live.currentTime += 1
  live.dispatch('timeupdate')
}
check(
  'a clip that is genuinely progressing was not cut off',
  stateOf(playing) === 'idle',
  'data-state=' + stateOf(playing),
)
check('and it never fired ended on its own', live.ended === false)

// ---------------------------------------------------------------------------
console.log('\n[3] the watchdog is stopped on the way out')
// ---------------------------------------------------------------------------
const leaving = mount({})
await settle()
const done = videoOf(leaving)
const overlayRoot = leaving.sandbox.__DSH_BOOT_ANIM__.el
done.readyState = 4
done.dispatch('loadeddata')
leaving.clock.advance(3000)
// The press listener is on the overlay root, not on the video.
overlayRoot.dispatch('pointerdown', { target: overlayRoot })
check('the press entered', stateOf(leaving) === 'leaving', stateOf(leaving))
// Well past the limit. If the watchdog outlived the exit it would keep a one-second
// timer alive on a screen that is already gone.
leaving.clock.advance(60000)
check('nothing re-entered or threw afterwards', stateOf(leaving) === 'leaving')

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + checks + ' checks, ' + failures + ' failed')
process.exitCode = failures === 0 ? 0 : 1
