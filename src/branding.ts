export const DEFAULT_PRODUCT_NAME = 'NETIS FMS'
export const BRANDING_TIMEOUT_MS = 3000

export function brandingTitle(productName: string): string {
  return `${productName} 3D 관제`
}

/** 공개 브랜드 요청은 인증 클라이언트/세션 갱신과 독립적으로 실행한다. */
export async function loadProductName(signal: AbortSignal, timeoutMs = BRANDING_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timeout = setTimeout(abort, timeoutMs)
  try {
    if (controller.signal.aborted) return DEFAULT_PRODUCT_NAME
    const response = await fetch('/api/auth/branding', {
      credentials: 'omit',
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) return DEFAULT_PRODUCT_NAME
    const data: unknown = await response.json()
    if (controller.signal.aborted || !data || typeof data !== 'object' || !('productName' in data)) {
      return DEFAULT_PRODUCT_NAME
    }
    const name = data.productName
    return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_PRODUCT_NAME
  } catch {
    return DEFAULT_PRODUCT_NAME
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
