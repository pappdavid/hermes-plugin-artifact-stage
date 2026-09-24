const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

function findType(node, type) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findType(child, type)
      if (match) return match
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (node.type === type) return node
  return findType(node.children, type)
}

test('loads remote artifact bytes through the authenticated plugin REST API', async () => {
  const filename = path.join(__dirname, 'desktop/plugin.js')
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replace('export default {', 'const plugin = {')

  const image = { id: 'demo.png', title: 'Demo image', kind: 'image' }
  const hookValues = [
    { seq: 1, cmd: 'open', artifact: image, view: { zoom: 1, scroll_pct: 0 } },
    null,
    image,
    1,
    null,
    null,
    'Check the selected heading',
    null,
    false,
    false,
    { x: 0.1, y: 0.2, w: 0.3, h: 0.4, normalized: true },
  ]
  let hookIndex = 0
  let effects = []
  const apiCalls = []
  const talkBodies = []
  const jsx = (type, props = {}) => ({ type, props })
  const hooks = {
    useState: (initial) => {
      const index = hookIndex++
      if (index >= hookValues.length) hookValues[index] = initial
      return [hookValues[index], (value) => {
        hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value
      }]
    },
    useEffect: (effect) => effects.push(effect),
    useRef: (current) => ({ current }),
  }
  const loadPlugin = new Function(
    'cn', 'jsx', 'jsxs', 'Fragment', 'useEffect', 'useRef', 'useState', 'host',
    `${source}\nreturn plugin;`,
  )
  const plugin = loadPlugin((...parts) => parts.filter(Boolean).join(' '), jsx, jsx, {},
    hooks.useEffect, hooks.useRef, hooks.useState, {
      state: { focusedSessionProfile: { get: () => 'verifier' } },
    })
  const contributions = []
  plugin.register({
    register: (contribution) => contributions.push(contribution),
    rest: async (apiPath, options) => {
      apiCalls.push(apiPath)
      if (apiPath === '/file-data-url/demo.png') {
        return { data_url: 'data:image/png;base64,aGVsbG8=' }
      }
      if (apiPath === '/talk') {
        talkBodies.push(options?.body)
        return { id: 'refer-1', delivered: true, delivery_status: 'queued' }
      }
      throw new Error(`unexpected plugin API path: ${apiPath}`)
    },
  })

  function render(element) {
    if (Array.isArray(element)) return element.map(render)
    if (!element || typeof element !== 'object' || !('type' in element)) return element
    if (typeof element.type === 'function') return render(element.type(element.props || {}))
    const props = element.props || {}
    return { type: element.type, props, children: render(props.children) }
  }

  const pane = contributions.find((item) => item.area === 'panes')
  assert.ok(pane, 'the plugin registers its pane')

  function renderPane() {
    hookIndex = 0
    effects = []
    return render(pane.render())
  }

  renderPane()
  effects.at(-1)()
  await new Promise((resolve) => setImmediate(resolve))

  const imageNode = findType(renderPane(), 'img')
  assert.ok(imageNode, 'the staged image is rendered')
  assert.deepEqual(apiCalls, ['/file-data-url/demo.png'])
  assert.equal(imageNode.props.src, 'data:image/png;base64,aGVsbG8=')
  assert.equal(
    new URL(imageNode.props.src, 'file:///Applications/Hermes.app/index.html').protocol,
    'data:',
  )

  const form = findType(renderPane(), 'form')
  await form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(apiCalls, ['/file-data-url/demo.png', '/talk'])
  assert.equal(talkBodies.length, 1)
  assert.equal(talkBodies[0].prompt, 'Check the selected heading')
  assert.equal(talkBodies[0].profile, 'verifier')
  assert.equal(talkBodies[0].artifact_title, 'Demo image')
  assert.deepEqual(talkBodies[0].region, { x: 0.1, y: 0.2, w: 0.3, h: 0.4, normalized: true })
})
