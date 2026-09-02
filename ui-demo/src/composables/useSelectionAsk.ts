import { onMounted, onUnmounted, ref, type Ref } from 'vue'

export interface SelectionAskPayload {
  text: string
  rect: DOMRect
  range?: Range
  anchorNode?: Node
}

interface MonacoLikeEditor {
  getDomNode?: () => HTMLElement | null
  getSelection?: () => {
    isEmpty: () => boolean
    getStartPosition: () => unknown
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

type ComposedSelection = Selection & {
  getComposedRanges?: (options?: { shadowRoots?: ShadowRoot[] }) => StaticRange[]
}

type CaretPositionFromPoint = (
  x: number,
  y: number,
  options?: { shadowRoots?: ShadowRoot[] },
) => CaretPoint | null

function isInsideRoot(root: HTMLElement, node: Node | null): boolean {
  let current: Node | null = node
  while (current) {
    if (current === root) return true
    if (current instanceof ShadowRoot) {
      current = current.host
      continue
    }
    if (current instanceof Element && (root === current || root.contains(current))) {
      return true
    }
    current = current.parentNode
  }
  return false
}

function isDiffsSurface(node: EventTarget | null): boolean {
  return (
    node instanceof Element &&
    (node.classList.contains('stream-diffs-surface') ||
      node.classList.contains('diffs-surface') ||
      node.tagName.toLowerCase() === 'diffs-container')
  )
}

function firstVisibleRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
  if (rects.length) return rects[0] ?? null
  const fallback = range.getBoundingClientRect()
  if (fallback.width || fallback.height) return fallback
  return null
}

function toDOMRect(rect: DOMRectReadOnly): DOMRect {
  return new DOMRect(rect.left, rect.top, rect.width, rect.height)
}

function intersectRects(a: DOMRect, b: DOMRect): DOMRect {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top))
}

function viewportRect() {
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

function isScrollableOverflow(value: string) {
  return value === 'auto' || value === 'scroll' || value === 'overlay' || value === 'hidden'
}

function getClipRect(node: Node | null): DOMRect {
  let clip = viewportRect()
  let current: Node | null = node
  while (current) {
    if (current instanceof HTMLElement) {
      const style = window.getComputedStyle(current)
      if (isScrollableOverflow(style.overflowX) || isScrollableOverflow(style.overflowY)) {
        clip = intersectRects(clip, toDOMRect(current.getBoundingClientRect()))
      }
    }
    const root = current.getRootNode()
    if (root instanceof ShadowRoot) {
      current = root.host
      continue
    }
    current = current instanceof Element ? current.parentElement : null
  }
  return clip
}

function livePayloadRect(payload: SelectionAskPayload): DOMRect | null {
  if (payload.range) {
    try {
      const rect = firstVisibleRect(payload.range)
      if (rect) return rect
    } catch {
      // range may be detached after DOM updates
    }
  }
  return payload.rect
}

function visibleAnchorRect(payload: SelectionAskPayload): DOMRect | null {
  const rect = livePayloadRect(payload)
  if (!rect) return null
  const anchorNode = payload.range?.commonAncestorContainer ?? payload.anchorNode ?? null
  const clip = getClipRect(anchorNode)
  const visibleRect = intersectRects(rect, clip)
  if (visibleRect.width < 4 || visibleRect.height < 4) return null
  return visibleRect
}

function payloadFromRange(range: Range, root: HTMLElement): SelectionAskPayload | null {
  const text = range.toString()
  if (!text.trim()) return null
  if (!isInsideRoot(root, range.commonAncestorContainer) && !isInCollectedShadow(range.commonAncestorContainer, root)) {
    return null
  }
  const rect = firstVisibleRect(range)
  if (!rect) return null
  return { text, rect, range: range.cloneRange() }
}

function isInCollectedShadow(node: Node, lightRoot: HTMLElement): boolean {
  let current: Node | null = node
  while (current) {
    if (current === lightRoot) return true
    const root = current.getRootNode()
    if (root instanceof ShadowRoot) {
      current = root.host
      continue
    }
    break
  }
  return current instanceof Node && lightRoot.contains(current as Node)
}

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
  if (root instanceof Element && root.shadowRoot) {
    shadows.push(root.shadowRoot)
    visit(root.shadowRoot)
  }
  visit(root)
  return shadows
}

function shadowsFromEvent(event: Event): ShadowRoot[] {
  return event.composedPath().filter((node): node is ShadowRoot => node instanceof ShadowRoot)
}

function getSelectionFromSelectionObject(selection: Selection | null, root: HTMLElement): SelectionAskPayload | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const range = selection.getRangeAt(0)
  if (
    !isInsideRoot(root, range.commonAncestorContainer) &&
    !isInCollectedShadow(range.commonAncestorContainer, root)
  ) {
    return null
  }
  const rect = firstVisibleRect(range)
  if (!rect) return null
  return { text, rect, range: range.cloneRange() }
}

function getNativeSelection(root: HTMLElement): SelectionAskPayload | null {
  return getSelectionFromSelectionObject(window.getSelection(), root)
}

function getShadowRootSelection(root: HTMLElement): SelectionAskPayload | null {
  for (const shadow of collectShadowRoots(root)) {
    const selection = (shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? null
    const payload = getSelectionFromSelectionObject(selection, root)
    if (payload) return payload
  }
  return null
}

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
      pos = doc.caretPositionFromPoint(x, y) ?? null
    }
    if (pos?.offsetNode) return { offsetNode: pos.offsetNode, offset: pos.offset }
  }
  const range = doc.caretRangeFromPoint?.(x, y)
  if (range) return { offsetNode: range.startContainer, offset: range.startOffset }
  return null
}

function rangeFromCarets(start: CaretPoint, end: CaretPoint): Range | null {
  const range = document.createRange()
  const apply = (from: CaretPoint, to: CaretPoint) => {
    range.setStart(from.offsetNode, from.offset)
    range.setEnd(to.offsetNode, to.offset)
  }
  try {
    apply(start, end)
    if (!range.collapsed) return range
    apply(end, start)
    return range.collapsed ? null : range
  } catch {
    try {
      apply(end, start)
      return range.collapsed ? null : range
    } catch {
      return null
    }
  }
}

function payloadFromMonacoEditor(root: HTMLElement, editor: MonacoLikeEditor | null | undefined): SelectionAskPayload | null {
  if (!editor) return null
  const node = editor.getDomNode?.()
  if (!node || !root.contains(node)) return null

  const selection = editor.getSelection?.()
  const model = editor.getModel?.()
  if (!selection || !model || selection.isEmpty()) return null

  const text = model.getValueInRange(selection)
  if (!text?.trim()) return null

  const start = editor.getScrolledVisiblePosition?.(selection.getStartPosition())
  const editorRect = node.getBoundingClientRect()
  const rect = start
    ? new DOMRect(
        editorRect.left + start.left,
        editorRect.top + start.top,
        8,
        start.height ?? 18,
      )
    : editorRect

  return { text, rect, anchorNode: node }
}

function getMonacoEditors(root: HTMLElement): MonacoLikeEditor[] {
  const monaco = (window as unknown as { monaco?: MonacoGlobal }).monaco
  if (!monaco?.editor) return []

  const editors: MonacoLikeEditor[] = []
  for (const editor of monaco.editor.getEditors?.() ?? []) {
    const node = editor.getDomNode?.()
    if (node && root.contains(node)) editors.push(editor)
  }
  for (const diff of monaco.editor.getDiffEditors?.() ?? []) {
    const modified = diff.getModifiedEditor?.()
    const original = diff.getOriginalEditor?.()
    const modifiedNode = modified?.getDomNode?.()
    const originalNode = original?.getDomNode?.()
    if (modified && modifiedNode && root.contains(modifiedNode)) editors.push(modified)
    if (original && originalNode && root.contains(originalNode)) editors.push(original)
  }
  return editors
}

function firstMonacoOverlayRect(editorEl: Element): DOMRect | null {
  const nodes = editorEl.querySelectorAll('.selected-text, .inline-selected-text')
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.width > 1 && rect.height > 1) return rect
  }
  return null
}

function getMonacoTextareaSelection(root: HTMLElement): SelectionAskPayload | null {
  const areas = root.querySelectorAll<HTMLTextAreaElement>('.monaco-editor textarea.inputarea')
  for (const area of areas) {
    if (!root.contains(area)) continue
    const start = area.selectionStart ?? 0
    const end = area.selectionEnd ?? 0
    if (end <= start) continue
    const text = area.value.slice(start, end)
    if (!text.trim()) continue
    const editorEl = area.closest('.monaco-editor')
    const rect = (editorEl && firstMonacoOverlayRect(editorEl)) || area.getBoundingClientRect()
    return { text, rect, anchorNode: area }
  }
  return null
}

function getMonacoSelection(root: HTMLElement): SelectionAskPayload | null {
  for (const editor of getMonacoEditors(root)) {
    const payload = payloadFromMonacoEditor(root, editor)
    if (payload) return payload
  }
  return getMonacoTextareaSelection(root)
}

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

function isSelectionInsideRoot(root: HTMLElement, selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0) return false
  const node = selection.getRangeAt(0).commonAncestorContainer
  return isInsideRoot(root, node) || isInCollectedShadow(node, root)
}

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

function getComposedSelectionFromEvent(root: HTMLElement, event: Event): SelectionAskPayload | null {
  const selection = window.getSelection() as ComposedSelection | null
  if (!selection?.getComposedRanges) return null
  const shadows = [...new Set([...shadowsFromEvent(event), ...collectShadowRoots(root)])]
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

function readLiveSelection(root: HTMLElement, event?: Event): SelectionAskPayload | null {
  return (
    getNativeSelection(root) ||
    getShadowRootSelection(root) ||
    getComposedSelection(root) ||
    getMonacoSelection(root) ||
    (event ? getComposedSelectionFromEvent(root, event) : null)
  )
}

export function useSelectionAsk(rootRef: Ref<HTMLElement | null>) {
  const visible = ref(false)
  const selectedText = ref('')
  const top = ref(0)
  const left = ref(0)
  const toolbarRef = ref<HTMLElement | null>(null)

  let cachedPayload: SelectionAskPayload | null = null
  let streamDiffsDrag: StreamDiffsDrag | null = null
  let streamDiffsPayload: SelectionAskPayload | null = null

  let skipNextSync = false
  let lastGestureWasDrag = false
  let showTimer = 0
  let scrollRaf = 0
  let gesture: {
    startX: number
    startY: number
    onToolbarEl: boolean
    overToolbarRect: boolean
    inRoot: boolean
    hadToolbar: boolean
  } | null = null

  const CLICK_SLOP = 6
  const SHOW_DELAY = 320

  function cancelShowTimer() {
    if (!showTimer) return
    window.clearTimeout(showTimer)
    showTimer = 0
  }

  function scheduleShow(payload: SelectionAskPayload, immediate = false) {
    cachedPayload = payload
    if (immediate || visible.value) {
      cancelShowTimer()
      place(payload)
      return
    }
    cancelShowTimer()
    showTimer = window.setTimeout(() => {
      showTimer = 0
      if (cachedPayload) place(cachedPayload)
    }, SHOW_DELAY)
  }

  function isPointOverToolbar(event: Event) {
    const toolbar = toolbarRef.value
    if (!toolbar || !visible.value) return false
    if (!('clientX' in event) || typeof (event as MouseEvent).clientX !== 'number') return false
    const rect = toolbar.getBoundingClientRect()
    const x = (event as MouseEvent).clientX
    const y = (event as MouseEvent).clientY
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  function isEventOnToolbarEl(event: Event) {
    const toolbar = toolbarRef.value
    if (!toolbar || !visible.value) return false
    return event.composedPath().includes(toolbar)
  }

  function gestureDistance(event: { clientX: number; clientY: number }) {
    if (!gesture) return 0
    return Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY)
  }

  function releasePointerCaptures(event: PointerEvent) {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.hasPointerCapture?.(event.pointerId)) {
        node.releasePointerCapture(event.pointerId)
      }
    }
  }

  function triggerToolbarButtonClick() {
    toolbarRef.value?.querySelector('button')?.click()
  }

  function isEventInRoot(event: Event) {
    const root = rootRef.value
    if (!root) return false
    return event.composedPath().includes(root)
  }

  function isFocusInRoot() {
    const root = rootRef.value
    const active = document.activeElement
    return !!(root && active && (root === active || root.contains(active)))
  }

  function dismissToolbarKeepSelection() {
    cancelShowTimer()
    visible.value = false
    selectedText.value = ''
    cachedPayload = null
    streamDiffsPayload = null
    streamDiffsDrag = null
  }

  function hide() {
    skipNextSync = true
    dismissToolbarKeepSelection()
    clearBrowserSelection(rootRef.value)
  }

  function hideToolbarOnly() {
    visible.value = false
  }

  function place(payload: SelectionAskPayload) {
    const anchor = visibleAnchorRect(payload)
    if (!anchor) {
      hideToolbarOnly()
      return
    }

    selectedText.value = payload.text
    const toolbarEl = toolbarRef.value
    const toolbarWidth = toolbarEl?.offsetWidth ?? 140
    const toolbarHeight = toolbarEl?.offsetHeight ?? 40
    const gap = 8
    const clip = getClipRect(payload.range?.commonAncestorContainer ?? payload.anchorNode ?? null)
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
  }

  function syncFromSelection(event?: Event, immediate = false) {
    const root = rootRef.value
    if (!root) {
      dismissToolbarKeepSelection()
      return
    }
    const payload = readLiveSelection(root, event) || streamDiffsPayload || cachedPayload
    if (payload) {
      scheduleShow(payload, immediate)
    } else {
      dismissToolbarKeepSelection()
    }
  }

  function updateToolbarForViewport() {
    const root = rootRef.value
    if (!root || (!visible.value && !cachedPayload && !streamDiffsPayload)) return
    const payload = readLiveSelection(root) || streamDiffsPayload || cachedPayload
    if (!payload) {
      hideToolbarOnly()
      return
    }
    cachedPayload = payload
    place(payload)
  }

  function onSelectEnd(event: Event) {
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
    syncFromSelection(event, lastGestureWasDrag)
    requestAnimationFrame(() => {
      if (skipNextSync) return
      syncFromSelection(event, lastGestureWasDrag)
    })
  }

  function onSelectionChange() {
    const root = rootRef.value
    if (!root) return
    const payload = readLiveSelection(root)
    if (payload) cachedPayload = payload
  }

  function onKeyUp(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (visible.value || cachedPayload || streamDiffsPayload) hide()
      return
    }
    if (!isEventInRoot(event) && !isFocusInRoot()) return
    if (event.shiftKey || event.key.startsWith('Arrow')) {
      requestAnimationFrame(() => syncFromSelection(undefined, true))
    }
  }

  function onScrollOrResize() {
    if (scrollRaf) return
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0
      updateToolbarForViewport()
    })
  }

  function onPointerDown(event: PointerEvent) {
    const isMultiClick = event.detail >= 2
    if (!isMultiClick) skipNextSync = false
    const inRoot = isEventInRoot(event)
    const onToolbarEl = isEventOnToolbarEl(event)
    const overToolbarRect = isPointOverToolbar(event)

    gesture = {
      startX: event.clientX,
      startY: event.clientY,
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

    const path = event.composedPath()
    const inSurface = path.some((node) => isDiffsSurface(node))
    if (inSurface) {
      const shadows = shadowsFromEvent(event)
      streamDiffsDrag = {
        shadows,
        start: caretFromPoint(event.clientX, event.clientY, shadows),
      }
      return
    }

    streamDiffsDrag = null
  }

  function onPointerMove(event: PointerEvent) {
    if (!gesture || gesture.onToolbarEl) return
    if (gestureDistance(event) < CLICK_SLOP) return
    if (visible.value) dismissToolbarKeepSelection()
  }

  function onPointerUp(event: PointerEvent) {
    const current = gesture
    gesture = null
    const dist = current ? Math.hypot(event.clientX - current.startX, event.clientY - current.startY) : 0
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

    const shadows = [...drag.shadows, ...shadowsFromEvent(event), ...collectShadowRoots(root)]
    const uniqueShadows = [...new Set(shadows)]
    const end = caretFromPoint(event.clientX, event.clientY, uniqueShadows)
    const start = drag.start || end
    if (!start || !end) return

    const range = rangeFromCarets(start, end)
    if (!range) return
    const payload = payloadFromRange(range, root)
    if (payload) streamDiffsPayload = payload
  }

  onMounted(() => {
    document.addEventListener('mouseup', onSelectEnd)
    document.addEventListener('touchend', onSelectEnd)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
  })

  onUnmounted(() => {
    document.removeEventListener('mouseup', onSelectEnd)
    document.removeEventListener('touchend', onSelectEnd)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize)
    if (scrollRaf) window.cancelAnimationFrame(scrollRaf)
    cancelShowTimer()
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
