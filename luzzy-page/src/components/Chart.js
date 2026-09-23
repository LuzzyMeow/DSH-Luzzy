/* Chart —— 活动阵列、模型趋势、悬停浮窗、模型用量。
 *
 * 整体从原 src/client.js 原样搬来，一行未改。它承载的都是**验证过的几何与交互性质**：
 *
 *   平滑曲线用 Fritsch–Carlson 单调插值，不是 Catmull-Rom
 *     Catmull-Rom 会过冲，对非负数据意味着曲线画到零轴以下——日视图真的画出过负 token。
 *     单调插值保证曲线落在数据自己的范围内。tools/test-chart-path.mjs 按 t 采样贝塞尔
 *     断言这件事，因为截图不一定看得出来。
 *
 *   未来时段是 null，曲线在那里**断开**，不是画 0
 *     画 0 会凭空造出一段掉到轴上的塌方；活动阵列里未来的格子是空心而非填色。
 *
 *   悬停浮窗贴边时自动翻到另一侧，且键盘可达（左右方向键走格）
 *
 *   入场动画只在图表身份真的变了时挂上，且属性用定时器摘掉
 *     用 animationend 不行：prefers-reduced-motion 下动画是 none，那个事件永不触发，
 *     属性会被永久卡住。 */
(function (LZ) {
  'use strict'

  // The chart code was written when these were frame globals. Inside its own module they have
  // to be bound explicitly — and the two the axis maths needs (niceMax for the ceiling, esc for
  // the labels) are the ones easiest to forget: a missing binding is a ReferenceError at RENDER
  // time, not at load time, so the page mounts and then throws.
  //
  // (This comment originally quoted the identifiers in backticks. That is inside a template
  // literal, so it terminated the string — the same mistake recorded in AGENTS.md §5.6, made
  // again in a comment explaining the code.)
  const esc = LZ.Format.esc
  const formatTokens = LZ.Format.formatTokens
  const niceMax = LZ.Format.niceMax
  const COLORS = LZ.Format.COLORS

const CHART = { W: 720, H: 220, PL: 56, PR: 16, PT: 16, PB: 30, PB_WIDE: 42 }

function smoothPath(points) {
  if (points.length === 0) return ''
  if (points.length === 1) return 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
  if (points.length === 2) {
    return 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1) +
      ' L' + points[1].x.toFixed(1) + ',' + points[1].y.toFixed(1)
  }

  const n = points.length

  // Secant slopes between consecutive points. The x spacing is uniform here (the slots are
  // evenly spread), so dx is a constant, but the slope still uses the real dx.
  const dx = []
  const slope = []
  for (let i = 0; i < n - 1; i += 1) {
    const run = points[i + 1].x - points[i].x
    dx.push(run)
    slope.push(run === 0 ? 0 : (points[i + 1].y - points[i].y) / run)
  }

  // Initial tangents: the average of the neighbouring secants.
  const tangent = new Array(n)
  tangent[0] = slope[0]
  tangent[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      // A local extremum: flatten the tangent, or the curve would bulge past the point.
      tangent[i] = 0
    } else {
      tangent[i] = (slope[i - 1] + slope[i]) / 2
    }
  }

  // Fritsch–Carlson: shrink any tangent that would let the cubic overshoot its interval.
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const alpha = tangent[i] / slope[i]
    const beta = tangent[i + 1] / slope[i]
    const magnitude = alpha * alpha + beta * beta
    if (magnitude > 9) {
      const tau = 3 / Math.sqrt(magnitude)
      tangent[i] = tau * alpha * slope[i]
      tangent[i + 1] = tau * beta * slope[i]
    }
  }

  let d = 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3
    const c1x = points[i].x + third
    const c1y = points[i].y + tangent[i] * third
    const c2x = points[i + 1].x - third
    const c2y = points[i + 1].y - tangent[i + 1] * third
    d += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) +
      ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1) +
      ' ' + points[i + 1].x.toFixed(1) + ',' + points[i + 1].y.toFixed(1)
  }
  return d
}

function trendChart(series, slots, mode, animate) {
  const W = CHART.W, H = CHART.H, PL = CHART.PL, PR = CHART.PR, PT = CHART.PT
  // The month window labels two lines (week number + date span), so it needs a deeper
  // bottom gutter; the others label one line. Sized here rather than in the constant so the
  // hover layer and the drawing code still share one source of truth for the plot area.
  const PB = slots.some((s) => s.range !== undefined) ? CHART.PB_WIDE : CHART.PB
  const pw = W - PL - PR, ph = H - PT - PB

  const slotCount = slots.length
  const xAt = (index) => (slotCount === 1 ? PL + pw / 2 : PL + (index / (slotCount - 1)) * pw)

  // Scale to the data that exists; future slots are null and must not affect the axis.
  let peak = 0
  for (const s of series) {
    for (const v of s.values) {
      if (typeof v === 'number' && isFinite(v) && v > peak) peak = v
    }
  }
  const max = niceMax(peak)
  const yAt = (v) => PT + ph - (v / max) * ph

  const grid = [0, max / 2, max].map((v) => {
    const y = yAt(v)
    return '<line class="chartGrid" x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>' +
      '<text class="chartAxis" x="' + (PL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + formatTokens(v) + '</text>'
  }).join('')

  // Split each series at its null slots so a gap is a gap. In bar mode a null slot simply
  // draws no bar, which needs no splitting.
  const shapes = series.map((s, seriesIndex) => {
    const color = COLORS[seriesIndex % COLORS.length]
    const runs = []
    let run = []
    for (let i = 0; i < slotCount; i += 1) {
      const v = s.values[i]
      if (typeof v === 'number' && isFinite(v)) run.push({ x: xAt(i), y: yAt(v), i: i })
      else if (run.length > 0) { runs.push(run); run = [] }
    }
    if (run.length > 0) runs.push(run)

    if (mode === 'bar') {
      // Grouped bars: each model gets a slice of the slot, so models sit side by side
      // instead of covering each other. With many models the slice gets thin, which is
      // why the count is capped before this point.
      const groupCount = Math.max(series.length, 1)
      const slotWidth = slotCount === 1 ? pw : pw / slotCount
      const barW = Math.max(1.5, Math.min(14, (slotWidth * 0.7) / groupCount))
      const offset = (seriesIndex - (groupCount - 1) / 2) * barW
      return slots.map((slot, i) => {
        const v = s.values[i]
        if (slot.isFuture || typeof v !== 'number' || !isFinite(v) || v <= 0) return ''
        const x = xAt(i) + offset
        const y = yAt(v)
        return '<rect x="' + (x - barW / 2).toFixed(1) + '" y="' + y.toFixed(1) +
          '" width="' + barW.toFixed(1) + '" height="' + Math.max(0, PT + ph - y).toFixed(1) +
          '" rx="1.5" fill="' + color + '"/>'
      }).join('')
    }

    return runs.map((points) => {
      const d = smoothPath(points)
      // Dots carry the slot index so the hover layer can highlight the exact point the
      // pointer is nearest, rather than only the column.
      const dots = points.map((p) =>
        '<circle class="chartDot" data-dot="' + p.i + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
        '" r="2.5" fill="' + color + '"/>').join('')
      // The area fill is only honest for a single-series chart: stacking translucent fills
      // per model turns the plot into mud. With one model it reads as emphasis.
      const area = series.length === 1 && points.length > 1
        ? '<path d="' + d + ' L' + points[points.length - 1].x.toFixed(1) + ',' + (PT + ph) +
          ' L' + points[0].x.toFixed(1) + ',' + (PT + ph) + ' Z" fill="' + color + '" opacity="0.12"/>'
        : ''
      return area + '<path d="' + d + '" fill="none" stroke="' + color +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' + dots
    }).join('')
  }).join('')

  // Label every slot when they are few, otherwise thin them out evenly. The last label is
  // always kept so the axis ends on a real value rather than an arbitrary interior one.
  //
  // A slot carrying a date range (the month window's natural weeks) shows the week number
  // with its date span underneath, e.g. 第1周 / 8.31 - 9.6 — without the dates a 第1周 that
  // happens to start in the previous month is unreadable.
  const everyN = Math.max(1, Math.ceil(slotCount / 8))
  const labels = slots.map((slot, i) => {
    if (i % everyN !== 0 && i !== slotCount - 1) return ''
    const x = xAt(i).toFixed(1)
    const main = '<text class="chartAxis" x="' + x + '" y="' + (H - (slot.range === undefined ? 10 : 18)) +
      '" text-anchor="middle">' + esc(slot.label) + '</text>'
    if (slot.range === undefined) return main
    return main + '<text class="chartAxis chartAxisSub" x="' + x + '" y="' + (H - 6) +
      '" text-anchor="middle">' + esc(slot.range) + '</text>'
  }).join('')

  // ---- hover layer
  //
  // One invisible rect per slot spanning the full plot height. Columns (not points) are the
  // hit target: a 2.5px dot is unhittable, and every model in a slot shares the same x, so
  // the column is the only sensible unit. The pointer-events rule is required because a
  // transparent fill would otherwise not receive the pointer.
  const step = slotCount > 1 ? pw / (slotCount - 1) : pw
  const half = step / 2
  const hits = slots.map((slot, i) => {
    const left = Math.max(PL, xAt(i) - half)
    const right = Math.min(W - PR, xAt(i) + half)
    return '<rect class="chartHit" data-slot="' + i + '" x="' + left.toFixed(1) + '" y="' + PT +
      '" width="' + Math.max(1, right - left).toFixed(1) + '" height="' + ph + '" fill="transparent"/>'
  }).join('')

  // The guide line and the highlighted dots are moved by JS on hover; the line starts
  // hidden so it never flashes at x=0 before the first pointer event.
  const guide =
    '<line class="chartGuide" x1="0" x2="0" y1="' + PT + '" y2="' + (PT + ph) + '" style="display:none"/>'

  const legend = series.map((s, i) =>
    '<span class="chartLegendItem"><span class="chartSwatch" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
    '<span class="chartLegendName">' + esc(s.key) + '</span>' +
    '<span class="chartLegendValue">' + formatTokens(s.windowTotal) + '</span></span>').join('')

  return '<div class="chartWrap" data-chart' + (animate ? ' data-animate' : '') + '>' +
    '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
    '<g>' + grid + '</g><g>' + guide + '</g><g>' + shapes + '</g><g>' + labels + '</g>' +
    '<g class="chartHits">' + hits + '</g>' +
    '</svg>' +
    '<div class="chartTip" role="tooltip" hidden></div>' +
    '</div>' +
    (series.length > 0 ? '<div class="chartLegend">' + legend + '</div>' : '')
}

function chartTipHtml(slots, series, index) {
  const slot = slots[index]
  if (slot === undefined) return ''

  const rows = series
    .map((s, i) => ({ key: s.key, value: s.values[index], color: COLORS[i % COLORS.length] }))
    .filter((r) => typeof r.value === 'number' && isFinite(r.value) && r.value > 0)
    .sort((a, b) => b.value - a.value)

  const total = rows.reduce((sum, r) => sum + r.value, 0)

  // The month window's slots name a date span (which may cross a month edge), so the header
  // shows both the week number and the dates.
  const title = slot.range === undefined ? slot.label : slot.label + ' · ' + slot.range

  if (rows.length === 0) {
    return '<div class="chartTipHead"><span class="chartTipTitle">' + esc(title) + '</span>' +
      '<span class="chartTipTotal">无用量</span></div>'
  }

  return '<div class="chartTipHead"><span class="chartTipTitle">' + esc(title) + '</span>' +
    '<span class="chartTipTotal">' + formatTokens(total) + ' tokens</span></div>' +
    '<div class="chartTipRows">' +
    rows.map((r) =>
      '<div class="chartTipRow">' +
      '<span class="chartSwatch" style="background:' + r.color + '"></span>' +
      '<span class="chartTipName">' + esc(r.key) + '</span>' +
      '<span class="chartTipValue">' + formatTokens(r.value) + '</span>' +
      '</div>').join('') +
    '</div>'
}

function wireChartHover(root, slots, series) {
  const svg = root.querySelector('svg.chart')
  const tip = root.querySelector('.chartTip')
  const guide = root.querySelector('.chartGuide')
  if (svg === null || tip === null) return

  const dots = Array.prototype.slice.call(svg.querySelectorAll('.chartDot'))
  const hits = Array.prototype.slice.call(svg.querySelectorAll('.chartHit'))
  let shownFor = -1

  const show = (index, clientX, clientY) => {
    if (index === shownFor) {
      // Same column: only the tooltip's position needs to follow the pointer.
      if (clientX !== undefined) position(clientX, clientY)
      return
    }
    shownFor = index
    tip.innerHTML = chartTipHtml(slots, series, index)
    tip.hidden = false

    // Guide line + enlarged dots at this column.
    const x = hits[index] === undefined ? 0 : Number(hits[index].getAttribute('x')) +
      Number(hits[index].getAttribute('width')) / 2
    guide.setAttribute('x1', String(x))
    guide.setAttribute('x2', String(x))
    guide.style.display = ''
    dots.forEach((dot) => {
      const active = Number(dot.getAttribute('data-dot')) === index
      dot.setAttribute('r', active ? '4' : '2.5')
    })
    if (clientX !== undefined) position(clientX, clientY)
  }

  /**
   * Place the tooltip near the pointer, clamped to the chart box.
   *
   * Clamping matters: without it the panel runs off the right edge on the last slots and off
   * the top on tall peaks, which is exactly where a user is most likely to be looking.
   */
  const position = (clientX, clientY) => {
    const box = root.getBoundingClientRect()
    const x = clientX - box.left
    const y = clientY - box.top
    // Measure after the content is set; the hidden attribute must be off for the size to
    // be real.
    const tw = tip.offsetWidth
    const th = tip.offsetHeight
    let left = x + 14
    let top = y - th - 12
    if (left + tw > box.width - 4) left = x - tw - 14
    if (left < 4) left = 4
    if (top < 0) top = y + 16
    if (top + th > box.height) top = Math.max(0, box.height - th)
    tip.style.left = left + 'px'
    tip.style.top = top + 'px'
  }

  const hide = () => {
    if (shownFor === -1) return
    shownFor = -1
    tip.hidden = true
    guide.style.display = 'none'
    dots.forEach((dot) => dot.setAttribute('r', '2.5'))
  }

  hits.forEach((hit) => {
    const index = Number(hit.getAttribute('data-slot'))
    hit.addEventListener('mouseenter', (event) => show(index, event.clientX, event.clientY))
    hit.addEventListener('mousemove', (event) => show(index, event.clientX, event.clientY))
  })
  svg.addEventListener('mouseleave', hide)
  // Keyboard access: focusing the chart and using arrow keys walks the slots. Without this
  // the values are unreachable without a mouse, which the reference design does not solve
  // but this page should.
  root.setAttribute('tabindex', '0')
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const count = slots.length
    if (count === 0) return
    event.preventDefault()
    const next = shownFor === -1
      ? 0
      : Math.min(count - 1, Math.max(0, shownFor + (event.key === 'ArrowRight' ? 1 : -1)))
    const hit = hits[next]
    if (hit === undefined) return
    const box = root.getBoundingClientRect()
    const svgBox = svg.getBoundingClientRect()
    // Convert the hit column's viewBox x into a client x for positioning.
    const viewX = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2
    const clientX = svgBox.left + (viewX / CHART.W) * svgBox.width
    show(next, clientX, box.top + box.height / 2)
  })
  root.addEventListener('blur', hide)
}

function modelDonut(models) {
  const SIZE = 200, STROKE = 26, R = (SIZE - STROKE) / 2, C = SIZE / 2, CIRC = 2 * Math.PI * R
  let series = models.slice(0, 7).map((m) => ({ key: m.key, totalTokens: m.totalTokens }))
  if (models.length > 7) {
    const tail = models.slice(7).reduce((s, m) => s + (m.totalTokens || 0), 0)
    if (tail > 0) series.push({ key: '__other__', totalTokens: tail })
  }
  const total = series.reduce((s, m) => s + (m.totalTokens || 0), 0)
  let offset = 0
  const arcs = series.map((m, idx) => {
    const share = total > 0 ? m.totalTokens / total : 0
    const len = share * CIRC
    const arc = { key: m.key, share: share, len: len, offset: offset, color: COLORS[idx % COLORS.length] }
    offset += len
    return arc
  })
  const rings = arcs.map((a) =>
    '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" stroke="' + a.color + '" stroke-width="' + STROKE +
    '" stroke-dasharray="' + a.len + ' ' + (CIRC - a.len) + '" stroke-dashoffset="' + (-a.offset) + '"/>').join('')
  const rows = arcs.map((a) =>
    '<div class="modelRow"><span class="modelSwatch" style="background:' + a.color + '"></span>' +
    '<span class="modelName">' + esc(a.key === '__other__' ? '其他模型' : a.key) + '</span>' +
    '<span class="modelValue">' + formatTokens(series.find((x) => x.key === a.key).totalTokens || 0) + '</span>' +
    '<span class="modelShare">' + (a.share * 100).toFixed(1) + '%</span></div>').join('')

  return '<div class="models"><div class="donutWrap">' +
    '<svg width="' + SIZE + '" height="' + SIZE + '" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" role="img">' +
    '<g transform="rotate(-90 ' + C + ' ' + C + ')">' + rings + '</g></svg>' +
    '<div class="donutCenter"><span class="donutTotal">' + formatTokens(total) + '</span><span class="donutCaption">tokens</span></div>' +
    '</div><div class="modelList">' + rows + '</div></div>'
}

  LZ.Chart = {
    W: CHART.W,
    H: CHART.H,
    smoothPath: smoothPath,
    trend: trendChart,
    tipHtml: chartTipHtml,
    wireHover: wireChartHover,
    modelRows: modelDonut,
  }
})(window.LZ = window.LZ || {})
