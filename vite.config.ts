import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * dev 프록시 기본 대상 — FMS UAT.
 * 호스트 주소는 시크릿이 아니다(자격증명·토큰은 이 파일에 절대 넣지 않는다).
 * 내부 주소(10.1.20.21:30310)는 개발 맥에서 도달하지 않아 공개 도메인을 기본값으로 둔다.
 */
const DEFAULT_FMS_ORIGIN = 'https://fms.burunet.co.kr'

/**
 * `/api` → netis-fms 프록시.
 *
 * dev 서버를 FMS와 같은 오리진처럼 보이게 만들어(H1) CORS·쿠키 문제 없이 실연동 개발을 한다.
 * 운영은 FMS 프론트 nginx가 `location /rack3d/`로 프록시하므로 애초에 같은 오리진이다(D4).
 */
function apiProxy(target: string, relaxCookie: boolean): ProxyOptions {
  return {
    target,
    changeOrigin: true, // Cloudflare/TLS SNI가 Host 헤더를 보므로 필수
    secure: true, // 인증서 검증을 끄지 않는다
    ...(relaxCookie
      ? {
          // ⚠️ **개발 전용 경로다. 프로덕션 빌드에는 존재하지 않는다**(vite `server` 설정).
          // FMS 리프레시 쿠키(NETIS_RT)는 `Secure` 속성이 붙는다. 브라우저는 보통
          // http://localhost 를 secure context로 취급해 그대로 저장하지만, 그렇지 않은
          // 브라우저/환경에서는 쿠키가 저장되지 않아 `POST /api/auth/refresh`가 항상 401이 된다.
          // 그 증상이 나면 `.env`에 VITE_DEV_RELAX_COOKIE=1 을 넣어 이 경로를 켠다.
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              const setCookie = proxyRes.headers['set-cookie']
              if (!setCookie) return
              proxyRes.headers['set-cookie'] = setCookie.map((cookie) =>
                cookie
                  .split(';')
                  .filter((attribute) => attribute.trim().toLowerCase() !== 'secure')
                  .join(';'),
              )
            })
          },
        }
      : {}),
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const fmsOrigin = env.VITE_FMS_ORIGIN?.trim() || DEFAULT_FMS_ORIGIN
  const relaxCookie = env.VITE_DEV_RELAX_COOKIE === '1' || env.VITE_DEV_RELAX_COOKIE === 'true'

  return {
    // rack3d는 FMS 프론트 nginx 하위 경로(`https://<fms>/rack3d/`)로 서빙된다(D4).
    // 정적 자산·public 파일 URL이 전부 이 base를 타므로, 코드에서 절대 경로를 쓰지 말고
    // `assetUrl()`(src/App.tsx)처럼 `import.meta.env.BASE_URL`을 거쳐 만든다.
    base: '/rack3d/',
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': apiProxy(fmsOrigin, relaxCookie) },
    },
  }
})
