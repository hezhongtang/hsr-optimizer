import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'
import {
  scrapeWebgpuSuite,
  webgpuButtonState,
} from '../src/browser/webgpuSuite.ts'

const item = (name, icon, rows = '') =>
  `<div class="mantine-Accordion-item" data-webgpu-test>
  <button class="mantine-Accordion-control"><svg class="chevron"></svg><svg class="tabler-icon-${icon}"></svg>${name}</button>
  <table><tbody>${rows}</tbody></table>
</div>`
const row = '<tr><td><svg class="tabler-icon-circle-check-filled"></svg></td><td>ATK</td><td>1</td><td>1</td><td>0</td><td>0.01</td></tr>'
const dom = new JSDOM(`<div class="mantine-Accordion-item"><button class="mantine-Accordion-control">Teammates</button></div>
  <button>Tests complete</button>
  ${item('#1 — passed', 'circle-check-filled', row)}
  ${item('#2 — failed', 'circle-x-filled', row)}
  ${item('#3 — pending', 'question-mark')}`)
globalThis.document = dom.window.document
let settingsClicks = 0
document.querySelector('.mantine-Accordion-control').addEventListener('click', () => settingsClicks++)

try {
  const suite = await scrapeWebgpuSuite()
  assert.deepEqual(suite.map((t) => [t.name, t.status]), [
    ['#1 — passed', 'passed'],
    ['#2 — failed', 'failed'],
    ['#3 — pending', 'incomplete'],
  ], 'settings panels must not become incomplete test cases')
  assert.equal(settingsClicks, 0, 'scraping must not open unrelated settings')
  assert.equal(webgpuButtonState().items, 3, 'run-state item count must match the test suite')
  assert.deepEqual(suite[0].rows, [{ stat: 'ATK', cpu: '1', gpu: '1', delta: '0', precision: 0.01, pass: true }])
  document.body.innerHTML = '<button>Tests complete</button>'
  await assert.rejects(scrapeWebgpuSuite, /rebuild the site/, 'a stale site build must not report an empty successful suite')
  console.log('[PASS] WebGPU suite excludes settings and preserves statuses/deltas')
} finally {
  delete globalThis.document
  dom.window.close()
}
