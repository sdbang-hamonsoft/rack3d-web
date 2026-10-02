import { createContext, useContext } from 'react'
import { brandingTitle, DEFAULT_PRODUCT_NAME } from '../branding'

/**
 * FMS 제품명(`/api/auth/branding` 의 `productName`, 실패·미설정이면 `NETIS FMS`).
 *
 * 화면 문구에서 데이터 출처를 말할 때는 **내부 식별자(`netis-fms`·`NETIS-FMS`)가 아니라 이 값**을 쓴다.
 * 고객사가 제품명을 바꾸면 3D 화면도 같이 바뀌어야 하고, 매뉴얼에 캡처되는 화면에 저장소 이름이
 * 보이면 안 된다(2026-10-02, E27 Q4). 값은 `BrandingProvider` 가 받아 내려준다.
 *
 * ⚠️ 문장에 넣을 때 **받침에 따라 바뀌는 조사(이/가·은/는·과/와·을/를)를 바로 붙이지 않는다.**
 * 제품명은 고객사가 정하므로 받침 유무를 알 수 없다. `에서`·`에`·`의` 처럼 받침과 무관한 조사만 쓰거나
 * 문장을 그렇게 다시 쓴다.
 */
export const ProductNameContext = createContext(DEFAULT_PRODUCT_NAME)

export function useProductName(): string {
  return useContext(ProductNameContext)
}

/** `<제품명> 3D 관제` — 로비·스플래시 제목과 문서 제목. */
export function useBranding(): string {
  return brandingTitle(useProductName())
}
