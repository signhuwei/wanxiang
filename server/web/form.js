// 表单组件：查看与编辑同一布局，新建是空表单。字段优先下拉选择；
// 多个区块用互斥折叠（details），避免所有区块同时展开。不使用对话框或遮罩。

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

function fieldValueText(field, value) {
  if (value === null || value === undefined || value === '') return '—'
  if (field.type === 'select' && field.options) {
    const hit = field.options.find(o => String(o.value) === String(value))
    if (hit) return hit.label
  }
  if (field.format) return field.format(value)
  return String(value)
}

export function renderForm(body, { sections, values = {}, mode = 'view' }) {
  const notice = el('div', 'notice')

  function renderField(field) {
    const wrap = el('div', 'field' + (field.wide ? ' wide' : ''))
    wrap.appendChild(el('span', null, field.label))
    const editable = mode !== 'view' && !field.readonly && field.type !== 'output'
    if (!editable) {
      const out = el('output')
      out.dataset.field = field.key
      out.textContent = fieldValueText(field, values[field.key])
      wrap.appendChild(out)
      return wrap
    }
    let input
    if (field.type === 'select') {
      input = el('select')
      if (field.allowEmpty !== false) input.appendChild(el('option', null, '不限')).value = ''
      for (const o of field.options || []) {
        const opt = el('option', null, o.label)
        opt.value = o.value
        input.appendChild(opt)
      }
      const v = values[field.key]
      input.value = v === null || v === undefined ? '' : String(v)
    } else if (field.type === 'textarea') {
      input = el('textarea')
      input.value = values[field.key] ?? ''
    } else {
      input = el('input')
      input.type = ['number','email','password'].includes(field.type) ? field.type : 'text'
      if (input.type === 'password') input.autocomplete = 'new-password'
      if (field.type === 'number' && field.step) input.step = String(field.step)
      const v = values[field.key]
      input.value = v === null || v === undefined ? '' : String(v)
    }
    if (field.placeholder) input.placeholder = field.placeholder
    input.dataset.field = field.key
    input.name = field.key
    wrap.appendChild(input)
    return wrap
  }

  function render() {
    body.textContent = ''
    body.appendChild(notice)
    const multi = sections.length > 1
    let first = true
    for (const sec of sections) {
      const grid = el('div', 'form-grid')
      for (const f of sec.fields) grid.appendChild(renderField(f))
      if (multi) {
        const det = el('details', 'section')
        if (first) det.open = true
        const sum = el('summary', null, sec.title)
        if (sec.hint) sum.appendChild(el('span', 'muted', sec.hint))
        det.append(sum, grid)
        // 互斥折叠：打开一个就收起其他
        det.addEventListener('toggle', () => {
          if (!det.open) return
          for (const other of body.querySelectorAll('details.section')) {
            if (other !== det) other.open = false
          }
        })
        body.appendChild(det)
      } else {
        if (sec.title) body.appendChild(el('h3', null, sec.title))
        body.appendChild(grid)
      }
      first = false
    }
  }

  render()

  return {
    setNotice(text, kind) {
      notice.textContent = text || ''
      notice.className = 'notice' + (kind ? ' ' + kind : '')
    },
    collect() {
      const out = {}
      for (const node of body.querySelectorAll('[data-field]')) {
        const key = node.dataset.field
        if (node.tagName === 'OUTPUT') {
          out[key] = values[key]
          continue
        }
        const raw = node.value
        if (raw === '') {
          out[key] = null
          continue
        }
        out[key] = node.type === 'number' ? Number(raw) : raw
      }
      return out
    }
  }
}
