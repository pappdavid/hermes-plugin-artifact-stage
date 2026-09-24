const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

function findType(node, type) {
  if (Array.isArray(node)) return node.some((child) => findType(child, type))
  if (!node || typeof node !== 'object') return false
  return node.type === type || findType(node.children, type)
}

test('renders the staged image in the desktop pane', () => {
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
  ]
  const jsx = (type, props = {}) => ({ type, props })
  const hooks = {
    useState: () => [hookValues.shift(), () => {}],
    useEffect: () => {},
    useRef: (current) => ({ current }),
  }
  const loadPlugin = new Function(
    'cn', 'jsx', 'jsxs', 'Fragment', 'useEffect', 'useRef', 'useState',
    `${source}\nreturn plugin;`,
  )
  const plugin = loadPlugin((...parts) => parts.filter(Boolean).join(' '), jsx, jsx, {},
    hooks.useEffect, hooks.useRef, hooks.useState)
  const contributions = []
  plugin.register({ register: (contribution) => contributions.push(contribution) })

  function render(element) {
    if (Array.isArray(element)) return element.map(render)
    if (!element || typeof element !== 'object' || !('type' in element)) return element
    if (typeof element.type === 'function') return render(element.type(element.props || {}))
    return { type: element.type, children: render(element.props && element.props.children) }
  }

  const pane = contributions.find((item) => item.area === 'panes')
  assert.ok(pane, 'the plugin registers its pane')
  assert.ok(findType(render(pane.render()), 'img'), 'the rendered pane contains the staged image')
})
