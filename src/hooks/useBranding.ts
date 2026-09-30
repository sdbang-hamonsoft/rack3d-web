import { useEffect, useState } from 'react'
import { brandingTitle, DEFAULT_PRODUCT_NAME, loadProductName } from '../branding'

export function useBranding() {
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
  return title
}
