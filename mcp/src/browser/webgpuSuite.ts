/**
 * Scrape the finished suite from the DOM. The page's Accordion keeps panel
 * content mounted but a never-opened item renders empty, so controls without
 * table rows are clicked first and the open animation is waited out. Row
 * layout mirrors WebgpuTab.tsx:110-147: [icon, Stat, CPU, GPU, Delta,
 * Precision]; the test-level status icon lives in the Accordion control
 * (TestIcon, WebgpuTab.tsx:151-168).
 */
export const scrapeWebgpuSuite = (async () => {
  const items = Array.from(document.querySelectorAll('[data-webgpu-test]'))
  if (items.length === 0) throw new Error('WebGPU test results not found; rebuild the site with npm run build')
  for (const item of items) {
    if (item.querySelectorAll('tbody tr').length === 0) {
      const control = item.querySelector<HTMLElement>('.mantine-Accordion-control')
      control?.click()
    }
  }
  if (items.some((i) => i.querySelectorAll('tbody tr').length === 0)) {
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
  const svgClass = (el: Element | null | undefined) => el?.querySelector('svg')?.getAttribute('class') ?? ''
  return items.map((item) => {
    const control = item.querySelector('.mantine-Accordion-control')
    // The control's FIRST svg is Mantine's chevron — match the status icon by
    // its tabler class specifically (TestIcon's IconCircleCheckFilled /
    // IconCircleXFilled / IconQuestionMark, WebgpuTab.tsx:151-168).
    const controlClass = control
      ?.querySelector('svg[class*="circle-check-filled"], svg[class*="circle-x-filled"], svg[class*="question-mark"]')
      ?.getAttribute('class') ?? svgClass(control)
    const status = controlClass.includes('circle-check-filled')
      ? 'passed'
      : controlClass.includes('circle-x-filled')
      ? 'failed'
      : 'incomplete'
    const rows = Array.from(item.querySelectorAll('tbody tr')).map((tr) => {
      const tds = tr.querySelectorAll('td')
      return {
        stat: (tds[1]?.textContent ?? '').trim(),
        cpu: (tds[2]?.textContent ?? '').trim(),
        gpu: (tds[3]?.textContent ?? '').trim(),
        delta: (tds[4]?.textContent ?? '').trim(),
        precision: Number((tds[5]?.textContent ?? '').trim()) || 0,
        pass: !!tr.querySelector('svg[class*="circle-check-filled"]'),
      }
    })
    return { name: (control?.textContent ?? '').trim(), status, rows }
  })
}) as unknown as () => Promise<Array<{ name: string, status: string, rows: Array<Record<string, unknown>> }>>

/** Snapshot of the page's own run-state markers (button text + data-loading +
 * rendered item count) — polled while the suite executes. */
export const webgpuButtonState = (() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '').includes('WebGPU tests') || (b.textContent ?? '').includes('Tests complete'))
  return {
    done: (btn?.textContent ?? '').includes('Tests complete'),
    running: btn?.getAttribute('data-loading') === 'true',
    items: document.querySelectorAll('[data-webgpu-test]').length,
  }
}) as unknown as () => Record<string, unknown>
