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
    null,
  ]
  let hookIndex = 0
  let effects = []
  const apiCalls = []
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
    'cn', 'host', 'jsx', 'jsxs', 'Fragment', 'useEffect', 'useRef', 'useState',
    `${source}\nreturn plugin;`,
  )
  const host = { revealPane: () => {}, composer: { submit: () => false } }
  const plugin = loadPlugin((...parts) => parts.filter(Boolean).join(' '), host, jsx, jsx, {},
    hooks.useEffect, hooks.useRef, hooks.useState)
  const contributions = []
  plugin.register({
    register: (contribution) => contributions.push(contribution),
    rest: async (apiPath) => {
      apiCalls.push(apiPath)
      if (apiPath === '/file-data-url/demo.png') {
        return { data_url: 'data:image/png;base64,aGVsbG8=' }
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
  const artifactLoadEffect = effects.find((effect) => effect.toString().includes('/file-data-url/'))
  assert.ok(artifactLoadEffect, 'the remote-artifact loading effect is registered')
  artifactLoadEffect()
  await new Promise((resolve) => setImmediate(resolve))

  const imageNode = findType(renderPane(), 'img')
  assert.ok(imageNode, 'the staged image is rendered')
  assert.deepEqual(apiCalls, ['/file-data-url/demo.png'])
  assert.equal(imageNode.props.src, 'data:image/png;base64,aGVsbG8=')
  assert.equal(
    new URL(imageNode.props.src, 'file:///Applications/Hermes.app/index.html').protocol,
    'data:',
  )
})

test('provides Refer for every artifact kind and token-checked composer bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, 'desktop/plugin.js'), 'utf8')
  for (const kind of ['pdf', 'image', 'markdown', 'html']) {
    assert.ok(source.includes(`'${kind}'`), `the pane handles ${kind}`)
  }
  assert.ok(source.includes("const referBar = artifact && REFER_KINDS.has(artifact.kind) && jsxs('form'"))
  assert.ok(source.includes('request_id: crypto.randomUUID()'))
  assert.ok(source.includes('body: { seq: s.seq, heartbeat: true }'))
  assert.ok(source.includes('event.source !== frameRef.current.contentWindow'))
  assert.ok(source.includes('message.token !== frameToken.current'))
  assert.ok(source.includes("host.composer?.submit === 'function' && host.composer.submit(null, prompt)"))
  assert.ok(source.includes('onFramePrompt(prompt)'))
  assert.ok(source.includes('srcDoc: frameDoc'))
})
