// 游标分页状态机。契约是 cursor 分页（?q=&cursor=&limit= → {items, next_cursor, total}），
// 页码只是展示层概念：pageStarts[i] 记录第 i 页的入参 cursor，翻页不重复请求已访问页。

export function createPager(snapshot) {
  let pageStarts = [null] // 第 i 页要用的 cursor；第 0 页总是 null
  let page = 0
  let lastNext = null // 最近一次 fetch 返回的 next_cursor
  if (snapshot) {
    pageStarts = snapshot.pageStarts.slice()
    page = snapshot.page
    lastNext = snapshot.lastNext
  }

  return {
    get page() { return page },
    cursor() { return pageStarts[page] ?? null },
    canPrev() { return page > 0 },
    canNext() { return pageStarts[page + 1] !== undefined || lastNext != null },
    applyResult(nextCursor) {
      lastNext = nextCursor ?? null
      if (lastNext != null && pageStarts[page + 1] === undefined) pageStarts[page + 1] = lastNext
    },
    next() {
      if (!this.canNext()) return false
      page += 1
      lastNext = null
      return true
    },
    prev() {
      if (page === 0) return false
      page -= 1
      lastNext = null
      return true
    },
    reset() {
      pageStarts = [null]
      page = 0
      lastNext = null
    },
    snapshot() {
      return { pageStarts: pageStarts.slice(), page, lastNext }
    }
  }
}
