/**
 * 划词「添加到对话」工具条。
 *
 * 投放环境常见坑：
 * - 有 PointerEvent 构造函数，但实际不派发 pointer 事件
 * - 没有 getComposedRanges / composedPath（Chrome < 105）
 * - instanceof Element / ShadowRoot 跨 iframe、Qt WebEngine 会失败
 * - mouseup 时 getSelection() 仍为空，要延时再读
 * - 误信 selection.isCollapsed，老 WebKit 会把有效选区标成 collapsed
 * - Range 无法跨越 Shadow 边界时，要用 caret 点自己拼文本
 */
import { onMounted, onUnmounted, ref, type Ref } from 'vue'

export interface SelectionAskPayload {
  /** 选中的纯文本 */
  text: string
  /** 工具条锚点矩形（视口坐标） */
  rect: DOMRect
  range?: Range
  anchorNode?: Node
}

interface MonacoLikeEditor {
  getDomNode?: () => HTMLElement | null
  getSelection?: () => {
    isEmpty: () => boolean
    getStartPosition: () => unknown
    getEndPosition?: () => unknown
  } | null
  getModel?: () => {
    getValueInRange: (selection: unknown) => string
  } | null
  getScrolledVisiblePosition?: (position: unknown) => {
    left: number
    top: number
    height?: number
  } | null
}

interface MonacoGlobal {
  editor?: {
    getEditors?: () => MonacoLikeEditor[]
    getDiffEditors?: () => Array<{
      getModifiedEditor?: () => MonacoLikeEditor
      getOriginalEditor?: () => MonacoLikeEditor
    }>
  }
}

interface CaretPoint {
  offsetNode: Node
  offset: number
}

interface StreamDiffsDrag {
  shadows: ShadowRoot[]
  start: CaretPoint | null
}

/** 按下时的视口坐标，松手后用来拼 Range（不依赖 PointerEvent） */
let pointerAnchor: { x: number; y: number } | null = null
/** 最近一次按下/移动/抬起的坐标，仅在框选落点时用来校正锚点 */
let pointerLatest: { x: number; y: number } | null = null
/** 为 true 时才允许把锚点钉到指针；滚动跟随选区时必须关掉 */
let pinToolbarToPointer = false

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const DOCUMENT_FRAGMENT_NODE = 11
/** 选区晚于 mouseup 出现时的重试间隔（ms） */
const SELECTION_RETRY_MS = [0, 16, 32, 80, 160]

type ComposedSelection = Selection & {
  getComposedRanges?: (options?: { shadowRoots?: ShadowRoot[] }) => StaticRange[]
}

type CaretPositionFromPoint = (
  x: number,
  y: number,
  options?: { shadowRoots?: ShadowRoot[] },
) => CaretPoint | null

type LegacyDocSelection = {
  type?: string
  createRange: () => {
    text?: string
    htmlText?: string
    boundingLeft?: number
    boundingTop?: number
    boundingWidth?: number
    boundingHeight?: number
    getBoundingClientRect?: () => { left: number; top: number; width: number; height: number }
    parentElement?: () => Element | null
  }
}

/** nodeType === 1，避免 instanceof Element 跨文档失败 */
function isElement(node: EventTarget | Node | null | undefined): node is Element {
  return !!node && (node as Node).nodeType === ELEMENT_NODE
}

/** 能取 getBoundingClientRect 的元素 */
function isHtmlElement(node: Node | null | undefined): node is HTMLElement {
  return isElement(node) && typeof (node as HTMLElement).getBoundingClientRect === 'function'
}

/** 不用 instanceof ShadowRoot，避免跨 realm / 无 ShadowRoot 全局时全部判失败 */
function isShadowRoot(node: EventTarget | Node | null | undefined): node is ShadowRoot {
  if (!node || (node as Node).nodeType !== DOCUMENT_FRAGMENT_NODE) return false
  return isElement((node as ShadowRoot).host)
}

/** classList.contains 不可用时退回 className 字符串匹配 */
function hasClass(el: Element, className: string) {
  const list = el.classList
  if (list && typeof list.contains === 'function') return list.contains(className)
  const raw: unknown = el.className
  let cn = ''
  if (typeof raw === 'string') cn = raw
  else if (raw && typeof raw === 'object' && 'baseVal' in (raw as { baseVal?: string })) {
    cn = String((raw as { baseVal?: string }).baseVal || '')
  }
  return (' ' + cn + ' ').indexOf(' ' + className + ' ') !== -1
}

/** 含 Shadow host 的父节点 */
function parentOf(node: Node): Node | null {
  if (node.parentNode) return node.parentNode
  const root = getRootNodeCompat(node)
  if (isShadowRoot(root) && root !== node) return root.host
  return null
}

/** composedPath → event.path → 沿 parent/host 上溯 */
function eventPath(event: Event): EventTarget[] {
  if (typeof (event as Event & { composedPath?: () => EventTarget[] }).composedPath === 'function') {
    try {
      const path = event.composedPath()
      if (path && path.length) return path
    } catch {
      // ignore
    }
  }
  const legacy = (event as Event & { path?: EventTarget[] }).path
  if (legacy && legacy.length) return legacy
  const path: EventTarget[] = []
  let node: Node | null = (event.target as Node) || null
  while (node) {
    path.push(node)
    const root = getRootNodeCompat(node)
    if (isShadowRoot(root) && root !== node) {
      path.push(root)
      node = root.host
      continue
    }
    node = node.parentNode
  }
  if (typeof document !== 'undefined') path.push(document)
  if (typeof window !== 'undefined') path.push(window)
  return path
}

function uniqueItems<T>(list: T[]): T[] {
  const out: T[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (item && out.indexOf(item) === -1) out.push(item)
  }
  return out
}

/** 事件路径是否经过目标节点 */
function pathIncludes(event: Event, target: Node | null) {
  if (!target) return false
  const path = eventPath(event)
  for (let i = 0; i < path.length; i++) {
    if (path[i] === target) return true
  }
  return false
}

/** getRootNode 不存在时走到最顶 parentNode */
function getRootNodeCompat(node: Node): Node {
  if (typeof (node as Node & { getRootNode?: () => Node }).getRootNode === 'function') {
    try {
      return node.getRootNode()
    } catch {
      // ignore
    }
  }
  let current: Node | null = node
  while (current.parentNode) current = current.parentNode
  return current
}

/** 向上找 class，穿过 Shadow host */
function closestClass(el: Element | null, className: string): Element | null {
  let current: Element | null = el
  while (current) {
    if (hasClass(current, className)) return current
    const parent = parentOf(current)
    if (isShadowRoot(parent)) {
      current = parent.host
      continue
    }
    current = isElement(parent) ? parent : null
  }
  return null
}

/** 无 DOMRect 构造函数时返回字面量 */
function createRect(left: number, top: number, width: number, height: number): DOMRect {
  const right = left + width
  const bottom = top + height
  if (typeof DOMRect === 'function') {
    try {
      return new DOMRect(left, top, width, height)
    } catch {
      // ignore
    }
  }
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right,
    bottom,
    toJSON() {
      return this
    },
  } as DOMRect
}

function toNodeList<T extends Element>(list: ArrayLike<T>): T[] {
  const result: T[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (item) result.push(item)
  }
  return result
}

/** 节点是否在问答根内（含打开的 Shadow） */
function isInsideRoot(root: HTMLElement, node: Node | null): boolean {
  let current: Node | null = node
  while (current) {
    if (current === root) return true
    if (isShadowRoot(current)) {
      current = current.host
      continue
    }
    if (isElement(current) && (root === current || (typeof root.contains === 'function' && root.contains(current)))) {
      return true
    }
    current = parentOf(current)
  }
  return false
}

/** stream-diffs 自定义元素表面 */
function isDiffsSurface(node: EventTarget | null): boolean {
  return (
    isElement(node) &&
    (hasClass(node, 'stream-diffs-surface') ||
      hasClass(node, 'diffs-surface') ||
      String(node.tagName || '').toLowerCase() === 'diffs-container')
  )
}

/** 坐标是否落在根矩形内（事件被改写 target 时用） */
function rememberPointer(xy: { x: number; y: number } | null) {
  if (!xy) return
  if (!pinToolbarToPointer) return
  pointerLatest = xy
}

function activePointer(): { x: number; y: number } | null {
  return pointerLatest || pointerAnchor
}

function pointInRoot(root: HTMLElement, event?: Event) {
  const xy = event ? eventClientXY(event) : activePointer()
  if (!xy) return false
  const rect = root.getBoundingClientRect()
  return xy.x >= rect.left && xy.x <= rect.right && xy.y >= rect.top && xy.y <= rect.bottom
}

function rectsFromClientRectList(list: ArrayLike<{ left: number; top: number; width: number; height: number }>): DOMRect[] {
  const rects: DOMRect[] = []
  for (let i = 0; i < list.length; i++) {
    const rect = list[i]
    if (rect && (rect.width > 0 || rect.height > 0)) rects.push(toDOMRect(rect))
  }
  return rects
}

/** 多块选区矩形时取离指针最近的一块，避免用到代码块顶部的第一段 */
function pickRectNearPointer(rects: DOMRect[]): DOMRect | null {
  if (!rects.length) return null
  const pt = pinToolbarToPointer ? activePointer() : null
  if (!pt) return unionRects(rects)
  let best: DOMRect | null = null
  let bestDist = Infinity
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r) continue
    const dx = r.left + r.width / 2 - pt.x
    const dy = r.top + r.height / 2 - pt.y
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      bestDist = dist
      best = r
    }
  }
  return best
}

/** 仅框选落点时校正；滚动时不要跟鼠标 */
function snapRectToPointer(rect: DOMRect | null): DOMRect | null {
  if (!pinToolbarToPointer) return rect
  const pt = activePointer()
  if (!rect) {
    return pt ? createRect(pt.x - 12, pt.y - 10, 24, 20) : null
  }
  if (!pt) return rect
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  if (Math.abs(cy - pt.y) > 36 || Math.abs(cx - pt.x) > 280) {
    const width = Math.min(Math.max(rect.width, 24), 160)
    const height = Math.min(Math.max(rect.height, 16), 22)
    return createRect(pt.x - width / 2, pt.y - height / 2, width, height)
  }
  return rect
}

/** 选区可见矩形：离指针最近的一块，而不是 getClientRects 的第一块 */
function firstVisibleRect(range: Range): DOMRect | null {
  try {
    const list = range.getClientRects ? range.getClientRects() : []
    const near = pickRectNearPointer(rectsFromClientRectList(list))
    if (near) return snapRectToPointer(near)
  } catch {
    // ignore
  }
  try {
    const fallback = range.getBoundingClientRect()
    if (fallback && (fallback.width || fallback.height)) return snapRectToPointer(toDOMRect(fallback))
  } catch {
    // ignore
  }
  const node = range.startContainer
  const el = node && node.nodeType === 1 ? (node as Element) : node.parentElement
  if (el && typeof el.getBoundingClientRect === 'function') {
    return snapRectToPointer(toDOMRect(el.getBoundingClientRect()))
  }
  return snapRectToPointer(null)
}

/** ClientRect 转 DOMRect 形态 */
function toDOMRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return createRect(rect.left, rect.top, rect.width, rect.height)
}

/** 两矩形相交 */
function intersectRects(a: DOMRect, b: DOMRect): DOMRect {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  return createRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top))
}

/** 视口矩形 */
function viewportRect() {
  return createRect(0, 0, window.innerWidth, window.innerHeight)
}

/** 可滚动 overflow */
function isScrollableOverflow(value: string) {
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

/** 沿祖先收集 overflow 裁剪盒 */
function getClipRect(node: Node | null): DOMRect {
  let clip = viewportRect()
  let current: Node | null = node
  while (current) {
    if (isHtmlElement(current)) {
      const style = window.getComputedStyle(current)
      if (isScrollableOverflow(style.overflowX) || isScrollableOverflow(style.overflowY)) {
        clip = intersectRects(clip, toDOMRect(current.getBoundingClientRect()))
      }
    }
    const root = getRootNodeCompat(current)
    if (isShadowRoot(root)) {
      current = root.host
      continue
    }
    current = isElement(current) ? current.parentElement : parentOf(current)
  }
  return clip
}

/** 优先用 Range 现算位置；代码块里 Range 首个 rect 常在顶部，要钉回指针 */
function livePayloadRect(payload: SelectionAskPayload): DOMRect | null {
  const host = monacoHostFromNode(payload.anchorNode) || monacoHostFromNode(payload.range?.commonAncestorContainer || null)
  if (host) {
    const overlay = monacoSelectionAnchorRect(host, payload.rect)
    if (overlay) return snapRectToPointer(overlay)
  }
  if (payload.range) {
    try {
      const rect = firstVisibleRect(payload.range)
      if (rect) return snapRectToPointer(rect)
    } catch {
      // range may be detached after DOM updates
    }
  }
  return snapRectToPointer(payload.rect)
}

/** 工具条锚点：选区与裁剪盒相交 */
function visibleAnchorRect(payload: SelectionAskPayload): DOMRect | null {
  const rect = livePayloadRect(payload)
  if (!rect) return null
  const used = snapRectToPointer(rect) || rect
  const anchorNode = payload.range?.commonAncestorContainer ?? payload.anchorNode ?? null
  const clip = getClipRect(anchorNode)
  const visibleRect = intersectRects(used, clip)
  if (visibleRect.width >= 4 && visibleRect.height >= 4) {
    return snapRectToPointer(visibleRect) || visibleRect
  }
  const viewportVisible = intersectRects(used, viewportRect())
  if (viewportVisible.width >= 4 && viewportVisible.height >= 4) {
    return snapRectToPointer(viewportVisible) || viewportVisible
  }
  if (used.width >= 1 || used.height >= 1) return used
  return null
}

/** Range → payload；cloneRange 失败则直接挂原 Range */
function payloadFromRange(range: Range, root: HTMLElement, looseRootCheck = false): SelectionAskPayload | null {
  const text = meaningfulText(range.toString())
  if (!text) return null
  if (
    !looseRootCheck &&
    !isInsideRoot(root, range.commonAncestorContainer) &&
    !isInCollectedShadow(range.commonAncestorContainer, root)
  ) {
    return null
  }
  const rect = firstVisibleRect(range)
  if (!rect) return null
  try {
    return { text, rect, range: range.cloneRange() }
  } catch {
    return { text, rect, range, anchorNode: range.commonAncestorContainer }
  }
}

/** 节点是否在 root 下的 Shadow 树里 */
function isInCollectedShadow(node: Node, lightRoot: HTMLElement): boolean {
  let current: Node | null = node
  while (current) {
    if (current === lightRoot) return true
    const root = getRootNodeCompat(current)
    if (isShadowRoot(root)) {
      current = root.host
      continue
    }
    break
  }
  return !!(current && isInsideRoot(lightRoot, current))
}

/** 只收集 open shadow（closed 的 shadowRoot 为 null） */
function collectShadowRoots(root: ParentNode): ShadowRoot[] {
  const shadows: ShadowRoot[] = []
  const visit = (node: ParentNode) => {
    const elements = 'querySelectorAll' in node ? node.querySelectorAll('*') : []
    for (const el of elements) {
      if (el.shadowRoot) {
        shadows.push(el.shadowRoot)
        visit(el.shadowRoot)
      }
    }
  }
  if (isElement(root) && root.shadowRoot) {
    shadows.push(root.shadowRoot)
    visit(root.shadowRoot)
  }
  visit(root)
  return shadows
}

/** 从事件路径收集 ShadowRoot */
function shadowsFromEvent(event: Event): ShadowRoot[] {
  const shadows: ShadowRoot[] = []
  const path = eventPath(event)
  for (let i = 0; i < path.length; i++) {
    const node = path[i]
    if (isShadowRoot(node as Node)) shadows.push(node as ShadowRoot)
  }
  return shadows
}

/** 去掉纯空白 */
function meaningfulText(value: string | null | undefined) {
  if (!value) return ''
  return String(value).replace(/\s+/g, '') ? String(value) : ''
}

/** 标准 Selection；不信任 isCollapsed */
function getSelectionFromSelectionObject(
  selection: Selection | null,
  root: HTMLElement,
  looseRootCheck = false,
): SelectionAskPayload | null {
  if (!selection) return null
  try {
    // 不要信 isCollapsed：部分 WebKit 会把仍有 rangeCount 的选区标成 collapsed
    if (!selection.rangeCount) {
      return getSelectionFromAnchorFocus(selection, root, looseRootCheck)
    }
    for (let i = 0; i < selection.rangeCount; i++) {
      let range: Range
      try {
        range = selection.getRangeAt(i)
      } catch {
        continue
      }
      const text = meaningfulText(range.toString()) || meaningfulText(selection.toString())
      if (!text) continue
      if (range.collapsed && selection.rangeCount === 1) {
        const fromAnchor = getSelectionFromAnchorFocus(selection, root, looseRootCheck)
        if (fromAnchor) return fromAnchor
      }
      if (range.collapsed) continue
      if (
        !looseRootCheck &&
        !isInsideRoot(root, range.commonAncestorContainer) &&
        !isInCollectedShadow(range.commonAncestorContainer, root)
      ) {
        continue
      }
      const rect = firstVisibleRect(range)
      if (!rect) continue
      try {
        return { text, rect, range: range.cloneRange() }
      } catch {
        return { text, rect, range }
      }
    }
    return (
      getSelectionFromAnchorFocus(selection, root, looseRootCheck) ||
      getSelectionFromToString(selection, root, looseRootCheck)
    )
  } catch {
    return getSelectionFromToString(selection, root, looseRootCheck)
  }
}

/** createRange 可能抛错或根本没有 */
function tryCreateRange(aNode: Node, aOff: number, bNode: Node, bOff: number): Range | null {
  if (typeof document.createRange !== 'function') return null
  try {
    const range = document.createRange()
    range.setStart(aNode, aOff)
    range.setEnd(bNode, bOff)
    if (!range.collapsed) return range
    range.setStart(bNode, bOff)
    range.setEnd(aNode, aOff)
    return range.collapsed ? null : range
  } catch {
    return null
  }
}

/** 节点或按下点的矩形 */
function rectFromNode(node: Node | null): DOMRect | null {
  if (!node) return null
  const el = isElement(node) ? node : node.parentElement
  if (el && typeof el.getBoundingClientRect === 'function') {
    return toDOMRect(el.getBoundingClientRect())
  }
  return pointerAnchor ? createRect(pointerAnchor.x, pointerAnchor.y, 8, 18) : null
}

/** rangeCount 为 0 时，用 anchor/focus 手工建 Range */
function getSelectionFromAnchorFocus(
  selection: Selection,
  root: HTMLElement,
  looseRootCheck: boolean,
): SelectionAskPayload | null {
  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if (!anchor || !focus) return null
  if (anchor === focus && selection.anchorOffset === selection.focusOffset) return null
  const range = tryCreateRange(anchor, selection.anchorOffset, focus, selection.focusOffset)
  if (range) return payloadFromRange(range, root, looseRootCheck)
  const text = meaningfulText(selection.toString())
  if (!text) return null
  if (!looseRootCheck && !isInsideRoot(root, focus) && !isInsideRoot(root, anchor)) return null
  const rect = rectFromNode(focus) || rectFromNode(anchor)
  if (!rect) return null
  return { text, rect, anchorNode: focus }
}

/** 只拿到 toString、拿不到 Range 的内核 */
function getSelectionFromToString(
  selection: Selection | null,
  root: HTMLElement,
  looseRootCheck: boolean,
): SelectionAskPayload | null {
  if (!selection) return null
  const text = meaningfulText(selection.toString())
  if (!text) return null
  const node = selection.focusNode || selection.anchorNode
  if (!node) return null
  if (!looseRootCheck && !isInsideRoot(root, node) && !isInCollectedShadow(node, root)) return null
  const rect = rectFromNode(node)
  if (!rect) return null
  return { text, rect, anchorNode: node }
}

/** IE / 旧 Trident：document.selection */
function getLegacyDocumentSelection(root: HTMLElement): SelectionAskPayload | null {
  const sel = (document as Document & { selection?: LegacyDocSelection }).selection
  if (!sel || typeof sel.createRange !== 'function') return null
  if (sel.type === 'None' || sel.type === 'none') return null
  try {
    const r = sel.createRange()
    const text = meaningfulText(r.text || r.htmlText)
    if (!text) return null
    const parent = r.parentElement ? r.parentElement() : null
    if (parent && !isInsideRoot(root, parent)) return null
    let rect: DOMRect | null = null
    if (typeof r.getBoundingClientRect === 'function') {
      rect = toDOMRect(r.getBoundingClientRect())
    } else if (typeof r.boundingLeft === 'number') {
      rect = createRect(r.boundingLeft, r.boundingTop || 0, r.boundingWidth || 8, r.boundingHeight || 18)
    } else {
      rect = rectFromNode(parent)
    }
    if (!rect) return null
    return { text, rect, anchorNode: parent || root }
  } catch {
    return null
  }
}

/** input / textarea 的 selectionStart，不走 window.getSelection */
function getFormControlSelection(root: HTMLElement): SelectionAskPayload | null {
  const el = document.activeElement as (HTMLInputElement | HTMLTextAreaElement) | null
  if (!el || typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return null
  if (!isInsideRoot(root, el)) return null
  const start = el.selectionStart
  const end = el.selectionEnd
  if (end <= start) return null
  const text = meaningfulText((el.value || '').slice(start, end))
  if (!text) return null
  return { text, rect: toDOMRect(el.getBoundingClientRect()), anchorNode: el }
}

/** window/document.getSelection + 旧 API */
function getNativeSelection(root: HTMLElement, event?: Event): SelectionAskPayload | null {
  const selection =
    (typeof window.getSelection === 'function' ? window.getSelection() : null) ||
    (typeof document.getSelection === 'function' ? document.getSelection() : null)
  const loose = !!(event && (pathIncludes(event, root) || pointInRoot(root, event)))
  return (
    getSelectionFromSelectionObject(selection, root, loose) ||
    getLegacyDocumentSelection(root) ||
    getFormControlSelection(root)
  )
}

/** 部分浏览器 ShadowRoot.getSelection */
function getShadowRootSelection(root: HTMLElement): SelectionAskPayload | null {
  for (const shadow of collectShadowRoots(root)) {
    const selection = (shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? null
    const payload = getSelectionFromSelectionObject(selection, root)
    if (payload) return payload
  }
  return null
}

/** Chrome 105+ getComposedRanges */
function getComposedSelection(root: HTMLElement): SelectionAskPayload | null {
  const selection = window.getSelection() as ComposedSelection | null
  if (!selection?.getComposedRanges) return null
  const shadows = collectShadowRoots(root)
  let ranges: StaticRange[] = []
  try {
    ranges = selection.getComposedRanges({ shadowRoots: shadows })
  } catch {
    try {
      ranges = selection.getComposedRanges()
    } catch {
      return null
    }
  }
  for (const staticRange of ranges) {
    if (staticRange.collapsed) continue
    try {
      const range = document.createRange()
      range.setStart(staticRange.startContainer, staticRange.startOffset)
      range.setEnd(staticRange.endContainer, staticRange.endOffset)
      const payload = payloadFromRange(range, root)
      if (payload) return payload
    } catch {
      continue
    }
  }
  return null
}

/** 在文本节点里按 x 二分出 caret offset */
function offsetInTextNode(text: Text, x: number, y: number): number | null {
  const len = text.length
  if (!len) return null
  const range = document.createRange()
  try {
    range.selectNodeContents(text)
    const wrap = range.getBoundingClientRect()
    if (y < wrap.top - 4 || y > wrap.bottom + 4 || x < wrap.left - 4 || x > wrap.right + 4) {
      return null
    }
  } catch {
    return null
  }
  let lo = 0
  let hi = len
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    try {
      range.setStart(text, mid)
      range.setEnd(text, Math.min(mid + 1, len))
      const r = range.getBoundingClientRect()
      if (x > r.left + r.width / 2) lo = mid + 1
      else hi = mid
    } catch {
      return lo
    }
  }
  return lo
}

/** elementFromPoint + 文本节点探测 */
function caretFromElementPoint(x: number, y: number): CaretPoint | null {
  const hits: Element[] = []
  try {
    const stacked =
      typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : null
    if (stacked && stacked.length) {
      for (let i = 0; i < stacked.length; i++) {
        const item = stacked[i]
        if (item) hits.push(item)
      }
    }
  } catch {
    // ignore
  }
  if (!hits.length) {
    try {
      const el = document.elementFromPoint(x, y)
      if (el) hits.push(el)
    } catch {
      return null
    }
  }
  const filter = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4
  for (let h = 0; h < hits.length; h++) {
    const el = hits[h]
    if (!el) continue
    if (typeof document.createTreeWalker === 'function') {
      try {
        const walker = document.createTreeWalker(el, filter)
        let node = walker.nextNode()
        while (node) {
          if (node.nodeType === TEXT_NODE) {
            const hit = offsetInTextNode(node as Text, x, y)
            if (hit != null) return { offsetNode: node, offset: hit }
          }
          node = walker.nextNode()
        }
      } catch {
        // ignore
      }
    }
  }
  const fallback = hits[0]
  return fallback ? { offsetNode: fallback, offset: 0 } : null
}

/** caretPositionFromPoint → caretRangeFromPoint → 坐标探测 */
function caretFromPoint(x: number, y: number, shadowRoots: ShadowRoot[]): CaretPoint | null {
  const doc = document as Document & {
    caretPositionFromPoint?: CaretPositionFromPoint
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const options = shadowRoots.length ? { shadowRoots } : undefined
    let pos: CaretPoint | null = null
    try {
      pos = doc.caretPositionFromPoint(x, y, options) ?? null
    } catch {
      try {
        pos = doc.caretPositionFromPoint(x, y) ?? null
      } catch {
        pos = null
      }
    }
    if (pos && pos.offsetNode) return { offsetNode: pos.offsetNode, offset: pos.offset }
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    try {
      const range = doc.caretRangeFromPoint(x, y)
      if (range && range.startContainer) {
        return { offsetNode: range.startContainer, offset: range.startOffset }
      }
    } catch {
      // ignore
    }
  }
  return caretFromElementPoint(x, y)
}

/** 两个 caret 合成 Range */
function rangeFromCarets(start: CaretPoint, end: CaretPoint): Range | null {
  return tryCreateRange(start.offsetNode, start.offset, end.offsetNode, end.offset)
}

/** window.monaco，不用 globalThis */
function getMonacoGlobal(): MonacoGlobal | undefined {
  const scope = (typeof window !== 'undefined' ? window : globalThis) as Record<string, unknown>
  const keys = ['monaco', 'Monaco']
  for (let i = 0; i < keys.length; i++) {
    const candidate = scope[keys[i] as string] as MonacoGlobal | undefined
    if (candidate && candidate.editor && (candidate.editor.getEditors || candidate.editor.getDiffEditors)) {
      return candidate
    }
  }
  return undefined
}

/** Monaco 官方 API 读选区 */
function payloadFromMonacoEditor(root: HTMLElement, editor: MonacoLikeEditor | null | undefined): SelectionAskPayload | null {
  if (!editor) return null
  const node = editor.getDomNode?.()
  if (!node || !isInsideRoot(root, node)) return null

  const selection = editor.getSelection?.()
  const model = editor.getModel?.()
  if (!selection || !model || selection.isEmpty()) return null

  const text = model.getValueInRange(selection)
  if (!text?.trim()) return null

  const overlay = monacoSelectionAnchorRect(node)
  if (overlay) return { text, rect: overlay, anchorNode: node }

  const start = editor.getScrolledVisiblePosition?.(selection.getStartPosition())
  const end = editor.getScrolledVisiblePosition?.(
    selection.getEndPosition ? selection.getEndPosition() : selection.getStartPosition(),
  )
  const editorRect = node.getBoundingClientRect()
  let rect: DOMRect | null = null
  if (start) {
    const startLeft = editorRect.left + start.left
    const startTop = editorRect.top + start.top
    const startHeight = start.height || 18
    if (end) {
      const endLeft = editorRect.left + end.left
      const endTop = editorRect.top + end.top
      const endHeight = end.height || 18
      const left = Math.min(startLeft, endLeft)
      const top = Math.min(startTop, endTop)
      const right = Math.max(startLeft, endLeft)
      const bottom = Math.max(startTop + startHeight, endTop + endHeight)
      rect = createRect(left, top, Math.max(8, right - left), Math.max(8, bottom - top))
    } else {
      rect = createRect(startLeft, startTop, 12, startHeight)
    }
  }
  if (!rect || isAlmostEditorRect(rect, node)) {
    rect = pointerAnchorRect() || rect
  }
  if (!rect) return { text, rect: toDOMRect(editorRect), anchorNode: node }
  return { text, rect, anchorNode: node }
}

/** 根节点内的 Monaco / Diff 编辑器 */
function getMonacoEditors(root: HTMLElement): MonacoLikeEditor[] {
  const monaco = getMonacoGlobal()
  if (!monaco?.editor) return []

  const editors: MonacoLikeEditor[] = []
  for (const editor of monaco.editor.getEditors?.() ?? []) {
    const node = editor.getDomNode?.()
    if (node && isInsideRoot(root, node)) editors.push(editor)
  }
  for (const diff of monaco.editor.getDiffEditors?.() ?? []) {
    const modified = diff.getModifiedEditor?.()
    const original = diff.getOriginalEditor?.()
    const modifiedNode = modified?.getDomNode?.()
    const originalNode = original?.getDomNode?.()
    if (modified && modifiedNode && isInsideRoot(root, modifiedNode)) editors.push(modified)
    if (original && originalNode && isInsideRoot(root, originalNode)) editors.push(original)
  }
  return editors
}

/** 从任意节点找到最近的 .monaco-editor */
function monacoHostFromNode(node: Node | null | undefined): Element | null {
  if (!node) return null
  const el = isElement(node) ? node : node.parentElement
  return closestClass(el, 'monaco-editor')
}

/** 选区矩形是否已经大到像整块编辑器（不能当锚点） */
function isAlmostEditorRect(rect: DOMRect, editorEl: Element) {
  const editorRect = editorEl.getBoundingClientRect()
  if (!editorRect.height) return false
  return rect.height > editorRect.height * 0.4 || (rect.width > editorRect.width * 0.75 && rect.height > 36)
}

function pointerAnchorRect(): DOMRect | null {
  const pt = activePointer()
  if (!pt) return null
  return createRect(pt.x - 12, pt.y - 10, 24, 20)
}

function unionRects(rects: DOMRect[]): DOMRect | null {
  if (!rects.length) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r) continue
    left = Math.min(left, r.left)
    top = Math.min(top, r.top)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  }
  if (!(right > left && bottom > top)) return null
  return createRect(left, top, right - left, bottom - top)
}

function rectsFromNodeList(nodes: ArrayLike<Element>): DOMRect[] {
  const list = toNodeList(nodes)
  const rects: DOMRect[] = []
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    if (!node) continue
    const rect = node.getBoundingClientRect()
    if (rect.width > 1 && rect.height > 1) rects.push(toDOMRect(rect))
  }
  return rects
}

/** 同一批 overlay 里丢掉整行高亮，留下词级选区 */
function preferTightRects(rects: DOMRect[]): DOMRect[] {
  if (rects.length <= 1) return rects
  let minH = Infinity
  let minW = Infinity
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r) continue
    minH = Math.min(minH, r.height)
    minW = Math.min(minW, r.width)
  }
  const tight: DOMRect[] = []
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r) continue
    if (r.height <= minH + 6 && r.width <= minW * 4 + 24) tight.push(r)
  }
  return tight.length ? tight : rects
}

/** Monaco 真实选区高亮（不要用整块编辑器 / 当前行条） */
function monacoSelectionAnchorRect(editorEl: Element, fallback?: DOMRect | null): DOMRect | null {
  const selected = editorEl.querySelectorAll
    ? editorEl.querySelectorAll('.selected-text, .inline-selected-text')
    : editorEl.getElementsByClassName('selected-text')
  let rects = preferTightRects(rectsFromNodeList(selected))
  if (!rects.length) {
    const cslr = editorEl.querySelectorAll ? editorEl.querySelectorAll('.cslr') : []
    const all = preferTightRects(rectsFromNodeList(cslr as ArrayLike<Element>))
    rects = []
    for (let i = 0; i < all.length; i++) {
      const r = all[i]
      if (r && !isAlmostEditorRect(r, editorEl)) rects.push(r)
    }
  }
  const union = pickRectNearPointer(rects) || unionRects(rects)
  if (union && !isAlmostEditorRect(union, editorEl)) {
    return pinToolbarToPointer ? snapRectToPointer(union) : union
  }
  if (fallback && !isAlmostEditorRect(fallback, editorEl)) {
    return pinToolbarToPointer ? snapRectToPointer(fallback) : fallback
  }
  return pinToolbarToPointer ? pointerAnchorRect() : fallback || null
}

/** Monaco 选区高亮层矩形 */
function firstMonacoOverlayRect(editorEl: Element): DOMRect | null {
  return monacoSelectionAnchorRect(editorEl)
}

/** 穿透 open Shadow 的 querySelectorAll */
function queryAllDeep(root: ParentNode, selector: string): Element[] {
  const result: Element[] = []
  const visit = (node: ParentNode) => {
    if ('querySelectorAll' in node) {
      result.push.apply(result, toNodeList(node.querySelectorAll(selector)))
    }
    const elements = 'querySelectorAll' in node ? node.querySelectorAll('*') : []
    for (const el of elements) {
      if (el.shadowRoot) visit(el.shadowRoot)
    }
  }
  visit(root)
  return result
}

/** 从事件路径找 .monaco-editor */
function monacoEditorFromEvent(event?: Event): Element | null {
  if (!event) return null
  const path = eventPath(event)
  for (let i = 0; i < path.length; i++) {
    const node = path[i]
    if (!isElement(node)) continue
    const host = closestClass(node, 'monaco-editor')
    if (host) return host
  }
  return null
}

/** 坐标命中的 Monaco 容器 */
function monacoEditorFromPoint(root: HTMLElement, x: number, y: number): Element | null {
  let el: Element | null = null
  try {
    el = document.elementFromPoint(x, y)
  } catch {
    el = null
  }
  const fromPoint = closestClass(el, 'monaco-editor')
  if (fromPoint && isInsideRoot(root, fromPoint)) return fromPoint
  const editors = root.getElementsByClassName('monaco-editor')
  for (let i = 0; i < editors.length; i++) {
    const editor = editors[i]
    if (!editor) continue
    const rect = editor.getBoundingClientRect()
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return editor
  }
  return null
}

/** 矩形是否相交 */
function rectsOverlap(a: DOMRect, b: DOMRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** 收集 Monaco 选区 overlay */
function collectMonacoOverlayRects(editorEl: Element): DOMRect[] {
  const selected = editorEl.querySelectorAll
    ? editorEl.querySelectorAll('.selected-text, .inline-selected-text')
    : editorEl.getElementsByClassName('selected-text')
  const selectedRects = preferTightRects(rectsFromNodeList(selected))
  if (selectedRects.length) return selectedRects
  const nodes = editorEl.querySelectorAll
    ? editorEl.querySelectorAll('.cslr')
    : editorEl.getElementsByClassName('selected-text')
  const all = preferTightRects(rectsFromNodeList(nodes as ArrayLike<Element>))
  const filtered: DOMRect[] = []
  for (let i = 0; i < all.length; i++) {
    const r = all[i]
    if (r && !isAlmostEditorRect(r, editorEl)) filtered.push(r)
  }
  return filtered
}

/** 用 overlay + view-line 拼选中文本 */
function payloadFromMonacoDom(editorEl: Element): SelectionAskPayload | null {
  const overlayRects = collectMonacoOverlayRects(editorEl)
  if (!overlayRects.length) return null

  const lineTexts: string[] = []
  const lines = editorEl.getElementsByClassName('view-line')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const lineRect = line.getBoundingClientRect()
    let hit = false
    for (let j = 0; j < overlayRects.length; j++) {
      const overlay = overlayRects[j]
      if (overlay && rectsOverlap(lineRect, overlay)) {
        hit = true
        break
      }
    }
    if (!hit) continue
    const text = (line.textContent || '').replace(/\u00a0/g, ' ')
    if (text) lineTexts.push(text)
  }
  const text = lineTexts.join('\n').replace(/^\s+|\s+$/g, '')
  const rect = monacoSelectionAnchorRect(editorEl, unionRects(overlayRects))
  if (!text || !rect) return null
  return { text, rect, anchorNode: editorEl }
}

/** Monaco 隐藏 textarea.inputarea */
function getMonacoTextareaSelection(root: HTMLElement, editorEl?: Element | null): SelectionAskPayload | null {
  const areas = editorEl
    ? editorEl.querySelectorAll<HTMLTextAreaElement>('textarea.inputarea')
    : (queryAllDeep(root, '.monaco-editor textarea.inputarea') as HTMLTextAreaElement[])
  for (const area of areas) {
    if (!isInsideRoot(root, area) && !(editorEl && editorEl.contains(area))) continue
    const start = area.selectionStart ?? 0
    const end = area.selectionEnd ?? 0
    if (end <= start) continue
    const text = area.value.slice(start, end)
    if (!text.trim()) continue
    const host = closestClass(area, 'monaco-editor') || editorEl
    const areaRect = toDOMRect(area.getBoundingClientRect())
    const rect =
      (host && monacoSelectionAnchorRect(host, isAlmostEditorRect(areaRect, host) ? null : areaRect)) ||
      (!isAlmostEditorRect(areaRect, host || area) ? areaRect : pointerAnchorRect())
    if (!rect) continue
    return { text, rect, anchorNode: area }
  }
  return null
}

/** Monaco：API → textarea → DOM 高亮 */
function getMonacoSelection(root: HTMLElement, event?: Event): SelectionAskPayload | null {
  for (const editor of getMonacoEditors(root)) {
    const payload = payloadFromMonacoEditor(root, editor)
    if (payload) return payload
  }

  const xy = event ? eventClientXY(event) : null
  const eventEditor =
    monacoEditorFromEvent(event) || (xy ? monacoEditorFromPoint(root, xy.x, xy.y) : null)
  if (eventEditor) {
    const fromTextarea = getMonacoTextareaSelection(root, eventEditor)
    if (fromTextarea) return fromTextarea
    const fromDom = payloadFromMonacoDom(eventEditor)
    if (fromDom) return fromDom
  }

  const fromTextarea = getMonacoTextareaSelection(root)
  if (fromTextarea) return fromTextarea

  const lightEditors = root.getElementsByClassName('monaco-editor')
  for (let i = 0; i < lightEditors.length; i++) {
    const editorEl = lightEditors[i]
    if (!editorEl) continue
    const fromDom = payloadFromMonacoDom(editorEl)
    if (fromDom) return fromDom
  }

  for (const editorEl of queryAllDeep(root, '.monaco-editor')) {
    const fromDom = payloadFromMonacoDom(editorEl)
    if (fromDom) return fromDom
  }
  return null
}

/** 收起 Monaco 选区 */
function collapseMonacoSelection(root: HTMLElement) {
  for (const editor of getMonacoEditors(root)) {
    const selection = editor.getSelection?.()
    if (!selection || selection.isEmpty()) continue
    const end = (selection as { getEndPosition?: () => { lineNumber: number; column: number } }).getEndPosition?.()
    if (!end) continue
    ;(editor as MonacoLikeEditor & {
      setSelection?: (selection: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      }) => void
    }).setSelection?.({
      startLineNumber: end.lineNumber,
      startColumn: end.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    })
  }
}

/** 当前浏览器选区是否在根内 */
function isSelectionInsideRoot(root: HTMLElement, selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0) return false
  const node = selection.getRangeAt(0).commonAncestorContainer
  return isInsideRoot(root, node) || isInCollectedShadow(node, root)
}

/** 只清根内选区，避免误伤输入框 */
function clearBrowserSelection(root: HTMLElement | null) {
  if (!root) return
  const selection = window.getSelection()
  if (isSelectionInsideRoot(root, selection)) {
    selection?.removeAllRanges()
  }
  for (const shadow of collectShadowRoots(root)) {
    ;(shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()?.removeAllRanges()
  }
  collapseMonacoSelection(root)
}

/** 带事件里收集到的 shadowRoots 再调 getComposedRanges */
function getComposedSelectionFromEvent(root: HTMLElement, event: Event): SelectionAskPayload | null {
  const selection = window.getSelection() as ComposedSelection | null
  if (!selection?.getComposedRanges) return null
  const shadows = uniqueItems(shadowsFromEvent(event).concat(collectShadowRoots(root)))
  try {
    const ranges = selection.getComposedRanges({ shadowRoots: shadows })
    for (const staticRange of ranges) {
      if (staticRange.collapsed) continue
      const range = document.createRange()
      range.setStart(staticRange.startContainer, staticRange.startOffset)
      range.setEnd(staticRange.endContainer, staticRange.endOffset)
      const payload = payloadFromRange(range, root)
      if (payload) return payload
    }
  } catch {
    return null
  }
  return null
}

/** 单路失败不影响后续降级 */
function tryRead(fn: () => SelectionAskPayload | null): SelectionAskPayload | null {
  try {
    return fn()
  } catch {
    return null
  }
}

/** Range 跨 Shadow 失败时，TreeWalker 收集文本 */
function payloadFromCaretWalk(root: HTMLElement, start: CaretPoint, end: CaretPoint): SelectionAskPayload | null {
  const startNode = start.offsetNode
  const endNode = end.offsetNode
  if (startNode === endNode && startNode.nodeType === TEXT_NODE) {
    const data = (startNode as Text).data || ''
    const a = Math.min(start.offset, end.offset)
    const b = Math.max(start.offset, end.offset)
    const text = meaningfulText(data.slice(a, b))
    if (!text) return null
    const range = tryCreateRange(startNode, a, startNode, b)
    const rect = (range && firstVisibleRect(range)) || rectFromNode(startNode)
    if (!rect) return null
    return { text, rect, range: range || undefined, anchorNode: startNode }
  }
  if (typeof document.createTreeWalker !== 'function') return null
  const filter = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4
  let walker: TreeWalker
  try {
    walker = document.createTreeWalker(root, filter)
  } catch {
    return null
  }
  const parts: string[] = []
  let started = false
  let node = walker.nextNode()
  while (node) {
    if (node === startNode || node === endNode) {
      const textNode = node as Text
      const data = textNode.data || ''
      if (node === startNode && node === endNode) {
        const a = Math.min(start.offset, end.offset)
        const b = Math.max(start.offset, end.offset)
        parts.push(data.slice(a, b))
        break
      }
      if (!started) {
        started = true
        const off = node === startNode ? start.offset : end.offset
        parts.push(data.slice(off))
      } else {
        const off = node === endNode ? end.offset : start.offset
        parts.push(data.slice(0, off))
        break
      }
    } else if (started && node.nodeType === TEXT_NODE) {
      parts.push((node as Text).data || '')
    }
    node = walker.nextNode()
  }
  const text = meaningfulText(parts.join(''))
  if (!text) return null
  const rect = rectFromNode(endNode) || rectFromNode(startNode)
  if (!rect) return null
  return { text, rect, anchorNode: endNode }
}

/** 按下点+松开点拼选区（最老内核兜底） */
function getPayloadByPointer(root: HTMLElement, event: Event): SelectionAskPayload | null {
  const xy = eventClientXY(event)
  if (!xy) return null
  const x = xy.x
  const y = xy.y
  const shadows = shadowsFromEvent(event)
  const end = caretFromPoint(x, y, shadows)
  const loose = pathIncludes(event, root) || pointInRoot(root, event)
  if (end) {
    const start = pointerAnchor
      ? caretFromPoint(pointerAnchor.x, pointerAnchor.y, shadows) || end
      : end
    const range = rangeFromCarets(start, end)
    if (range) {
      const payload = payloadFromRange(range, root, loose)
      if (payload) return payload
    }
    const walked = payloadFromCaretWalk(root, start, end)
    if (walked) return walked
  }
  const editor = monacoEditorFromEvent(event) || monacoEditorFromPoint(root, x, y)
  if (!editor) return null
  return getMonacoTextareaSelection(root, editor) || payloadFromMonacoDom(editor)
}

/** MouseEvent / TouchEvent 坐标 */
function eventClientXY(event: Event): { x: number; y: number } | null {
  if ('clientX' in event && typeof (event as MouseEvent).clientX === 'number') {
    return { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }
  }
  const touchEvent = event as TouchEvent
  const touch =
    (touchEvent.changedTouches && touchEvent.changedTouches[0]) ||
    (touchEvent.touches && touchEvent.touches[0])
  if (touch && typeof touch.clientX === 'number') {
    return { x: touch.clientX, y: touch.clientY }
  }
  return null
}

/** 按兼容性从新到旧尝试读选区 */
function readLiveSelection(root: HTMLElement, event?: Event): SelectionAskPayload | null {
  const xy = (event && eventClientXY(event)) || pointerAnchor
  const monacoHost =
    monacoEditorFromEvent(event) || (xy ? monacoEditorFromPoint(root, xy.x, xy.y) : null)

  const monacoPayload = tryRead(() => getMonacoSelection(root, event))
  const nativePayload =
    tryRead(() => getNativeSelection(root, event)) ||
    tryRead(() => getShadowRootSelection(root)) ||
    tryRead(() => getFormControlSelection(root)) ||
    tryRead(() => getComposedSelection(root)) ||
    (event ? tryRead(() => getComposedSelectionFromEvent(root, event)) : null) ||
    (event ? tryRead(() => getPayloadByPointer(root, event)) : null) ||
    tryRead(() => getLegacyDocumentSelection(root))

  const payload = monacoHost ? monacoPayload || nativePayload : nativePayload || monacoPayload
  return tightenPayloadRect(payload, monacoHost)
}

/** 正文 Range 若盖住整块 Monaco，改用高亮条当锚点 */
function tightenPayloadRect(payload: SelectionAskPayload | null, host?: Element | null): SelectionAskPayload | null {
  if (!payload) return null
  const monacoHost = host || monacoHostFromNode(payload.anchorNode) || monacoHostFromNode(payload.range?.commonAncestorContainer || null)
  if (!monacoHost) return payload
  const tight = monacoSelectionAnchorRect(monacoHost, payload.rect)
  if (!tight) return payload
  return { text: payload.text, rect: tight, range: payload.range, anchorNode: payload.anchorNode || monacoHost }
}

/** 挂到问答容器 rootRef 上，输出工具条位置与 selectedText */
export function useSelectionAsk(rootRef: Ref<HTMLElement | null>) {
  const visible = ref(false)
  const selectedText = ref('')
  const top = ref(0)
  const left = ref(0)
  const toolbarRef = ref<HTMLElement | null>(null)

  /** 最近一次成功读到的选区，mouseup 时空选区时还能用来出条 */
  let cachedPayload: SelectionAskPayload | null = null
  let streamDiffsDrag: StreamDiffsDrag | null = null
  let streamDiffsPayload: SelectionAskPayload | null = null

  /** hide() 后忽略紧跟着的 mouseup/selectionchange */
  let skipNextSync = false
  let lastGestureWasDrag = false
  let showTimer = 0
  let scrollRaf = 0
  let retryTimer = 0
  /** mouseup 与 pointerup 会成对触发，用时间戳去重 */
  let lastPointerUpAt = 0
  /** 图1 定位成功后，选区相对宿主的偏移；滚动只平移这块，不再重读整块编辑器 */
  let lockedSelectionAnchor: {
    host: Element
    relLeft: number
    relTop: number
    width: number
    height: number
  } | null = null
  let gesture: {
    startX: number
    startY: number
    onToolbarEl: boolean
    overToolbarRect: boolean
    inRoot: boolean
    hadToolbar: boolean
  } | null = null

  const CLICK_SLOP = 6
  /** 单击/双击/三击选词要等第三次点击结束再出条 */
  const SHOW_DELAY = 320

  /** 取消延迟展示（三击选段要等 320ms） */
  function cancelShowTimer() {
    if (!showTimer) return
    window.clearTimeout(showTimer)
    showTimer = 0
  }

  /** 取消选区延迟重试 */
  function cancelRetryTimer() {
    if (!retryTimer) return
    window.clearTimeout(retryTimer)
    retryTimer = 0
  }

  /** 立刻或延迟显示工具条 */
  function scheduleShow(payload: SelectionAskPayload, immediate = false) {
    cachedPayload = payload
    pinToolbarToPointer = true
    if (immediate || visible.value) {
      cancelShowTimer()
      place(payload)
      return
    }
    cancelShowTimer()
    showTimer = window.setTimeout(() => {
      showTimer = 0
      pinToolbarToPointer = true
      if (cachedPayload) place(cachedPayload)
    }, SHOW_DELAY)
  }

  /** 坐标是否压在工具条矩形上 */
  function isPointOverToolbar(event: Event) {
    const toolbar = toolbarRef.value
    if (!toolbar || !visible.value) return false
    const xy = eventClientXY(event)
    if (!xy) return false
    const rect = toolbar.getBoundingClientRect()
    return xy.x >= rect.left && xy.x <= rect.right && xy.y >= rect.top && xy.y <= rect.bottom
  }

  /** 事件目标是否是工具条节点 */
  function isEventOnToolbarEl(event: Event) {
    const toolbar = toolbarRef.value
    if (!toolbar || !visible.value) return false
    return pathIncludes(event, toolbar)
  }

  /** 按下到当前点的距离 */
  function gestureDistance(event: Event) {
    if (!gesture) return 0
    const xy = eventClientXY(event)
    if (!xy) return 0
    return Math.sqrt(
      (xy.x - gesture.startX) * (xy.x - gesture.startX) +
        (xy.y - gesture.startY) * (xy.y - gesture.startY),
    )
  }

  /** Monaco 会 pointer capture，点工具条前先放开 */
  function releasePointerCaptures(event: PointerEvent) {
    const pointerId = event.pointerId
    if (typeof pointerId !== 'number') return
    const path = eventPath(event)
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (isElement(node) && typeof node.hasPointerCapture === 'function' && node.hasPointerCapture(pointerId)) {
        node.releasePointerCapture(pointerId)
      }
    }
  }

  /** 合成点击「添加至对话」 */
  function triggerToolbarButtonClick() {
    toolbarRef.value?.querySelector('button')?.click()
  }

  /** 路径包含根，或坐标落在根矩形内 */
  function isEventInRoot(event: Event) {
    const root = rootRef.value
    if (!root) return false
    if (pathIncludes(event, root)) return true
    return pointInRoot(root, event)
  }

  /** 焦点在根内（含 Shadow） */
  function isFocusInRoot() {
    const root = rootRef.value
    const active = document.activeElement
    return !!(root && active && isInsideRoot(root, active))
  }

  /** 只藏工具条，不清浏览器选区 */
  function dismissToolbarKeepSelection() {
    cancelShowTimer()
    cancelRetryTimer()
    visible.value = false
    selectedText.value = ''
    cachedPayload = null
    streamDiffsPayload = null
    streamDiffsDrag = null
    lockedSelectionAnchor = null
  }

  /** 藏工具条并清根内选区 */
  function hide() {
    skipNextSync = true
    dismissToolbarKeepSelection()
    clearBrowserSelection(rootRef.value)
  }

  /** 滚动时暂时藏条，不清缓存 */
  function hideToolbarOnly() {
    visible.value = false
  }

  function stableAnchorHost(payload: SelectionAskPayload): Element | null {
    const fromNode = monacoHostFromNode(payload.anchorNode) || monacoHostFromNode(payload.range?.commonAncestorContainer || null)
    if (fromNode) {
      const lines =
        fromNode.querySelector('.lines-content') ||
        fromNode.querySelector('.view-lines') ||
        fromNode.querySelector('.monaco-scrollable-element')
      return lines || fromNode
    }
    const node = payload.range?.commonAncestorContainer ?? payload.anchorNode ?? null
    if (isElement(node)) return node
    return node && node.parentElement ? node.parentElement : null
  }

  function lockSelectionAnchor(payload: SelectionAskPayload, anchor: DOMRect) {
    const host = stableAnchorHost(payload)
    if (!host) {
      lockedSelectionAnchor = null
      return
    }
    const hr = host.getBoundingClientRect()
    lockedSelectionAnchor = {
      host,
      relLeft: anchor.left - hr.left,
      relTop: anchor.top - hr.top,
      width: Math.max(anchor.width, 8),
      height: Math.max(anchor.height, 14),
    }
  }

  function readLockedSelectionAnchor(): DOMRect | null {
    const locked = lockedSelectionAnchor
    if (!locked || !locked.host.isConnected) {
      lockedSelectionAnchor = null
      return null
    }
    const hr = locked.host.getBoundingClientRect()
    return createRect(hr.left + locked.relLeft, hr.top + locked.relTop, locked.width, locked.height)
  }

  /** 按选区矩形放工具条 */
  function place(payload: SelectionAskPayload) {
    const lockedRect = readLockedSelectionAnchor()
    const anchor = lockedRect || visibleAnchorRect(payload)
    if (!anchor) {
      hideToolbarOnly()
      return
    }
    if (!lockedSelectionAnchor) lockSelectionAnchor(payload, anchor)

    selectedText.value = payload.text
    const toolbarEl = toolbarRef.value
    const toolbarWidth = toolbarEl?.offsetWidth ?? 140
    const toolbarHeight = toolbarEl?.offsetHeight ?? 40
    const gap = 8
    const clipHost = lockedSelectionAnchor?.host || payload.range?.commonAncestorContainer || payload.anchorNode || null
    const clip = getClipRect(clipHost)
    const spaceAbove = anchor.top - clip.top
    const spaceBelow = clip.bottom - anchor.bottom
    const canPlaceAbove = spaceAbove >= toolbarHeight + gap
    const canPlaceBelow = spaceBelow >= toolbarHeight + gap

    if (canPlaceAbove) {
      top.value = anchor.top - gap
    } else if (canPlaceBelow) {
      top.value = anchor.bottom + toolbarHeight + gap
    } else {
      top.value = Math.min(
        Math.max(anchor.top + toolbarHeight + gap, clip.top + toolbarHeight + gap),
        clip.bottom - gap,
      )
    }

    const minLeft = clip.left + toolbarWidth / 2 + 4
    const maxLeft = clip.right - toolbarWidth / 2 - 4
    left.value = Math.min(
      Math.max(anchor.left + anchor.width / 2, minLeft),
      Math.max(minLeft, maxLeft),
    )
    visible.value = true
    pinToolbarToPointer = false
  }

  /** 读 payload，成功则展示 */
  function syncFromSelection(event?: Event, immediate = false) {
    const root = rootRef.value
    if (!root) {
      dismissToolbarKeepSelection()
      return false
    }
    const payload = readLiveSelection(root, event) || streamDiffsPayload || cachedPayload
    if (payload) {
      scheduleShow(payload, immediate)
      return true
    }
    return false
  }

  /** 老 WebView 松手后选区晚到，分帧重试 */
  function syncFromSelectionWithRetry(event: Event, immediate: boolean) {
    cancelRetryTimer()
    if (syncFromSelection(event, immediate)) return
    let index = 0
    const tick = () => {
      retryTimer = 0
      if (skipNextSync) return
      if (syncFromSelection(event, immediate)) return
      index += 1
      const wait = SELECTION_RETRY_MS[index]
      if (typeof wait === 'number') {
        retryTimer = window.setTimeout(tick, wait)
      } else {
        dismissToolbarKeepSelection()
      }
    }
    retryTimer = window.setTimeout(tick, SELECTION_RETRY_MS[0] || 0)
  }

  /** 滚动/缩放时跟着选区走 */
  function updateToolbarForViewport() {
    pinToolbarToPointer = false
    const root = rootRef.value
    if (!root || (!visible.value && !cachedPayload && !streamDiffsPayload)) return
    const payload = cachedPayload || streamDiffsPayload
    if (!payload) {
      hideToolbarOnly()
      return
    }
    place(payload)
  }

  /** mouseup/touchend：划选结束 */
  function onSelectEnd(event: Event) {
    pinToolbarToPointer = true
    rememberPointer(eventClientXY(event))
    if (skipNextSync) {
      skipNextSync = false
      return
    }
    if (isEventOnToolbarEl(event)) return
    if (!isEventInRoot(event)) {
      if (visible.value || cachedPayload || streamDiffsPayload) {
        hide()
      }
      return
    }
    syncFromSelectionWithRetry(event, lastGestureWasDrag)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (skipNextSync) return
        syncFromSelection(event, lastGestureWasDrag)
      })
    }
  }

  /** 把能读到的选区先缓存，避免 mouseup 时已空 */
  function onSelectionChange() {
    const root = rootRef.value
    if (!root) return
    const payload = readLiveSelection(root)
    if (payload) cachedPayload = payload
  }

  /** Esc 关闭；Shift+方向键扩展选区 */
  function onKeyUp(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (visible.value || cachedPayload || streamDiffsPayload) hide()
      return
    }
    if (!isEventInRoot(event) && !isFocusInRoot()) return
    if (event.shiftKey || (event.key && event.key.indexOf('Arrow') === 0)) {
      const run = () => syncFromSelection(undefined, true)
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else window.setTimeout(run, 16)
    }
  }

  /** 视口变化时更新位置 */
  function onScrollOrResize() {
    if (scrollRaf) return
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0
      updateToolbarForViewport()
    })
  }

  /** 记录起点、手势、diffs 拖选 */
  function onPointerDown(event: PointerEvent) {
    pinToolbarToPointer = true
    lockedSelectionAnchor = null
    const xy = eventClientXY(event)
    if (xy) pointerAnchor = xy
    rememberPointer(xy)
    const isMultiClick = event.detail >= 2
    if (!isMultiClick) skipNextSync = false
    const inRoot = isEventInRoot(event)
    const onToolbarEl = isEventOnToolbarEl(event)
    const overToolbarRect = isPointOverToolbar(event)

    gesture = {
      startX: xy ? xy.x : 0,
      startY: xy ? xy.y : 0,
      onToolbarEl: onToolbarEl && !isMultiClick,
      overToolbarRect: overToolbarRect && !isMultiClick,
      inRoot,
      hadToolbar: visible.value,
    }

    if (onToolbarEl && !isMultiClick) {
      releasePointerCaptures(event)
      skipNextSync = true
      return
    }

    if (overToolbarRect && !isMultiClick) {
      releasePointerCaptures(event)
    }

    if (!inRoot) {
      if (visible.value || cachedPayload || streamDiffsPayload) hide()
      streamDiffsDrag = null
      return
    }

    const path = eventPath(event)
    let inSurface = false
    for (let i = 0; i < path.length; i++) {
      if (isDiffsSurface(path[i] || null)) {
        inSurface = true
        break
      }
    }
    if (inSurface) {
      const shadows = shadowsFromEvent(event)
      streamDiffsDrag = {
        shadows,
        start: caretFromPoint(xy ? xy.x : 0, xy ? xy.y : 0, shadows),
      }
      return
    }

    streamDiffsDrag = null
  }

  /** 拖过阈值则先藏条，避免挡住划选 */
  function onPointerMove(event: PointerEvent) {
    rememberPointer(eventClientXY(event))
    if (!gesture || gesture.onToolbarEl) return
    if (gestureDistance(event) < CLICK_SLOP) return
    if (visible.value) dismissToolbarKeepSelection()
  }

  /** 区分单击取消 / 拖选用；mouse 与 pointer 去重 */
  function onPointerUp(event: PointerEvent) {
    rememberPointer(eventClientXY(event))
    const now = Date.now()
    if (now - lastPointerUpAt < 40) return
    lastPointerUpAt = now
    const current = gesture
    gesture = null
    const xy = eventClientXY(event)
    const dist = current && xy
      ? Math.sqrt(
          (xy.x - current.startX) * (xy.x - current.startX) +
            (xy.y - current.startY) * (xy.y - current.startY),
        )
      : 0
    const isClick = dist < CLICK_SLOP
    const isMultiClick = event.detail >= 2
    lastGestureWasDrag = !isClick

    if (current?.onToolbarEl && !isMultiClick) {
      skipNextSync = true
      return
    }

    if (current?.overToolbarRect && isClick && !isMultiClick) {
      skipNextSync = true
      releasePointerCaptures(event)
      event.preventDefault()
      event.stopPropagation()
      triggerToolbarButtonClick()
      return
    }

    if (current?.inRoot && isClick && current.hadToolbar && !isMultiClick) {
      hide()
      return
    }

    const root = rootRef.value
    if (!root) return
    if (isEventOnToolbarEl(event)) return
    if (!isEventInRoot(event)) {
      streamDiffsDrag = null
      return
    }

    const live = readLiveSelection(root, event)
    if (live) {
      cachedPayload = live
      streamDiffsPayload = live
    }

    const drag = streamDiffsDrag
    streamDiffsDrag = null
    if (!drag || streamDiffsPayload) return

    const shadows = uniqueItems(drag.shadows.concat(shadowsFromEvent(event), collectShadowRoots(root)))
    const uniqueShadows = shadows
    const endXY = eventClientXY(event)
    const end = endXY ? caretFromPoint(endXY.x, endXY.y, uniqueShadows) : null
    const start = drag.start || end
    if (!start || !end) return

    const range = rangeFromCarets(start, end)
    if (!range) return
    const payload = payloadFromRange(range, root)
    if (payload) streamDiffsPayload = payload
  }

  /** 无 PointerEvent 时的 touch 起点 */
  function onTouchStart(event: TouchEvent) {
    onPointerDown(event as unknown as PointerEvent)
  }

  /** touch 移动 */
  function onTouchMove(event: TouchEvent) {
    onPointerMove(event as unknown as PointerEvent)
  }

  /** 任意按下都记下坐标，供 caret 兜底 */
  function rememberPressPoint(event: Event) {
    pinToolbarToPointer = true
    const xy = eventClientXY(event)
    if (xy) pointerAnchor = xy
    rememberPointer(xy)
  }

  /** addEventListener 短名 */
  function bind(target: EventTarget, type: string, handler: EventListener, capture?: boolean) {
    target.addEventListener(type, handler, capture)
  }

  /** removeEventListener 短名 */
  function unbind(target: EventTarget, type: string, handler: EventListener, capture?: boolean) {
    target.removeEventListener(type, handler, capture)
  }

  onMounted(() => {
    bind(document, 'mouseup', onSelectEnd as EventListener)
    bind(document, 'touchend', onSelectEnd as EventListener)
    bind(document, 'keyup', onKeyUp as EventListener)
    bind(document, 'selectionchange', onSelectionChange)
    bind(document, 'mousedown', rememberPressPoint, true)
    bind(document, 'touchstart', rememberPressPoint, true)
    // 同时绑 mouse 与 pointer：部分 WebView 有 PointerEvent 类但不派发 pointer 事件
    bind(document, 'mousedown', onPointerDown as unknown as EventListener, true)
    bind(document, 'mousemove', onPointerMove as unknown as EventListener, true)
    bind(document, 'mouseup', onPointerUp as unknown as EventListener, true)
    bind(document, 'touchstart', onTouchStart as EventListener, true)
    bind(document, 'touchmove', onTouchMove as EventListener, true)
    bind(document, 'pointerdown', onPointerDown as unknown as EventListener, true)
    bind(document, 'pointermove', onPointerMove as unknown as EventListener, true)
    bind(document, 'pointerup', onPointerUp as unknown as EventListener, true)
    bind(window, 'scroll', onScrollOrResize, true)
    bind(window, 'resize', onScrollOrResize)
  })

  onUnmounted(() => {
    unbind(document, 'mouseup', onSelectEnd as EventListener)
    unbind(document, 'touchend', onSelectEnd as EventListener)
    unbind(document, 'keyup', onKeyUp as EventListener)
    unbind(document, 'selectionchange', onSelectionChange)
    unbind(document, 'mousedown', rememberPressPoint, true)
    unbind(document, 'touchstart', rememberPressPoint, true)
    unbind(document, 'mousedown', onPointerDown as unknown as EventListener, true)
    unbind(document, 'mousemove', onPointerMove as unknown as EventListener, true)
    unbind(document, 'mouseup', onPointerUp as unknown as EventListener, true)
    unbind(document, 'touchstart', onTouchStart as EventListener, true)
    unbind(document, 'touchmove', onTouchMove as EventListener, true)
    unbind(document, 'pointerdown', onPointerDown as unknown as EventListener, true)
    unbind(document, 'pointermove', onPointerMove as unknown as EventListener, true)
    unbind(document, 'pointerup', onPointerUp as unknown as EventListener, true)
    unbind(window, 'scroll', onScrollOrResize, true)
    unbind(window, 'resize', onScrollOrResize)
    if (scrollRaf && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(scrollRaf)
    }
    cancelShowTimer()
    cancelRetryTimer()
  })

  return {
    visible,
    selectedText,
    top,
    left,
    toolbarRef,
    hide,
  }
}
