/**
 * Artifact Stage — a desktop pane the session drives.
 *
 * Control state lives server-side in <hermes home>/runtime/artifact-stage/
 * (state.json written by ANY session via ~/.hermes/bin/artifact-stage —
 * file-based on purpose: sessions never call the dashboard API). This pane
 * polls the python backend (/api/plugins/artifact-stage/state), renders the
 * staged artifact, applies scroll/zoom commands, and POSTs /ack receipts.
 */
import { cn, host } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const ID = 'artifact-stage'
const POLL_MS = 900
const URL_KINDS = new Set(['pdf', 'image', 'html'])

let api = null // bound in register() before any render

function Badge({ children }) {
  return jsx('span', {
    className: cn(
      'inline-flex items-center rounded px-1.5 py-0.5 text-[0.6875rem] font-medium',
      'border border-(--ui-stroke-secondary) text-(--ui-text-secondary)'
    ),
    children,
  })
}

function ToolButton({ label, onClick, children }) {
  return jsx('button', {
    type: 'button',
    title: label,
    onClick,
    className: cn(
      'inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs',
      'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
    ),
    children,
  })
}

function ArtifactBody({ artifact, seq, zoom, scrollRef, viewportRef, selectionMode, selectionRegion, onRegionSelected }) {
  const scaleStyle = {
    transform: `scale(${zoom})`,
    transformOrigin: 'top left',
    width: `${100 / zoom}%`,
  }
  // Bytes are fetched through the plugin bridge (hermes:api carries auth) and
  // rendered from the returned data URL: relative /api/... URLs only resolve
  // when the renderer origin IS the backend, which is false for remote clients.
  const [artifactUrl, setArtifactUrl] = useState(null)
  const [loadErr, setLoadErr] = useState(null)

  useEffect(() => {
    if (!URL_KINDS.has(artifact.kind)) return undefined
    let live = true
    setArtifactUrl(null)
    setLoadErr(null)
    ;(async () => {
      try {
        const result = await api.rest(`/file-data-url/${encodeURIComponent(artifact.id)}`)
        if (!result || typeof result.data_url !== 'string' || !result.data_url.startsWith('data:')) {
          throw new Error('Plugin API returned invalid artifact data')
        }
        if (live) setArtifactUrl(result.data_url)
      } catch (e) {
        if (live) setLoadErr(String((e && e.message) || e))
      }
    })()
    return () => { live = false }
  }, [artifact.id, seq])

  let content
  if (URL_KINDS.has(artifact.kind) && !artifactUrl) {
    content = jsx('div', {
      className: 'p-3 text-xs text-(--ui-text-tertiary)',
      children: loadErr || 'loading artifact…',
    })
  } else if (artifact.kind === 'pdf') {
    content = jsx('embed', { src: artifactUrl, type: 'application/pdf', className: 'w-full h-full min-h-[400px]' })
  } else if (artifact.kind === 'image') {
    content = jsx('div', {
      style: scaleStyle,
      children: jsx('img', { src: artifactUrl, alt: artifact.title, className: 'max-w-full' }),
    })
  } else if (artifact.kind === 'html') {
    content = jsx('iframe', {
      src: artifactUrl,
      sandbox: 'allow-scripts',
      className: 'w-full h-full min-h-[400px] bg-white',
      title: artifact.title,
    })
  } else {
    // text / markdown (and fallback): monospace pre, session-scrollable
    content = jsx('div', {
      style: scaleStyle,
      children: jsx('pre', {
        className: cn(
          'whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs',
          'text-(--ui-text-primary)'
        ),
        children: artifact.text || '(no text payload — non-text file staged?)',
      }),
    })
  }

  const dragStartRef = useRef(null)
  const [draftRegion, setDraftRegion] = useState(null)
  const pointFor = (event) => {
    const bounds = viewportRef.current && viewportRef.current.getBoundingClientRect()
    if (!bounds || !bounds.width || !bounds.height) return null
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    }
  }
  const finishSelection = (event) => {
    if (!dragStartRef.current) return
    const point = pointFor(event)
    const start = dragStartRef.current
    dragStartRef.current = null
    if (!point) return
    const region = {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
      normalized: true,
    }
    if (region.w > 0.002 && region.h > 0.002) {
      setDraftRegion(null)
      onRegionSelected(region)
    }
  }
  const visibleRegion = draftRegion || selectionRegion
  const selectionLayer = selectionMode && jsx('div', {
    className: 'absolute inset-0 z-10 cursor-crosshair',
    style: { background: 'transparent', touchAction: 'none' },
    onMouseDown: (event) => {
      event.preventDefault()
      const point = pointFor(event)
      if (point) {
        dragStartRef.current = point
        setDraftRegion(null)
      }
    },
    onMouseMove: (event) => {
      if (!dragStartRef.current) return
      const point = pointFor(event)
      if (!point) return
      const start = dragStartRef.current
      setDraftRegion({
        x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x), h: Math.abs(point.y - start.y), normalized: true,
      })
    },
    onMouseUp: finishSelection,
    onMouseLeave: finishSelection,
  })
  const selectionOverlay = visibleRegion && jsx('div', {
    className: 'pointer-events-none absolute inset-0 z-20',
    children: jsx('div', {
      className: 'absolute border border-(--ui-accent)',
      style: {
        left: `${visibleRegion.x * 100}%`, top: `${visibleRegion.y * 100}%`,
        width: `${visibleRegion.w * 100}%`, height: `${visibleRegion.h * 100}%`,
        background: 'color-mix(in srgb, var(--ui-accent) 20%, transparent)',
      },
    }),
  })

  return jsx('div', {
    ref: viewportRef,
    className: 'relative min-h-0 flex-1 overflow-hidden',
    children: [
      jsx('div', {
        ref: scrollRef,
        className: 'absolute inset-0 overflow-auto',
        children: jsx('div', { className: 'relative min-h-full w-full', children: content }),
      }),
      selectionLayer,
      selectionOverlay,
    ],
  })
}

function StagePane() {
  const [state, setState] = useState(null)
  const [connErr, setConnErr] = useState(null)
  const [artifact, setArtifact] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [lastAck, setLastAck] = useState(null)
  const appliedSeqRef = useRef(-1)
  const pendingScrollRef = useRef(null)
  const scrollRef = useRef(null)
  const viewportRef = useRef(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [talkPrompt, setTalkPrompt] = useState('')
  const [talkError, setTalkError] = useState(null)
  const [sendingTalk, setSendingTalk] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectionRegion, setSelectionRegion] = useState(null)

  useEffect(() => {
    let live = true
    const tick = async () => {
      try {
        const talks = await api.rest('/talks')
        if (live) setPendingCount(Array.isArray(talks.pending) ? talks.pending.length : 0)
      } catch (_) {
        // The pane's main connection status covers backend errors.
      }
    }
    void tick()
    const iv = setInterval(() => void tick(), 2000)
    return () => { live = false; clearInterval(iv) }
  }, [])

  useEffect(() => {
    let live = true
    const tick = async () => {
      try {
        const s = await api.rest('/state')
        if (!live) return
        setConnErr(null)
        setState(s)
        // A poll is a liveness heartbeat even when the staged state is unchanged.
        try {
          const ack = await api.rest('/ack', {
            method: 'POST',
            body: { seq: s.seq, heartbeat: true },
          })
          if (live) setLastAck(ack)
        } catch (_) {
          // Keep polling; the next heartbeat will retry.
        }
      } catch (e) {
        if (live) setConnErr(String((e && e.message) || e))
      }
    }
    void tick()
    const iv = setInterval(() => void tick(), POLL_MS)
    return () => { live = false; clearInterval(iv) }
  }, [])

  useEffect(() => {
    if (!state || state.seq === appliedSeqRef.current) return
    appliedSeqRef.current = state.seq
    const apply = async () => {
      let rendered = true
      let errMsg = null
      try {
        if (state.cmd === 'open') {
          setArtifact(state.artifact || null)
          setSelectionRegion(null)
          setSelectionMode(false)
          setZoom((state.view && state.view.zoom) || 1)
          pendingScrollRef.current = state.view ? state.view.scroll_pct : 0
        } else if (state.cmd === 'scroll') {
          pendingScrollRef.current = state.view ? state.view.scroll_pct : 0
        } else if (state.cmd === 'zoom') {
          setZoom((state.view && state.view.zoom) || 1)
        } else if (state.cmd === 'clear') {
          setArtifact(null)
          setSelectionRegion(null)
          setSelectionMode(false)
        }
      } catch (e) {
        rendered = false
        errMsg = String((e && e.message) || e)
      }
      try {
        const ack = await api.rest('/ack', {
          method: 'POST',
          body: { seq: state.seq, rendered, error: errMsg },
        })
        setLastAck(ack)
      } catch (e) {
        setLastAck({ ok: false, error: String((e && e.message) || e) })
      }
    }
    void apply()
  }, [state])

  useEffect(() => {
    if (pendingScrollRef.current == null || !scrollRef.current) return
    const el = scrollRef.current
    const pct = pendingScrollRef.current
    pendingScrollRef.current = null
    requestAnimationFrame(() => {
      el.scrollTop = pct * Math.max(0, el.scrollHeight - el.clientHeight)
    })
  }, [artifact, zoom, state])

  const safePrompt = typeof talkPrompt === 'string' ? talkPrompt : ''
  const submitTalk = async (event) => {
    event.preventDefault()
    if (!safePrompt.trim() || sendingTalk) return
    setSendingTalk(true)
    setTalkError(null)
    try {
      await api.rest('/talk', {
        method: 'POST',
        body: {
          request_id: crypto.randomUUID(),
          prompt: safePrompt.trim(),
          profile: (host.state && host.state.focusedSessionProfile && host.state.focusedSessionProfile.get()) || 'default',
          artifact_title: artifact ? artifact.title : 'current artifact',
          ...(selectionRegion ? { region: selectionRegion } : {}),
          ...(artifact ? { artifact_id: artifact.id } : {}),
        },
      })
      setTalkPrompt('')
    } catch (e) {
      setTalkError(String((e && e.message) || e))
    } finally {
      setSendingTalk(false)
    }
  }
  const supportsRegion = Boolean(artifact)

  const toolbar = jsxs('div', {
    className: 'flex items-center gap-1.5 border-b border-(--ui-stroke-secondary) px-2 py-1',
    children: [
      jsx('div', {
        className: 'min-w-0 flex-1 truncate text-xs font-medium text-(--ui-text-primary)',
        children: artifact ? artifact.title : 'Artifact Stage',
      }),
      artifact && jsx(Badge, { children: artifact.kind }),
      jsx(Badge, { children: `pending ${pendingCount}` }),
      supportsRegion && jsx(ToolButton, {
        label: selectionMode ? 'cancel region highlight' : 'highlight a region to refer to',
        onClick: () => {
          if (selectionMode) setSelectionMode(false)
          else { setSelectionRegion(null); setSelectionMode(true) }
        },
        children: selectionMode ? '×' : '⌖',
      }),
      selectionRegion && jsx(ToolButton, {
        label: 'clear highlighted region',
        onClick: () => setSelectionRegion(null),
        children: '⌫',
      }),
      artifact && jsx(ToolButton, { label: 'zoom out', onClick: () => setZoom((z) => Math.max(0.25, z - 0.15)), children: '−' }),
      artifact && jsx(ToolButton, { label: 'zoom in', onClick: () => setZoom((z) => Math.min(4, z + 0.15)), children: '+' }),
      artifact && jsx(ToolButton, {
        label: 'scroll to top',
        onClick: () => { if (scrollRef.current) scrollRef.current.scrollTop = 0 },
        children: '⤒',
      }),
    ],
  })

  let body
  if (connErr) {
    body = jsxs('div', {
      className: 'p-3 text-xs text-(--ui-text-tertiary)',
      children: [
        jsx('div', { className: 'font-medium text-(--ui-text-secondary)', children: 'Backend unreachable' }),
        jsx('div', { children: 'The dashboard has not mounted /api/plugins/artifact-stage yet (needs one dashboard restart), or the connection dropped.' }),
        jsx('div', { className: 'mt-1 font-mono text-[0.625rem]', children: connErr }),
      ],
    })
  } else if (!artifact) {
    body = jsxs('div', {
      className: 'p-3 text-xs text-(--ui-text-tertiary)',
      children: [
        jsx('div', { className: 'font-medium text-(--ui-text-secondary)', children: 'Stage empty' }),
        jsx('div', {
          className: 'mt-1',
          children: 'Ask the session to put something here — it runs:',
        }),
        jsx('pre', {
          className: 'mt-1 font-mono text-[0.625rem] text-(--ui-text-tertiary)',
          children: '~/.hermes/bin/artifact-stage open <file>',
        }),
      ],
    })
  } else {
    body = jsx(ArtifactBody, {
      artifact,
      seq: state.seq,
      zoom,
      scrollRef,
      viewportRef,
      selectionMode: Boolean(supportsRegion && selectionMode),
      selectionRegion,
      onRegionSelected: (region) => {
        setSelectionRegion(region)
        setSelectionMode(false)
      },
    })
  }

  const referBar = jsxs('form', {
    onSubmit: submitTalk,
    className: 'flex items-center gap-1.5 border-t border-(--ui-stroke-secondary) px-2 py-1',
    children: [
      jsx('input', {
        type: 'text',
        maxLength: 2000,
        value: safePrompt,
        onChange: (event) => setTalkPrompt(event.target.value),
        placeholder: 'Ask about this artifact…',
        'aria-label': 'Prompt about artifact',
        className: 'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs text-(--ui-text-primary)',
      }),
      jsx('button', {
        type: 'submit',
        disabled: !safePrompt.trim() || sendingTalk,
        className: 'rounded border border-(--ui-stroke-secondary) px-2 py-1 text-xs text-(--ui-text-secondary) disabled:opacity-50',
        children: sendingTalk ? '…' : 'Refer',
      }),
      talkError && jsx('span', {
        className: 'max-w-[9rem] truncate text-[0.625rem] text-(--ui-text-tertiary)',
        title: talkError,
        children: talkError,
      }),
    ],
  })
  const statusLine = state
    ? `seq ${state.seq} · ${state.cmd} · ack ${lastAck ? (lastAck.ok || lastAck.rendered ? 'ok' : 'fail') : '—'}`
    : 'connecting…'

  return jsxs('div', { className: 'flex h-full flex-col', children: [toolbar, body, referBar, jsx('div', {
    className: 'border-t border-(--ui-stroke-secondary) px-2 py-0.5 font-mono text-[0.625rem] text-(--ui-text-quaternary)',
    children: statusLine,
  })] })
}

export default {
  id: ID, // folder name must match
  name: 'Artifact Stage',
  register(ctx) {
    api = ctx
    ctx.register({
      id: 'artifact-stage-pane',
      area: 'panes',
      title: 'Artifact Stage',
      order: 5,
      data: { placement: 'right', width: '480px' },
      render: () => jsx(StagePane, {}),
    })
    // Plugin contributions are namespaced by createPluginContext as
    // <pluginId>:<contributionId>. Reveal after registration so the pane is
    // visible on load/reload instead of silently remaining only registered.
    if (typeof host.revealPane === 'function') host.revealPane(`${ID}:artifact-stage-pane`)
  },
}
