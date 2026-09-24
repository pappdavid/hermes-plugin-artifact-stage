/**
 * Artifact Stage — a desktop pane the session drives.
 *
 * Control state lives server-side in <hermes home>/runtime/artifact-stage/
 * (state.json written by ANY session via ~/.hermes/bin/artifact-stage —
 * file-based on purpose: sessions never call the dashboard API). This pane
 * polls the python backend (/api/plugins/artifact-stage/state), renders the
 * staged artifact, applies scroll/zoom commands, and POSTs /ack receipts.
 */
import { cn } from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const ID = 'artifact-stage'
const POLL_MS = 900

let api = null // bound in register() before any render

function fileUrl(artifact, seq) {
  return `/api/plugins/artifact-stage/file/${encodeURIComponent(artifact.id)}?v=${seq}`
}

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

function ArtifactBody({ artifact, seq, zoom, scrollRef }) {
  const scaleStyle = {
    transform: `scale(${zoom})`,
    transformOrigin: 'top left',
    width: `${100 / zoom}%`,
  }
  const url = fileUrl(artifact, seq)

  let content
  if (artifact.kind === 'pdf') {
    content = jsx('embed', { src: url, type: 'application/pdf', className: 'w-full h-full min-h-[400px]' })
  } else if (artifact.kind === 'image') {
    content = jsx('div', {
      style: scaleStyle,
      children: jsx('img', { src: url, alt: artifact.title, className: 'max-w-full' }),
    })
  } else if (artifact.kind === 'html') {
    content = jsx('iframe', {
      src: url,
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

  return jsx('div', {
    ref: scrollRef,
    className: 'min-h-0 flex-1 overflow-auto',
    children,
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

  useEffect(() => {
    let live = true
    const tick = async () => {
      try {
        const s = await api.rest('/state')
        if (!live) return
        setConnErr(null)
        setState(s)
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
          setZoom((state.view && state.view.zoom) || 1)
          pendingScrollRef.current = state.view ? state.view.scroll_pct : 0
        } else if (state.cmd === 'scroll') {
          pendingScrollRef.current = state.view ? state.view.scroll_pct : 0
        } else if (state.cmd === 'zoom') {
          setZoom((state.view && state.view.zoom) || 1)
        } else if (state.cmd === 'clear') {
          setArtifact(null)
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

  const toolbar = jsxs('div', {
    className: 'flex items-center gap-1.5 border-b border-(--ui-stroke-secondary) px-2 py-1',
    children: [
      jsx('div', {
        className: 'min-w-0 flex-1 truncate text-xs font-medium text-(--ui-text-primary)',
        children: artifact ? artifact.title : 'Artifact Stage',
      }),
      artifact && jsx(Badge, { children: artifact.kind }),
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
    body = jsx(ArtifactBody, { artifact, seq: state.seq, zoom, scrollRef })
  }

  const statusLine = state
    ? `seq ${state.seq} · ${state.cmd} · ack ${lastAck ? (lastAck.ok || lastAck.rendered ? 'ok' : 'fail') : '—'}`
    : 'connecting…'

  return jsxs('div', { className: 'flex h-full flex-col', children: [toolbar, body, jsx('div', {
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
  },
}
