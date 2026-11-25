export function createBrand(tag = 'div', caption = '万象') {
  const brand = document.createElement(tag)
  brand.className = 'brand'

  const mark = document.createElement('img')
  mark.className = 'brand-mark'
  mark.src = './logo.png'
  mark.alt = ''
  mark.width = 32
  mark.height = 32

  const copy = document.createElement('span')
  copy.className = 'brand-copy'
  const name = document.createElement('span')
  name.className = 'brand-wordmark'
  name.textContent = 'OneX'
  const label = document.createElement('small')
  label.textContent = caption
  copy.append(name, label)
  brand.append(mark, copy)
  return brand
}
