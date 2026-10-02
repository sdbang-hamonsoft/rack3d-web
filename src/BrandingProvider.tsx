import { useEffect, useState, type ReactNode } from 'react'
import { brandingTitle, DEFAULT_PRODUCT_NAME, loadProductName } from './branding'
import { ProductNameContext } from './hooks/useBranding'

/**
 * 공개 브랜드(`/api/auth/branding`)를 **한 번** 받아 앱 전체에 내려준다.
 *
 * 예전에는 `App` 이 제목 문자열만 받아 몇몇 화면에 prop 으로 넘겼다. 출처 표기를 제품명으로 바꾸면서
 * 로비·자산 패널·대시보드·세션 안내·씬 상단바가 모두 이 값을 필요로 하게 되어, prop 대신 컨텍스트로 둔다.
 * 요청은 여기서 한 번만 나간다(각 화면이 따로 부르지 않는다).
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const [productName, setProductName] = useState(DEFAULT_PRODUCT_NAME)
  useEffect(() => {
    const controller = new AbortController()
    void loadProductName(controller.signal).then((name) => {
      if (!controller.signal.aborted) setProductName(name)
    })
    return () => controller.abort()
  }, [])

  const title = brandingTitle(productName)
  useEffect(() => {
    document.title = title
    document.querySelector('meta[name="description"]')?.setAttribute('content', title)
  }, [title])

  return <ProductNameContext.Provider value={productName}>{children}</ProductNameContext.Provider>
}
