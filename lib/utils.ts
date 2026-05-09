/**
 * 日期格式化工具函数
 */

export function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '--/--'
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('zh-CN', { 
      year: 'numeric', month: '2-digit', day: '2-digit', 
      hour: '2-digit', minute: '2-digit' 
    })
  } catch (e) { return '--/--' }
}

export function formatDateEn(dateStr: string | null | undefined) {
  if (!dateStr) return '--/--'
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { 
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  } catch (e) { return '--/--' }
}

export function formatDateShort(dateStr: string | null | undefined) {
  if (!dateStr) return '--/--'
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('zh-CN', { 
      year: 'numeric', month: '2-digit', day: '2-digit'
    })
  } catch (e) { return '--/--' }
}
