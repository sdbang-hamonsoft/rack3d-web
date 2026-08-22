import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, Html, Lightformer, OrbitControls, useCursor, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { Group } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import {
  RACK_BASE_HEIGHT_M,
  RACK_UNIT_HEIGHT_M,
  SERVER_MODEL_UNITS,
  buildZoneScene,
  rackElementId,
  reuseUnchangedRacks,
} from './rackLayouts'
import type { RackCacheEntry, SceneGrid, SceneObject, ScenePlacement } from './rackLayouts'
import type { RackData, ServerData, ServerModel } from './rackLayouts'
import { collectZones, fetchSidebar, fetchZoneLayout, fetchZoneRacks, fetchZoneUMaps, type ZoneSummary } from './api/fms'
import type { MeResponse, RackSummary, RackSeverity, RackUMap, ZoneLayout } from './api/types'
import { bootstrapSession, goToFmsLogin, goToFmsPasswordChange } from './api/session'
import { MANUAL_RETRY_COOLDOWN_MS, usePolledResource } from './hooks/usePolledResource'
import {
  NO_VALUE,
  aggregateZoneRacks,
  formatHeatmapValue,
  getFreeUnitBlocks,
  getHeatmapDataset,
  heatmapModeMeta,
  displayRackAssetCount,
  heatmapModes,
  largestFreeBlock,
  rackAvailableUnits,
  rackOccupancyPercent,
  severityToneColors,
  severityTones,
  unmountedAssetCount,
} from './rackFigures'
import type { HeatmapDataset, HeatmapMode, RackHeatmapVisual, SeverityTone, ZoneAggregate } from './rackFigures'
import './App.css'

/**
 * base(`/rack3d/`) 아래의 정적 자산 URL.
 * rack3d는 FMS 하위 경로로 서빙되므로 `/models/...` 같은 루트 절대 경로를 쓰면 404가 난다.
 */
const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`

/**
 * `useGLTF`의 디코더 옵션 — draco·meshopt 디코더를 **둘 다 끈다**.
 *
 * drei 기본값은 둘 다 `true`다. 그러면:
 * - meshopt: drei가 `MeshoptDecoder()`를 호출해 meshoptimizer WASM을 즉시 인스턴스화한다.
 *   운영 CSP(`script-src 'self'`)가 `wasm-eval`을 막아 **3D 씬 진입마다 CompileError**가 난다.
 *   dev 서버에는 CSP가 없어 보이지 않고 컨테이너·FMS 배포에서만 터진다.
 * - draco: 디코더를 `https://www.gstatic.com/draco/...`에서 받으려 한다 →
 *   폐쇄망 도달 불가 + CSP `script-src 'self'` 차단(C10 외부 CDN 의존 0 방침 위반).
 *
 * 현재 GLB 10개 모두 무압축이라 디코더가 필요 없다.
 * ⚠️ **meshopt/draco 압축 GLB를 도입하려면** 이 값을 되돌리지 말고 로컬 디코더를 번들에 넣어
 *    경로를 지정할 것(`useGLTF.setDecoderPath`). CSP에 `'wasm-unsafe-eval'`을 추가하는 방식은
 *    FMS 보안 헤더 SSOT와 영구 동기화 부담이 생겨 택하지 않았다.
 */
const GLTF_USE_DRACO = false
const GLTF_USE_MESHOPT = false

/** 랙 목록 폴링 주기 — FMS 부하 규약상 하한 30초(C11, E19 C6). */
const RACK_POLL_INTERVAL_MS = 30_000

/** 전산실(위치 트리) 목록은 거의 바뀌지 않는다 — 재시도 겸용으로 길게 잡는다. */
const ZONE_POLL_INTERVAL_MS = 300_000

/**
 * 랙 U 배치(u맵) **실패 재시도** 간격. 성공하면 다시 받지 않으므로 폴링 주기가 아니다.
 * 진입 직후의 일시적 단절 하나로 씬이 영구히 빈 채 남지 않게 하는 값이다.
 */
const UMAP_RETRY_INTERVAL_MS = 30_000

/**
 * ZONE 3D 배치(E18) **실패 재시도** 간격. u맵과 같은 규약이다 — 배치는 구조 데이터라
 * ZONE 진입 시 1회만 받고(`repeat: false`) 자동 재수집 경로를 두지 않는다.
 * 갱신 수단은 상단바 "지금 새로고침"이며 랙 목록·u맵과 **함께** 다시 받는다.
 */
const LAYOUT_RETRY_INTERVAL_MS = 30_000

/**
 * 1U 높이·랙 바닥 오프셋(m)은 `rackLayouts`가 SSOT다 — 배치 오브젝트의 랙 박스 높이도
 * 같은 상수로 계산하므로 두 곳에 두면 조용히 어긋난다.
 */
const UNIT_HEIGHT = RACK_UNIT_HEIGHT_M
const RACK_INNER_BOTTOM = RACK_BASE_HEIGHT_M
const MODEL_VERSION = '11'
const SPLASH_DURATION = 3600
const RACK_FOCUS_HEIGHT = 1.06
const RACK_FOCUS_DISTANCE = 1.15

/**
 * 그리드 규격이 ZONE마다 다르므로(§11-30) **전체 보기 카메라도 ZONE마다 계산한다.**
 * 예전의 고정 좌표(5.4, 2.2, 9.5)는 18×14×0.6m 전산실 하나에만 맞는 값이었다 —
 * 실측 ZONE 10은 12×8이라 그대로 두면 바닥이 화면 한쪽에 치우친다.
 */
function overviewCamera(grid: SceneGrid | null): { position: THREE.Vector3; target: THREE.Vector3 } {
  // 그리드를 아직 모를 때(로딩)의 임시값 — 이 상태에서는 씬에 아무것도 그리지 않는다.
  const cols = grid?.cols ?? 18
  const rows = grid?.rows ?? 14
  const tileSize = grid?.tileSize ?? 0.6
  const centerX = (cols - 1) / 2 * tileSize
  const centerZ = (rows - 1) / 2 * tileSize
  // 바닥 전체가 화면에 들어오도록 거리·높이를 **그리드 크기에 비례**시킨다.
  // (하한 7.5m는 아주 작은 ZONE에서 카메라가 랙에 파묻히지 않게 하는 값이다.)
  const distance = Math.max(cols * tileSize, rows * tileSize, 7.5)
  return {
    position: new THREE.Vector3(centerX, 0.9 + distance * 0.42, centerZ + distance * 0.66),
    target: new THREE.Vector3(centerX, 0.9, centerZ),
  }
}

/**
 * 태양광(directionalLight) 방향 — 옛 고정 좌표 (6, 10, 7)에서 원점을 보던 그 방향 그대로다.
 * 방향만 유지하고 **위치는 ZONE 중심 기준으로** 옮긴다(아래 `sun`).
 */
const SUN_DIRECTION = new THREE.Vector3(6, 10, 7).normalize()

/**
 * 조명·안개·그림자도 **ZONE 그리드에서 파생한다.** 예전 값은 18×14×0.6m 전산실 하나(중심 5.1, 3.9)에
 * 맞춘 고정 좌표여서, 12×8인 실측 ZONE 10에서는 조명이 죄다 뒤쪽·바깥으로 밀려 앞·왼쪽이 어두웠다.
 * 계수는 옛 18×14×0.6m 그리드의 값(안개 12·28m, 필 조명 거리 10m, 태양광 거리 13.6m 등)을
 * 그대로 재현하도록 잡았다.
 */
function sceneMetrics(grid: SceneGrid | null) {
  // 그리드를 아직 모를 때(로딩)의 임시값 — 이 상태에서는 씬에 아무것도 그리지 않는다.
  const cols = grid?.cols ?? 18
  const rows = grid?.rows ?? 14
  const tileSize = grid?.tileSize ?? 0.6
  // 타일 중심은 0..(n-1)*tile이고 양끝에 반 타일씩 더 있으니 바닥 크기는 cols×tile, rows×tile이다.
  const floorWidth = cols * tileSize
  const floorDepth = rows * tileSize
  const centerX = (cols - 1) / 2 * tileSize
  const centerZ = (rows - 1) / 2 * tileSize
  // 전체 보기 카메라 거리와 같은 기준 크기(작은 ZONE 하한 7.5m 포함).
  // 조명 도달거리(distance)·안개 근원거리를 여기에 비례시켜, 그리드가 커져 카메라가 멀어져도
  // 바닥 뒤쪽이 안개에 먹히지 않게 한다.
  const span = Math.max(floorWidth, floorDepth, 7.5)
  // 태양광은 방향만 쓰는 조명이라 거리는 밝기와 무관하다. 그림자 카메라가 바닥을 다 담도록
  // 그리드에 비례해 띄운다(하한은 옛 좌표의 거리 13.6m).
  const sunDistance = Math.max(span * 1.3, 14)
  return {
    centerX,
    centerZ,
    floorWidth,
    floorDepth,
    span,
    /** 태양광 위치 — 방향은 예전 그대로고 겨냥점만 ZONE 중심이다. */
    sun: {
      x: centerX + SUN_DIRECTION.x * sunDistance,
      y: SUN_DIRECTION.y * sunDistance,
      z: centerZ + SUN_DIRECTION.z * sunDistance,
    },
    /**
     * 태양광 그림자 정사영 반경(m). three.js 기본값 ±5는 **원점 기준**이라 18×14(바닥 x −0.3~10.5)에서는
     * 먼 쪽 절반이 프러스텀 밖으로 밀려 그림자가 아예 안 맺힌다 — 랙이 수십 대인 전산실에서 바로 드러난다.
     * 바닥 대각선의 절반에 랙 그림자가 뻗는 길이(2.5m, 랙 2.1m · 태양 고도 약 48°)를 더해 전부 담는다.
     */
    shadowExtent: Math.hypot(floorWidth, floorDepth) / 2 + 2.5,
    /** 접지 그림자(ContactShadows) 크기 — 바닥보다 30% 넓게. */
    contactShadowScale: Math.max(floorWidth, floorDepth) * 1.3,
  }
}

type ThemeMode = 'dark' | 'light'

/**
 * 전산실 목록은 netis-fms `GET /api/locations/sidebar`가 SSOT다(D1).
 * 예전의 하드코딩 3건(서울/판교/부산)과 그 평균온도는 실측이 아니어서 제거했다.
 */

/** FMS 판정 등급 → 한글 라벨. 등급 자체는 FMS 원값을 그대로 쓴다(E19 C1). */
const severityLabels: Record<RackSeverity, string> = {
  NORMAL: '정상',
  CAUTION: '주의',
  MAJOR: '경고',
  CRITICAL: '심각',
}

/**
 * 등급 라벨. **원값 폴백이 있는 이유**: `RackSeverity`는 우리 타입이지 서버 검증이 아니다(C5).
 * FMS가 새 등급을 추가하면 인덱싱이 `undefined`가 되어 화면에서 등급 칸이 통째로 사라진다 —
 * 그때는 모르는 원값이라도 보여주는 편이 맞다. 호출부마다 폴백을 붙였다 말았다 하지 않게 함수로 둔다.
 */
function severityLabel(severity: RackSeverity): string {
  return severityLabels[severity] ?? severity
}

/**
 * 우리 GLB 3종의 표시명 — **장비의 실제 모델명이 아니다.**
 * FMS가 준 `modelName`/`manufacturer`가 화면에 나가는 값이고, 이 라벨은
 * "3D 형상은 무엇으로 근사했는가"를 밝힐 때만 쓴다(형상 근사 고지).
 */
const serverModelLabels: Record<ServerModel, string> = {
  'dell-poweredge-r760': 'Dell PowerEdge R760',
  'hpe-proliant-dl360-gen11': 'HPE ProLiant DL360 Gen11',
  'cisco-ucs-c240-m7': 'Cisco UCS C240 M7',
}

/**
 * 장비 U 범위 표기(`U03–U06`). u맵 자산의 실제 높이를 그대로 쓴다 — 1·2U 고정이 아니다.
 */
function formatUnitRange(server: ServerData) {
  const first = `U${String(server.startU).padStart(2, '0')}`
  const lastU = server.startU + server.units - 1
  return server.units === 1 ? first : `${first}–U${String(lastU).padStart(2, '0')}`
}

/** 값이 없는 텍스트 필드는 지어내지 않고 `—`로 둔다(C6·C7). */
function orDash(value: string | null | undefined) {
  const text = value?.trim()
  return text ? text : NO_VALUE
}

/**
 * 랙 U 배치도.
 *
 * **`rackUnits`(FMS 원값)가 없으면 이 컴포넌트를 렌더하지 않는다** — 호출부에서 막고,
 * 여기서도 방어한다. 예전에는 지오메트리용 폴백 42U를 그대로 그려 크기 미설정 랙에
 * "1U–42U RACK MAP"이 떴다(백로그 ⚠️ 항목). 도면은 랙 크기를 안다고 단언하는 표현이라
 * 모를 때는 아예 그리지 않는 것이 맞다(C6).
 */
function RackUnitMap({
  rack,
  rackUnits,
  onSelectServer,
}: {
  rack: RackData
  rackUnits: number
  onSelectServer: (server: ServerData) => void
}) {
  const units = useMemo(() => Array.from({ length: rackUnits }, (_, index) => rackUnits - index), [rackUnits])
  const freeBlocks = useMemo(() => getFreeUnitBlocks(rack.servers, rackUnits) ?? [], [rack.servers, rackUnits])
  const rowForBlock = (startU: number, height: number) => rackUnits - startU - height + 2

  return (
    <section className="rack-unit-map" aria-labelledby={`rack-unit-map-${rack.id}`}>
      <div className="rack-unit-map-heading">
        <div><span>PHYSICAL LAYOUT</span><strong id={`rack-unit-map-${rack.id}`}>1U–{rackUnits}U RACK MAP</strong></div>
        <small>FRONT VIEW</small>
      </div>
      <div
        className="rack-unit-map-grid"
        style={{ gridTemplateRows: `repeat(${rackUnits}, 15px)` }}
      >
        {units.flatMap((unit, index) => [
          <span className="rack-unit-number" style={{ gridColumn: 1, gridRow: index + 1 }} key={`label-${unit}`}>U{String(unit).padStart(2, '0')}</span>,
          <span className="rack-unit-cell" style={{ gridColumn: 2, gridRow: index + 1 }} key={`cell-${unit}`} aria-hidden="true" />,
        ])}
        {freeBlocks.map((block) => (
          <span
            className="rack-unit-empty"
            style={{ gridColumn: 2, gridRow: `${rowForBlock(block.startU, block.units)} / span ${block.units}` }}
            key={`empty-${block.startU}`}
            aria-hidden="true"
          >
            {block.units >= 3 && <em>{block.units}U EMPTY</em>}
          </span>
        ))}
        {rack.servers.map((server) => (
          <button
            className="rack-unit-device"
            style={{ gridColumn: 2, gridRow: `${rowForBlock(server.startU, server.units)} / span ${server.units}` }}
            data-units={server.units}
            type="button"
            key={server.id}
            onClick={() => onSelectServer(server)}
            aria-label={`${server.name}, ${formatUnitRange(server)}, ${orDash(server.category)}, 상세 보기`}
            title={`${server.name} · ${formatUnitRange(server)} · ${server.assetCode}`}
          >
            <span><strong>{server.name}</strong><small>{orDash(server.modelName)}</small></span>
            <em>{server.units}U</em>
          </button>
        ))}
      </div>
      <div className="rack-unit-map-legend"><span><i /> INSTALLED</span><span><i /> AVAILABLE</span></div>
    </section>
  )
}

function cloneModel(scene: Group) {
  const clone = scene.clone(true)
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.castShadow = true
    child.receiveShadow = true
    child.material = child.material.clone()
  })
  return clone
}

/**
 * 랙 안의 장비 1대(netis-fms u맵 자산).
 *
 * **형상은 근사, 위치·높이는 실측이다.** GLB는 3종(dell 2U·hpe 1U·cisco 2U)뿐이므로
 * 제조사/U 높이로 하나를 고른 뒤(`pickServerModel`) **Y축을 실제 U 높이에 맞춰 늘린다** —
 * "몇 U를 먹는가"는 FMS 실데이터라 근사로 넘길 수 없다.
 *
 * 장비 상태 경보(깜빡임·비컨)는 없앴다. 소스가 없는데 색을 칠하면 가짜 정상/가짜 장애가 된다.
 */
function Server({
  server,
  selected,
  interactive,
  onSelect,
}: {
  server: ServerData
  selected: boolean
  interactive: boolean
  onSelect: (server: ServerData) => void
}) {
  const modelUrl = assetUrl(`models/${server.model}.glb?v=${MODEL_VERSION}`)
  const { scene } = useGLTF(modelUrl, GLTF_USE_DRACO, GLTF_USE_MESHOPT)
  const model = useMemo(() => cloneModel(scene), [scene])
  const [hovered, setHovered] = useState(false)
  useCursor(hovered)

  const y = RACK_INNER_BOTTOM + (server.startU - 1 + server.units / 2) * UNIT_HEIGHT
  /** 고른 GLB의 고유 U 대비 실제 U — 1이 아니면 늘리거나 눌러 실제 점유 높이를 맞춘다. */
  const heightScale = server.units / SERVER_MODEL_UNITS[server.model]

  return (
    <group
      position={[0, y, 0]}
      onPointerEnter={(event) => { event.stopPropagation(); setHovered(true) }}
      onPointerLeave={() => setHovered(false)}
      onClick={(event) => { event.stopPropagation(); onSelect(server) }}
    >
      <mesh position={[0, 0, 0.59]}>
        <boxGeometry args={[0.56, server.units * UNIT_HEIGHT + 0.024, 0.06]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <primitive object={model} scale={[1, heightScale, 1]} />
      {/*
        ⚠️ `<Html>`은 **포커스된 랙에서만** 만든다.
        drei의 Html은 장비 1대당 DOM 포털 하나 + 매 프레임 위치 계산·스타일 쓰기다.
        1단계까지는 `servers`가 비어 0개였지만 u맵이 붙으면서 랙 36대 × 10대 = 포털 360개가
        상시 존재하게 됐다. 게다가 이 버튼은 폭 180px 고정이라 멀리서는 뒤쪽 랙 클릭을 가린다.
        비포커스 랙의 클릭은 위쪽 투명 히트박스(mesh)가 이미 받는다.
      */}
      {interactive && (
        <Html position={[0, 0, 0.63]} center distanceFactor={0.75} zIndexRange={[2, 1]}>
          <button
            className="server-click-target"
            type="button"
            style={{ width: 180, height: Math.max(32, server.units * 28) }}
            onClick={(event) => { event.stopPropagation(); onSelect(server) }}
            aria-label={`${server.name} 3D 장비 상세 보기`}
            title={`${server.name} 상세 보기`}
          />
        </Html>
      )}
      {(selected || hovered) && (
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.53, server.units * UNIT_HEIGHT + 0.025, 0.76]} />
          <meshBasicMaterial color="#47d4ff" wireframe transparent opacity={selected ? 0.9 : 0.45} toneMapped={false} />
        </mesh>
      )}
    </group>
  )
}

/** 랙 경보 표시. 색은 FMS 판정 등급 톤(`severityToneColors`)을 따르므로 범례와 어긋나지 않는다. */
function RackAlert({
  label,
  color,
  showLabel = true,
  offsetX = 0,
  offsetY = 0,
}: {
  label: string
  color: string
  showLabel?: boolean
  offsetX?: number
  offsetY?: number
}) {
  const shellMaterial = useRef<THREE.MeshBasicMaterial>(null)
  const beaconMaterial = useRef<THREE.MeshStandardMaterial>(null)
  const beaconLight = useRef<THREE.PointLight>(null)

  useFrame(({ clock }) => {
    const pulse = (Math.sin(clock.elapsedTime * 4.5) + 1) / 2
    if (shellMaterial.current) shellMaterial.current.opacity = 0.08 + pulse * 0.2
    if (beaconMaterial.current) beaconMaterial.current.emissiveIntensity = 2 + pulse * 7
    if (beaconLight.current) beaconLight.current.intensity = 1.5 + pulse * 4
  })

  return (
    <group>
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[0.66, 2.08, 1.06]} />
        <meshBasicMaterial ref={shellMaterial} color={color} wireframe transparent opacity={0.18} toneMapped={false} />
      </mesh>
      <mesh position={[0, 2.08, -0.46]}>
        <sphereGeometry args={[0.045, 20, 12]} />
        <meshStandardMaterial ref={beaconMaterial} color={color} emissive={color} emissiveIntensity={6} />
      </mesh>
      <pointLight ref={beaconLight} position={[0, 2.08, -0.46]} color={color} intensity={4} distance={2.2} decay={2} />
      {showLabel && (
        <Html position={[0, 2.26, -0.46]} center distanceFactor={7}>
          <div className="rack-alert-badge" style={{ transform: `translate(${offsetX}px, ${offsetY}px)` }}><i /> RACK {label} ATTENTION</div>
        </Html>
      )}
    </group>
  )
}

/**
 * 배치 오브젝트 1건 — **종류별 색 박스 + 레이블**(E18 ④).
 *
 * 3D 모델은 확보하지 않는다("대강 구분만 되면 된다"). 바닥 점유는 FMS 모델상 **정확히 1타일**이고
 * (§11-31 ②: `zone_layout_object`에 width/depth가 없고 `UNIQUE(zone,x,z)`), 실제 항온항습기가
 * 600mm보다 커도 FMS는 물리 치수를 관리하지 않으므로 여기서 지어내지 않는다.
 *
 * 클릭 핸들러를 달지 않는 것은 의도다 — 이 오브젝트들에는 붙일 상세 데이터가 없고,
 * 핸들러가 있으면 r3f가 `onPointerMissed`(전체 보기 복귀)를 막는다.
 */
function LayoutObjectMesh({ object, tileSize }: { object: SceneObject; tileSize: number }) {
  const { placement, heightM } = object
  // 1타일보다 조금 작게 — 옆 칸과 붙어 한 덩어리로 보이지 않게 칸 경계를 남긴다.
  const footprint = Math.max(0.12, tileSize * 0.84)
  // 바닥 타일은 높이 0.08이 y=0 중심이라 윗면이 0.04다.
  const baseY = 0.04
  // `args`로 넘기면 렌더마다 새 지오메트리가 만들어진다 — 박스와 모서리 선이 하나를 같이 쓴다.
  const boxGeometry = useMemo(() => new THREE.BoxGeometry(footprint, heightM, footprint), [footprint, heightM])
  useEffect(() => () => boxGeometry.dispose(), [boxGeometry])

  return (
    <group
      position={[placement.tileX * tileSize, 0, placement.tileZ * tileSize]}
      rotation={[0, placement.rotation, 0]}
    >
      {/*
        ⚠️ 조명을 받는 재질(`meshStandardMaterial`)을 쓰지 않는다. 이 씬은 노출이 높고
        ACES 톤매핑이 걸려 있어 팔레트 색이 통째로 밝은 쪽으로 밀린다 —
        #D32F2F(화재)·#C2185B(배전반)·#F57C00(가스)이 서로 구분되지 않게 되는데,
        **2D 에디터와 색이 맞아야 사용자가 대응을 읽는다**는 것이 이 색을 쓰는 이유 전부다.
        `toneMapped={false}` + basic 재질이면 화면 색이 팔레트 값 그대로다.
        형태감은 아래 모서리 선이 준다(음영 대신 윤곽) — 물리 모델인 랙과 시각적으로도 갈린다.
      */}
      <mesh position={[0, baseY + heightM / 2, 0]} geometry={boxGeometry} castShadow>
        <meshBasicMaterial color={object.color} toneMapped={false} />
      </mesh>
      <lineSegments position={[0, baseY + heightM / 2, 0]} raycast={() => undefined}>
        <edgesGeometry args={[boxGeometry]} />
        <lineBasicMaterial color="#dceaf6" transparent opacity={0.5} toneMapped={false} />
      </lineSegments>
      {/*
        정면(FRONT) 표시 — FMS 2D 에디터의 파란 막대와 같은 뜻이다(§11-30 2).
        로컬 +Z가 정면이고, 그 면이 `dir`이 가리키는 방위를 향하도록 회전돼 있다.
      */}
      <mesh position={[0, baseY + heightM * 0.5, footprint / 2 + 0.006]}>
        <boxGeometry args={[footprint * 0.62, Math.min(0.06, heightM * 0.16), 0.012]} />
        <meshBasicMaterial color="#e8f6ff" toneMapped={false} />
      </mesh>
      {/*
        ⚠️ 이 레이블에는 `occlude`를 걸지 않는다 — **가려서 숨기는 것보다 안 보이는 쪽이 더 나쁘다.**

        3D 모델이 없는 이 오브젝트들은 "색 박스 + 이름표"가 정보 전부라, 레이블이 숨으면
        기능의 절반이 죽는다. drei의 `occlude`는 씬 전체를 레이캐스트해 시선이 막히면
        `display:none`을 걸어버리는데, 이 오브젝트들은 박스가 0.2~0.35m로 낮아서
        **옆 칸의 랙(히트박스 0.72×2.12×1.1)·방화문(2.1m)·항온항습기(2.0m)가 그대로 시선을 막는다.**
        레이블 높이에 하한(0.62m)을 둬 봤지만 부족했다 — 실측(ZONE 10, 진입 기본 카메라
        (3.30, 4.05, 7.05))에서 화재감지·누수감지·온습도·CCTV·가스감지·지진감지 6종이
        **사용자가 ZONE에 처음 들어갔을 때 보는 바로 그 화면에서** 통째로 사라졌다.

        벽·천장이 없고 부감이 기본인 씬이라 "뒤에 가려진 것이 비쳐 보이는" 손해는 작다.
        비용도 늘지 않는다 — DOM 수는 그대로고(`occlude`는 숨길 때도 포털·프레임 계산을
        그대로 하고 `display`만 껐다), 오히려 레이블 1개당 매 프레임 씬 전체 교차 검사가
        사라진다(랙 36대 ZONE 실측 0.2ms/레이블).

        높이 하한(0.62m)과 `zIndexRange={[1, 0]}`은 유지한다. 하한은 이제 가림 회피용이 아니라
        낮은 박스 위에서 이름표가 박스·모서리 선과 겹쳐 읽히지 않게 띄우는 값이고,
        z 범위는 랙 레이블·경보 뱃지가 위에 오도록 한다(drei는 `occlude`가 있을 때도
        이 값에서 [1, 0]을 썼으므로 겹침 순서는 바뀌지 않는다).
      */}
      <Html position={[0, baseY + Math.max(heightM + 0.14, 0.62), 0]} center distanceFactor={8} zIndexRange={[1, 0]}>
        <div className="layout-object-label" style={{ borderColor: object.color }}>
          <i style={{ background: object.color }} />
          {object.label}
        </div>
      </Html>
    </group>
  )
}

function Rack({
  rack,
  /** FMS ZONE 배치도 좌표(E18). 배치되지 않은 랙은 호출부에서 걸러 여기 오지 않는다. */
  placement,
  grid,
  /** FMS 판정(E19 B1). 랙 경보 표시의 SSOT — 장비 상태(u맵)는 아직 오지 않는다. */
  severity,
  selected,
  selectedServerId,
  heatmap,
  onSelect,
  onSelectServer,
}: {
  rack: RackData
  placement: ScenePlacement
  grid: SceneGrid
  severity: RackSeverity
  selected: boolean
  selectedServerId: string | null
  heatmap?: RackHeatmapVisual
  onSelect: (rack: RackData) => void
  onSelectServer: (rack: RackData, server: ServerData) => void
}) {
  const { scene } = useGLTF(assetUrl('models/rack-42u.glb'), GLTF_USE_DRACO, GLTF_USE_MESHOPT)
  const model = useMemo(() => cloneModel(scene), [scene])
  const [hovered, setHovered] = useState(false)
  // 랙 경보의 SSOT는 FMS 판정(`severity`)이다. 장비 단위 상태는 소스가 없다(A6 = b).
  const hasIncident = severity !== 'NORMAL'
  const alertColor = severityToneColors[severityTones[severity]]

  return (
    <group
      /*
        ⚠️ 랙 GLB는 **타일 크기에 맞춰 늘리지 않는다.** 랙의 물리 치수(약 600×1100mm)는
        전산실 타일이 600mm든 1000mm든 그대로다 — 타일에 맞춰 스케일하면 실물 비례가 깨진다.
        타일 1칸 규약(§11-31 ②)은 "몇 칸을 점유하는가"에 대한 것이지 형상 크기가 아니다.
      */
      position={[placement.tileX * grid.tileSize, 0.06, placement.tileZ * grid.tileSize]}
      rotation={[0, placement.rotation, 0]}
      onPointerEnter={(event) => { event.stopPropagation(); setHovered(true) }}
      onPointerLeave={() => setHovered(false)}
      onClick={(event) => { event.stopPropagation(); onSelect(rack) }}
    >
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[0.72, 2.12, 1.1]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {heatmap && (
        <>
          <mesh position={[0, 1, 0]} raycast={() => undefined} renderOrder={-1}>
            <boxGeometry args={[0.76, 2.16, 1.14]} />
            <meshBasicMaterial
              color={heatmap.color}
              wireframe
              transparent
              opacity={heatmap.normalized === null ? 0.14 : 0.28 + heatmap.normalized * 0.28}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          {heatmap.normalized !== null && (
          <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => undefined} renderOrder={-1}>
            <planeGeometry args={[3.6, 3.6]} />
            <shaderMaterial
              transparent
              depthWrite={false}
              toneMapped={false}
              side={THREE.DoubleSide}
              uniforms={{
                uColor: { value: new THREE.Color() },
                uIntensity: { value: 0 }
              }}
              uniforms-uColor-value={new THREE.Color(heatmap.color)}
              uniforms-uIntensity-value={heatmap.normalized ?? 0}
              vertexShader={`
                varying vec2 vUv;
                void main() {
                  vUv = uv;
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
              `}
              fragmentShader={`
                uniform vec3 uColor;
                uniform float uIntensity;
                varying vec2 vUv;
                
                void main() {
                  // Distance from center (0.5, 0.5)
                  float dist = distance(vUv, vec2(0.5));
                  
                  // Softer, wider gaussian falloff (reduced multiplier from 14.0 to 7.0)
                  float alpha = exp(-dist * dist * 7.0) * (0.3 + uIntensity * 0.7);
                  
                  // White hot core based on intensity (also slightly wider)
                  float core = exp(-dist * dist * 25.0) * uIntensity * 0.7;
                  vec3 finalColor = mix(uColor, vec3(1.0), core);
                  
                  // Smoothly fade out edges completely (wider visible area before fade)
                  float edgeFade = smoothstep(0.5, 0.3, dist);
                  
                  gl_FragColor = vec4(finalColor, alpha * edgeFade);
                }
              `}
            />
          </mesh>
          )}
          {/* 값이 없는 랙은 빛을 내지 않는다 — 발광 자체가 "측정됐다"는 신호이기 때문. */}
          {heatmap.normalized !== null && (
            <pointLight
              position={[0, 1.05, 0]}
              color={heatmap.color}
              intensity={0.4 + heatmap.normalized}
              distance={2.4}
              decay={2}
            />
          )}
          <Html position={[0, 2.48, 0.18]} center distanceFactor={7} zIndexRange={[1, 0]}>
            <div
              className="rack-heatmap-badge"
              style={{
                borderColor: heatmap.color,
                color: heatmap.color,
                boxShadow: `0 0 18px ${heatmap.color}55`,
                transform: `translate(${placement.tileX < grid.cols / 2 ? -22 : 22}px, ${placement.tileZ < grid.rows / 2 ? 7 : -7}px)`,
              }}
            >
              <i style={{ background: heatmap.color, boxShadow: `0 0 9px ${heatmap.color}` }} />
              <span>RACK {rack.label}<small>{heatmapModeMeta[heatmap.mode].shortLabel}</small></span>
              <strong>{heatmap.displayValue}</strong>
            </div>
          </Html>
        </>
      )}
      <primitive object={model} />
      {rack.servers.map((server) => (
        <Server
          key={server.id}
          server={server}
          selected={selectedServerId === server.id}
          interactive={selected}
          onSelect={(selectedServer) => onSelectServer(rack, selectedServer)}
        />
      ))}
      {hasIncident && (
        <RackAlert
          label={rack.label}
          color={alertColor}
          showLabel={!heatmap}
          offsetX={placement.tileX < grid.cols / 2 ? -34 : 34}
          offsetY={placement.tileZ < grid.rows / 2 ? 10 : -10}
        />
      )}
      {!hasIncident && (
        <Html position={[0, 2.15, 0]} center distanceFactor={8} occlude>
          <div className={hovered || selected ? 'rack-label active' : 'rack-label'}>{rack.label}</div>
        </Html>
      )}
    </group>
  )
}

/** 바닥 — **규격은 전부 FMS ZONE 응답값**이다(cols/rows/tileMm). 상수로 굳히지 말 것(§11-30). */
function FloorTiles({ grid, theme }: { grid: SceneGrid; theme: ThemeMode }) {
  const { cols: columns, rows, tileSize } = grid
  const tiles = useMemo(() => Array.from({ length: columns * rows }, (_, index) => ({
    x: index % columns,
    z: Math.floor(index / columns),
  })), [columns, rows])
  const lightTheme = theme === 'light'

  return (
    <group>
      {tiles.map(({ x, z }) => (
        <mesh key={`${x}-${z}`} position={[x * tileSize, 0, z * tileSize]} receiveShadow>
          <boxGeometry args={[tileSize - 0.012, 0.08, tileSize - 0.012]} />
          <meshStandardMaterial
            color={(x + z) % 2
              ? (lightTheme ? '#aab7c2' : '#263140')
              : (lightTheme ? '#bac5ce' : '#2d3949')}
            roughness={0.72}
            metalness={0.12}
          />
        </mesh>
      ))}
      <gridHelper
        args={[
          Math.max(columns, rows) * tileSize,
          Math.max(columns, rows),
          lightTheme ? '#718598' : '#52637a',
          lightTheme ? '#95a5b2' : '#354256',
        ]}
        position={[(columns - 1) * tileSize / 2, 0.045, (rows - 1) * tileSize / 2]}
      />
    </group>
  )
}

function CameraController({
  grid,
  focusRack,
  focusServer,
}: {
  grid: SceneGrid | null
  focusRack: RackData | null
  focusServer: ServerData | null
}) {
  const { camera } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const pressed = useRef(new Set<string>())
  const direction = useRef(new THREE.Vector3())
  const side = useRef(new THREE.Vector3())
  const up = useRef(new THREE.Vector3(0, 1, 0))
  const movement = useRef(new THREE.Vector3())
  const transition = useRef(1)
  const fromPosition = useRef(new THREE.Vector3())
  const fromTarget = useRef(new THREE.Vector3())
  const toPosition = useRef(new THREE.Vector3())
  const toTarget = useRef(new THREE.Vector3())
  const rackForward = useRef(new THREE.Vector3())

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return
      pressed.current.add(event.code)
    }
    const upKey = (event: KeyboardEvent) => pressed.current.delete(event.code)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', upKey)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', upKey)
    }
  }, [])

  /**
   * ⚠️ **의존성은 객체가 아니라 스칼라다.**
   *
   * 이 effect는 `transition.current = 0`으로 카메라 전이를 처음부터 다시 시작한다. 그런데
   * 전이 중(`transition < 1`)에는 아래 `useFrame`이 드래그·휠·WASD 입력을 통째로 건너뛴다.
   * 그래서 `focusRack` **객체**를 의존성에 두면, 폴링·u맵 스윕이 만든 새 객체 하나에도
   * 전이가 리셋되어 0.85초짜리 전이가 영원히 끝나지 않고 3D 조작이 막힌다.
   *
   * 카메라 위치를 실제로 결정하는 값(랙 좌표·회전, 장비 U 위치)만 의존성으로 둔다 —
   * 같은 랙의 **다른** 장비가 u맵으로 추가돼도 카메라는 흔들리지 않는다.
   */
  const focusRackX = focusRack?.placement ? focusRack.placement.tileX : null
  const focusRackZ = focusRack?.placement ? focusRack.placement.tileZ : null
  const focusRackRotation = focusRack?.placement ? focusRack.placement.rotation : null
  const focusServerStartU = focusServer ? focusServer.startU : null
  const focusServerUnits = focusServer ? focusServer.units : null
  /**
   * 포커스한 랙이 **FMS 배치도에 없으면**(placement null) 갈 좌표가 없다. 전체 보기로
   * 되돌리지 않고 **카메라를 그대로 둔다** — 검색·경보 목록에서 미배치 랙을 골랐을 때
   * 화면이 이유 없이 튀지 않게. 상세 패널이 "배치되지 않았다"는 사실을 글로 밝힌다.
   */
  const focusUnplaced = focusRack !== null && focusRack.placement === null
  const gridCols = grid?.cols ?? null
  const gridRows = grid?.rows ?? null
  const gridTileSize = grid?.tileSize ?? null

  useEffect(() => {
    if (focusUnplaced) return
    const overview = overviewCamera(
      gridCols !== null && gridRows !== null && gridTileSize !== null
        ? { cols: gridCols, rows: gridRows, tileSize: gridTileSize }
        : null,
    )
    fromPosition.current.copy(camera.position)
    fromTarget.current.copy(controls.current?.target ?? overview.target)

    if (focusRackX !== null && focusRackZ !== null && focusRackRotation !== null && gridTileSize !== null) {
      const rackX = focusRackX * gridTileSize
      const rackZ = focusRackZ * gridTileSize
      const focusHeight = focusServerStartU !== null && focusServerUnits !== null
        ? Math.max(0.2, 0.06 + RACK_INNER_BOTTOM + (focusServerStartU - 1 + focusServerUnits / 2) * UNIT_HEIGHT)
        : RACK_FOCUS_HEIGHT
      rackForward.current.set(Math.sin(focusRackRotation), 0, Math.cos(focusRackRotation))
      toTarget.current.set(rackX, focusHeight, rackZ)
      toPosition.current.copy(toTarget.current).addScaledVector(rackForward.current, RACK_FOCUS_DISTANCE)
    } else {
      toPosition.current.copy(overview.position)
      toTarget.current.copy(overview.target)
    }

    transition.current = 0
  }, [
    camera,
    focusRackX,
    focusRackZ,
    focusRackRotation,
    focusServerStartU,
    focusServerUnits,
    focusUnplaced,
    gridCols,
    gridRows,
    gridTileSize,
  ])

  useFrame(({ camera }, delta) => {
    if (transition.current < 1) {
      transition.current = Math.min(1, transition.current + delta / 0.85)
      const eased = 1 - Math.pow(1 - transition.current, 3)
      camera.position.lerpVectors(fromPosition.current, toPosition.current, eased)
      camera.up.set(0, 1, 0)
      if (controls.current) {
        controls.current.target.lerpVectors(fromTarget.current, toTarget.current, eased)
        controls.current.update()
      }
      return
    }

    const keys = pressed.current
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 1.4) * delta
    camera.getWorldDirection(direction.current)
    direction.current.y = 0
    direction.current.normalize()
    side.current.crossVectors(direction.current, up.current).normalize()

    movement.current.set(0, 0, 0)
    if (keys.has('KeyW') || keys.has('ArrowUp')) movement.current.addScaledVector(direction.current, speed)
    if (keys.has('KeyS') || keys.has('ArrowDown')) movement.current.addScaledVector(direction.current, -speed)
    if (keys.has('KeyA') || keys.has('ArrowLeft')) movement.current.addScaledVector(side.current, -speed)
    if (keys.has('KeyD') || keys.has('ArrowRight')) movement.current.addScaledVector(side.current, speed)
    if (keys.has('KeyQ')) movement.current.y -= speed
    if (keys.has('KeyE')) movement.current.y += speed

    if (movement.current.lengthSq() > 0) {
      const nextY = THREE.MathUtils.clamp(camera.position.y + movement.current.y, 0.2, 8)
      movement.current.y = nextY - camera.position.y
      camera.position.add(movement.current)
      controls.current?.target.add(movement.current)
    }
  })

  return (
    <OrbitControls
      ref={controls}
      /*
        초기 타깃. **옛 18×14×0.6m 그리드의 중심값이 남아 있는 자리다** — 그리드에서 파생하지 않는 것이
        의도다. 위 effect가 마운트 즉시(전이 시작 프레임에) ZONE 그리드에 맞춘 타깃으로 덮어쓰므로
        이 값이 화면에 보이는 순간은 없다. 조명·안개처럼 파생시켜도 결과가 같아서 그대로 둔다.
      */
      target={[3.3, 0.9, 4.2]}
      enableDamping={false}
      rotateSpeed={0.38}
      panSpeed={0.42}
      zoomSpeed={0.48}
      keyPanSpeed={3}
      minDistance={0.4}
      maxDistance={22}
      maxPolarAngle={Math.PI / 2}
    />
  )
}

function Loading() {
  return <Html center><div className="loading">3D 모델 로딩 중...</div></Html>
}

function DataCenterScene({
  /** `null` = FMS 레이아웃 미설정. 바닥도 랙도 그리지 않는다(E18 ⑤) — 화면 위 안내가 대신 뜬다. */
  grid,
  racks,
  objects,
  focusedRack,
  selectedServer,
  heatmapVisuals,
  rackSeverities,
  theme,
  onFocusRack,
  onSelectServer,
}: {
  grid: SceneGrid | null
  racks: RackData[]
  objects: SceneObject[]
  focusedRack: RackData | null
  selectedServer: ServerData | null
  heatmapVisuals: Map<string, RackHeatmapVisual>
  rackSeverities: Map<string, RackSeverity>
  theme: ThemeMode
  onFocusRack: (rack: RackData) => void
  onSelectServer: (rack: RackData, server: ServerData) => void
}) {
  const lightTheme = theme === 'light'
  const metrics = sceneMetrics(grid)
  /**
   * 태양광이 겨냥할 지점. three.js는 `light.target`의 **matrixWorld**로 방향을 잡으므로
   * 타깃이 씬 그래프에 들어가 있어야 한다 — 그래서 `<primitive>`로 실제로 씬에 넣는다.
   * (기본 타깃은 씬에 없는 원점 오브젝트여서 방향·그림자 프러스텀이 바닥 모서리 (0,0)에 붙어 있었다.)
   */
  const sunTarget = useMemo(() => new THREE.Object3D(), [])

  return (
    <>
      <color attach="background" args={[lightTheme ? '#d5e0e9' : '#071019']} />
      <fog attach="fog" args={[lightTheme ? '#d5e0e9' : '#071019', metrics.span * 1.1, metrics.span * 2.6]} />
      <ambientLight intensity={lightTheme ? 1.45 : 1.7} color="#b9d8f3" />
      <hemisphereLight args={['#e5f4ff', lightTheme ? '#728191' : '#425269', lightTheme ? 1.8 : 2.1]} />
      {/*
        태양광 — 위치·겨냥점·그림자 프러스텀 전부 ZONE 중심에서 파생한다.
        `shadow-camera-near/far`는 three.js 기본값(0.5 / 500)을 그대로 둔다. 정사영 그림자 카메라의
        깊이는 선형이라 `shadow-bias`(−0.0002)가 near/far 범위에 비례해 먹는데, 범위를 좁히면
        지금 검증된 bias 값이 그림자 여드름(acne) 쪽으로 기운다 — 손댈 이유가 없다.
      */}
      <primitive object={sunTarget} position={[metrics.centerX, 0, metrics.centerZ]} />
      <directionalLight
        position={[metrics.sun.x, metrics.sun.y, metrics.sun.z]}
        target={sunTarget}
        intensity={3.2}
        color="#e8f4ff"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
        shadow-camera-left={-metrics.shadowExtent}
        shadow-camera-right={metrics.shadowExtent}
        shadow-camera-top={metrics.shadowExtent}
        shadow-camera-bottom={-metrics.shadowExtent}
      />
      {/* 천장 소프트박스 — 바닥 중심 위에서 바닥 크기의 80%를 덮는다. */}
      <rectAreaLight
        position={[metrics.centerX, 4.8, metrics.centerZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        width={metrics.floorWidth * 0.8}
        height={metrics.floorDepth * 0.8}
        intensity={9}
        color="#d8efff"
      />
      {/* 앞쪽(전체 보기 카메라 쪽) 키 라이트 — 바닥 앞 경계 바로 바깥. */}
      <pointLight position={[metrics.centerX, 2.6, metrics.centerZ + metrics.floorDepth * 0.55]} intensity={16} distance={metrics.span * 1.3} decay={1.6} color="#d5edff" />
      {/* 좌·우 필 라이트 — 중심 기준 대칭이라 ZONE이 바뀌어도 한쪽만 어두워지지 않는다. */}
      <pointLight position={[metrics.centerX - metrics.floorWidth * 0.42, 2.2, metrics.centerZ]} intensity={8} distance={metrics.span * 0.95} decay={1.7} color="#6bc8ff" />
      <pointLight position={[metrics.centerX + metrics.floorWidth * 0.42, 2.2, metrics.centerZ]} intensity={8} distance={metrics.span * 0.95} decay={1.7} color="#8dd8ff" />
      <Environment resolution={256}>
        <Lightformer intensity={2.2} color="#dceeff" position={[0, 5, -4]} scale={[10, 4, 1]} />
        <Lightformer intensity={1.8} color="#8dccff" position={[-5, 2, 2]} rotation={[0, Math.PI / 2, 0]} scale={[6, 3, 1]} />
        <Lightformer intensity={1.6} color="#ffffff" position={[6, 1, 4]} rotation={[0, -Math.PI / 2, 0]} scale={[5, 2, 1]} />
      </Environment>
      <Suspense fallback={<Loading />}>
        {grid && <FloorTiles grid={grid} theme={theme} />}
        {grid && objects.map((object) => (
          <LayoutObjectMesh key={object.id} object={object} tileSize={grid.tileSize} />
        ))}
        {/*
          **배치가 없는 랙은 그리지 않는다**(E18 ⑤) — 좌표를 지어내면 실제 배치로 오인된다.
          그 랙들은 목록·검색·경보·대시보드에는 그대로 남고, 씬 위 안내가 수를 밝힌다.
        */}
        {grid && racks.map((rack) => rack.placement && (
          <Rack
            key={rack.id}
            rack={rack}
            placement={rack.placement}
            grid={grid}
            severity={rackSeverities.get(rack.id) ?? 'NORMAL'}
            selected={focusedRack?.id === rack.id}
            selectedServerId={selectedServer?.id ?? null}
            heatmap={heatmapVisuals.get(rack.id)}
            onSelect={onFocusRack}
            onSelectServer={onSelectServer}
          />
        ))}
        {grid && (
          <ContactShadows
            position={[metrics.centerX, 0.055, metrics.centerZ]}
            scale={metrics.contactShadowScale}
            opacity={lightTheme ? 0.25 : 0.38}
            blur={2.4}
            far={5}
            resolution={1024}
          />
        )}
      </Suspense>
      <CameraController grid={grid} focusRack={focusedRack} focusServer={selectedServer} />
    </>
  )
}

function ThemeToggle({
  theme,
  onToggle,
  className = '',
}: {
  theme: ThemeMode
  onToggle: () => void
  className?: string
}) {
  const nextThemeLabel = theme === 'dark' ? '밝은' : '어두운'

  return (
    <button
      className={`theme-toggle ${className}`.trim()}
      type="button"
      onClick={onToggle}
      aria-label={`${nextThemeLabel} 테마로 변경`}
      title={`${nextThemeLabel} 테마로 변경`}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {theme === 'dark' ? (
          <svg viewBox="0 0 24 24"><path className="theme-moon-shape" d="M19.2 15.2A8 8 0 0 1 8.8 4.8 7.1 7.1 0 1 0 19.2 15.2Z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>
        )}
      </span>
      <span className="theme-toggle-copy"><small>APPEARANCE</small><strong>{theme.toUpperCase()}</strong></span>
    </button>
  )
}

function SplashScreen({
  onComplete,
  theme,
  onToggleTheme,
}: {
  onComplete: () => void
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  useEffect(() => {
    const timer = window.setTimeout(onComplete, SPLASH_DURATION)
    return () => window.clearTimeout(timer)
  }, [onComplete])

  return (
    <main className="splash-shell" data-theme={theme}>
      <div className="splash-grid" aria-hidden="true" />
      <div className="splash-orbit splash-orbit-outer" aria-hidden="true" />
      <div className="splash-orbit splash-orbit-inner" aria-hidden="true" />
      <div className="splash-scan" aria-hidden="true" />

      <div className="splash-corner splash-corner-top-left" aria-hidden="true" />
      <div className="splash-corner splash-corner-top-right" aria-hidden="true" />
      <div className="splash-corner splash-corner-bottom-left" aria-hidden="true" />
      <div className="splash-corner splash-corner-bottom-right" aria-hidden="true" />

      <div className="splash-company-brand">
        <img src={assetUrl('hamonsoft-logo.svg')} alt="(주)하몬소프트" />
      </div>
      <ThemeToggle theme={theme} onToggle={onToggleTheme} className="splash-theme-toggle" />

      <section className="splash-content" aria-labelledby="splash-title">
        <div className="splash-emblem" aria-hidden="true">
          <div className="splash-rack">
            {Array.from({ length: 7 }, (_, index) => <span key={index} />)}
          </div>
          <i className="splash-axis splash-axis-x" />
          <i className="splash-axis splash-axis-y" />
          <i className="splash-axis splash-axis-z" />
        </div>

        <p className="splash-kicker"><span>BURUNET</span> INFRASTRUCTURE PLATFORM</p>
        <h1 id="splash-title">
          <span>3D RACK</span>
          VISUALIZATION
        </h1>
        <p className="splash-description">DATA CENTER DIGITAL TWIN · REAL-TIME INFRASTRUCTURE MONITORING</p>

        <div className="splash-loader" aria-label="시스템 초기화 중">
          <div className="splash-loader-heading">
            <span>SYSTEM INITIALIZING</span>
            <span className="splash-loader-dots"><i /><i /><i /></span>
          </div>
          <div className="splash-progress"><span /></div>
          <div className="splash-boot-steps">
            <span>RENDER ENGINE</span>
            <span>ASSET PIPELINE</span>
            <span>MONITORING CORE</span>
          </div>
        </div>

        <button className="splash-enter" type="button" onClick={onComplete}>
          ENTER VISUALIZATION <span aria-hidden="true">→</span>
        </button>
      </section>

      <div className="splash-meta splash-meta-left">BUILD 2026.07 · WEBGL READY</div>
      <div className="splash-meta splash-meta-right">SEOUL · 37.5665° N / 126.9780° E</div>
    </main>
  )
}

/**
 * 전산실 선택 화면. 목록은 netis-fms `GET /api/locations/sidebar`에서 온다(D1).
 * 로딩·실패·빈 목록을 각각 구분해 보여준다 — 빈 화면을 정상으로 오인하지 않게(R7).
 */
function DataCenterLobby({
  zones,
  loading,
  failure,
  onRetry,
  onSelect,
  userName,
  theme,
  onToggleTheme,
}: {
  zones: ZoneSummary[] | null
  loading: boolean
  failure: string | null
  onRetry: () => void
  onSelect: (zone: ZoneSummary) => void
  userName: string | null
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  const facilities = zones ?? []
  const totalRacks = facilities.reduce((total, zone) => total + zone.rackCount, 0)
  // ASSET READ가 없으면 자산 수 자체가 응답에서 빠진다 — 그때는 합계도 `—`로 둔다(C6).
  const assetCountKnown = facilities.length > 0 && facilities.every((zone) => zone.totalAssetCount !== null)
  const totalAssets = assetCountKnown
    ? facilities.reduce((total, zone) => total + (zone.totalAssetCount ?? 0), 0)
    : null

  return (
    <main className="lobby-shell" data-theme={theme}>
      <div className="lobby-glow lobby-glow-one" />
      <div className="lobby-glow lobby-glow-two" />

      <header className="lobby-header">
        <div className="rack3d-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48">
            <path className="rack3d-mark-top" d="M8 12 25 5l15 8-17 7Z" />
            <path className="rack3d-mark-left" d="M8 12v24l15 7V20Z" />
            <path className="rack3d-mark-right" d="m23 20 17-7v24l-17 6Z" />
            <path className="rack3d-mark-slots" d="m27 23 9-3v3l-9 3Zm0 6 9-3v3l-9 3Zm0 6 9-3v3l-9 3Z" />
            <circle cx="19" cy="35" r="1.35" />
          </svg>
        </div>
        <div className="lobby-brand-copy">
          <p className="lobby-brand-kicker">Hamonsoft</p>
          <h1>Rack3D Visualization</h1>
        </div>
        <div className="lobby-system-status"><i /> {userName ? `${userName} 님` : 'NETIS-FMS'}</div>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} className="lobby-theme-toggle" />
      </header>

      <section className="lobby-content">
        <div className="lobby-intro">
          <div>
            <p className="section-index">01 / SELECT FACILITY</p>
            <h2>전산실을 선택하세요</h2>
            <p>인프라 현황을 확인하고 관리할 전산실을 선택하면<br />3D 랙 모니터링 화면으로 이동합니다.</p>
          </div>
          <dl className="fleet-summary">
            <div><dt>FACILITIES</dt><dd>{zones ? String(facilities.length).padStart(2, '0') : NO_VALUE}</dd></div>
            <div><dt>TOTAL RACKS</dt><dd>{zones ? totalRacks : NO_VALUE}</dd></div>
            {/*
              ⚠️ 이 수는 상단바 `IN RACKS`와 **모집단이 다르다**. 여기는 사이드바
              `totalAssetCount`(ZONE 서브트리 전체 — 랙 밖에 놓인 CRAC·UPS·배전반까지 포함)이고,
              상단바는 랙 안 자산만이다. 같은 `ASSETS` 라벨을 쓰면 들어갔을 때 수가 줄어든 것이
              오류로 읽힌다 — §11-10에서 시작해 MOUNTED/IN RACK까지 나눈 그 문제의 세 번째 모집단이다.
            */}
            <div title="전산실(ZONE) 전체 자산 — 랙 밖에 놓인 CRAC·UPS·배전반 포함">
              <dt>ZONE ASSETS</dt><dd>{totalAssets ?? NO_VALUE}</dd>
            </div>
          </dl>
        </div>

        {loading && !zones ? (
          <p className="lobby-state">netis-fms에서 전산실 목록을 불러오는 중…</p>
        ) : failure ? (
          <div className="lobby-state error" role="alert">
            <p>{failure}</p>
            <RetryButton className="overview-button" onRetry={onRetry} busy={loading}>다시 시도</RetryButton>
          </div>
        ) : facilities.length === 0 ? (
          <p className="lobby-state" role="status">
            조회할 수 있는 전산실이 없습니다. netis-fms에서 위치 조회 범위를 확인하세요.
          </p>
        ) : (
          <div className="facility-list">
            {facilities.map((zone, index) => (
              <button
                className="facility-card"
                key={zone.id}
                type="button"
                onClick={() => onSelect(zone)}
                onPointerEnter={preloadSceneAssets}
                onFocus={preloadSceneAssets}
              >
                <span className="facility-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="facility-main">
                  <span className="facility-heading">
                    <span className="facility-code">{zone.code ?? NO_VALUE}</span>
                  </span>
                  <strong>{zone.name}</strong>
                  <small>{zone.path || NO_VALUE}</small>
                </span>
                <span className="facility-metrics">
                  <span><small>RACKS</small><strong>{String(zone.rackCount).padStart(2, '0')}</strong></span>
                  <span title="전산실 전체 자산 — 랙 밖 설비(CRAC·UPS 등) 포함">
                    <small>ZONE ASSETS</small>
                    <strong>{zone.totalAssetCount === null ? NO_VALUE : zone.totalAssetCount}</strong>
                  </span>
                </span>
                <span className="facility-enter" aria-hidden="true">ENTER <i>→</i></span>
              </button>
            ))}
          </div>
        )}
      </section>

      <footer className="lobby-footer">
        <span>BURUNET NOC PLATFORM</span>
        <span>SOURCE · NETIS-FMS</span>
      </footer>
    </main>
  )
}

/**
 * 장비 상세 — **netis-fms 자산 원장(u맵 `RackAsset`) 값만** 표시한다.
 *
 * 예전 이 패널은 CPU·메모리·온도·전력·업타임·최근 활동·장애 워크플로를 보여줬는데
 * 전부 `serverProfiles` 하드코딩이었다. netis-fms는 IT 장비 텔레메트리를 수집하지 않으므로
 * (A6 = b 확정) 그 값들은 **대체 소스가 없다** — 되살리지 않고 없는 이유를 밝힌다(Q5-b·C7).
 */
function ServerDetailPanel({
  rack,
  server,
  onBackToRack,
  onOverview,
}: {
  rack: RackData
  server: ServerData
  onBackToRack: () => void
  onOverview: () => void
}) {
  return (
    <>
      <div className="server-panel-toolbar">
        <button type="button" onClick={onBackToRack}><span aria-hidden="true">←</span> RACK {rack.label}</button>
        <span><i /> NETIS-FMS</span>
      </div>

      <p className="panel-title">ASSET DETAIL</p>
      <div className="server-focus-heading">
        <div>
          <strong>{server.name}</strong>
          <span>{server.assetCode}</span>
        </div>
        {/*
          `lifecycleStatus`는 자산 원장의 생애주기(OPERATION 등)다. **건강 상태가 아니므로**
          초록/빨강으로 칠하지 않고 중립 배지로 원값을 그대로 보여준다.
        */}
        <span className="server-state neutral" title="자산 생애주기 상태 (netis-fms)"><i />{orDash(server.lifecycleStatus)}</span>
      </div>
      <span className="server-model-name">{orDash(server.category)}</span>

      <section className="server-location-grid" aria-label="장비 설치 위치">
        <div><span>RACK</span><strong>{rack.label}</strong></div>
        <div><span>POSITION</span><strong>{formatUnitRange(server)}</strong></div>
        <div><span>HEIGHT</span><strong>{server.units}<small> U</small></strong></div>
      </section>

      <section className="server-system-info">
        <div className="server-section-heading"><span>ASSET REGISTER</span><small>NETIS-FMS</small></div>
        <dl>
          <div><dt>CATEGORY</dt><dd>{orDash(server.category)}</dd></div>
          <div><dt>MANUFACTURER</dt><dd>{orDash(server.manufacturer)}</dd></div>
          <div><dt>MODEL</dt><dd>{orDash(server.modelName)}</dd></div>
          <div><dt>SERIAL NUMBER</dt><dd>{orDash(server.serialNo)}</dd></div>
          <div><dt>IP ADDRESS</dt><dd>{orDash(server.ip)}</dd></div>
          <div><dt>SPEC</dt><dd>{orDash(server.spec)}</dd></div>
          <div><dt>MONITORING</dt><dd>{orDash(server.monitoringType)}</dd></div>
        </dl>
        <p className="rack-source-note">
          값이 비어 있는 항목은 netis-fms 자산 원장에 등록되지 않은 것입니다.
        </p>
      </section>

      <section className="server-telemetry">
        <div className="server-section-heading"><span>LIVE TELEMETRY</span><small>미연동</small></div>
        <p className="rack-source-note">
          CPU·메모리·온도·트래픽 등 장비 단위 실시간 지표는 netis-fms가 수집하지 않습니다.
          랙 단위 온·습도·전력은 랙 상세에서 확인하세요.
        </p>
      </section>

      <section className="server-telemetry">
        <div className="server-section-heading"><span>3D MODEL</span><small>형상 근사</small></div>
        <p className="rack-source-note">
          {serverModelLabels[server.model]} 형상을 {server.units}U 높이에 맞춰 표시합니다.
          실제 제조사·모델명은 위 ASSET REGISTER 값입니다.
          {server.hasFront || server.hasRear ? ' 실물 사진(FRONT/REAR)이 등록되어 있습니다 — 3D 텍스처 적용은 후속 작업입니다.' : ''}
        </p>
      </section>

      <div className="server-panel-actions">
        <button type="button" onClick={onBackToRack}><span aria-hidden="true">←</span> 랙 상세</button>
        <button type="button" onClick={onOverview}>전체 보기</button>
      </div>
      <div className="mouse-tip">3D 장비 또는 장비 목록을 클릭해 상세 정보를 확인할 수 있습니다.</div>
    </>
  )
}

/** 경보 랙 1건 — 씬 랙 + FMS 집계 원본. 값은 전부 FMS가 준 것이다. */
type RackAlertEntry = {
  rack: RackData
  facts: RackSummary
}

type AssetSearchResult = {
  id: string
  kind: 'rack' | 'server'
  label: string
  subtitle: string
  keywords: string
  rack: RackData
  server?: ServerData
}

function AssetSearch({
  rackData,
  /** FMS 랙 집계 — 검색 결과의 랙 요약도 여기서만 파생한다(상세 패널과 같은 소스). */
  rackFacts,
  onSelectRack,
  onSelectServer,
}: {
  rackData: RackData[]
  rackFacts: Map<string, RackSummary>
  onSelectRack: (rack: RackData) => void
  onSelectServer: (rack: RackData, server: ServerData) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const searchIndex = useMemo<AssetSearchResult[]>(() => rackData.flatMap((rack) => {
    // 랙 요약 수치는 FMS 집계(`RackSummary`)에서만 낸다. 씬 랙(`RackData`)에서 다시 세면
    // 같은 랙의 상세 패널과 다른 숫자가 나온다 — 한 화면 안의 모순(C6).
    const facts = rackFacts.get(rack.id) ?? null
    const rackResult: AssetSearchResult = {
      id: rack.id,
      kind: 'rack',
      label: `RACK ${rack.label}`,
      subtitle: `장착 ${facts ? facts.assetCount : NO_VALUE} · `
        + `${facts ? facts.occupiedUnits : NO_VALUE} / ${facts?.rackUnits ?? NO_VALUE}U USED`,
      keywords: `${rack.id} rack ${rack.label} ${facts?.code ?? ''} ${rack.servers.map((server) => server.name).join(' ')}`.toLowerCase(),
      rack,
    }
    // 검색 키워드는 **FMS 자산 원장 값만** 쓴다. 3D 형상 모델명(`server.model`)은
    // 우리가 고른 근사치라 검색어로 넣으면 없는 장비가 검색되는 것처럼 보인다.
    const serverResults = rack.servers.map<AssetSearchResult>((server) => ({
      id: server.id,
      kind: 'server',
      label: server.name,
      subtitle: `RACK ${rack.label} · ${formatUnitRange(server)} · ${server.ip ?? 'IP 미등록'}`,
      keywords: [
        server.assetCode,
        server.name,
        server.category,
        server.manufacturer,
        server.modelName,
        server.serialNo,
        server.ip,
        server.lifecycleStatus,
        rack.id,
        rack.label,
      ].filter(Boolean).join(' ').toLowerCase(),
      rack,
      server,
    }))
    return [rackResult, ...serverResults]
  }), [rackData, rackFacts])
  const results = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    return searchIndex
      .filter((result) => tokens.every((token) => result.keywords.includes(token) || result.label.toLowerCase().includes(token)))
      .sort((a, b) => {
        const normalizedQuery = query.trim().toLowerCase()
        const aStarts = a.label.toLowerCase().startsWith(normalizedQuery) ? 0 : 1
        const bStarts = b.label.toLowerCase().startsWith(normalizedQuery) ? 0 : 1
        return aStarts - bStarts || (a.kind === b.kind ? 0 : a.kind === 'rack' ? -1 : 1)
      })
      .slice(0, 7)
  }, [query, searchIndex])

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target
      const isTyping = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)
      if (event.key !== '/' || isTyping || event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      input.current?.focus()
      if (query.trim()) setOpen(true)
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [query])

  const selectResult = (result: AssetSearchResult) => {
    if (result.server) onSelectServer(result.rack, result.server)
    else onSelectRack(result.rack)
    setQuery(result.label)
    setOpen(false)
    input.current?.blur()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false)
      input.current?.blur()
      return
    }
    if (results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => (current + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => (current - 1 + results.length) % results.length)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      selectResult(results[Math.min(activeIndex, results.length - 1)])
    }
  }

  return (
    <div
      className={open && query.trim() ? 'asset-search open' : 'asset-search'}
      role="search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div className="asset-search-field">
        <span className="asset-search-icon" aria-hidden="true" />
        <input
          ref={input}
          value={query}
          type="search"
          role="combobox"
          placeholder="장비 · 자산코드 · IP · 시리얼 · 랙 검색"
          aria-label="장비, 자산코드, IP, 시리얼 또는 랙 검색"
          aria-expanded={open && query.trim().length > 0}
          aria-controls="asset-search-results"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-activedescendant={open && results[activeIndex] ? `asset-result-${results[activeIndex].id}` : undefined}
          onFocus={() => { if (query.trim()) setOpen(true) }}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true) }}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button
            className="asset-search-clear"
            type="button"
            onClick={() => { setQuery(''); setOpen(false); input.current?.focus() }}
            aria-label="검색어 지우기"
          >×</button>
        )}
        <kbd>/</kbd>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {query.trim() ? `${results.length}개의 검색 결과` : ''}
      </span>

      {open && query.trim() && (
        <div className="asset-search-results" id="asset-search-results" role="listbox" aria-label="인프라 검색 결과">
          <div className="asset-search-results-head" role="presentation">
            <span>SEARCH RESULTS</span><strong>{String(results.length).padStart(2, '0')}</strong>
          </div>
          {results.map((result, index) => (
            <button
              id={`asset-result-${result.id}`}
              className={index === activeIndex ? 'asset-search-result active' : 'asset-search-result'}
              key={`${result.kind}-${result.id}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              onPointerEnter={() => setActiveIndex(index)}
              onClick={() => selectResult(result)}
            >
              <span className={`asset-result-symbol ${result.kind}`} aria-hidden="true">{result.kind === 'rack' ? 'R' : 'S'}</span>
              <span className="asset-result-copy"><strong>{result.label}</strong><small>{result.subtitle}</small></span>
              {/* 상태 배지가 아니라 **분류 배지**다 — 장비 상태 소스가 없다(A6 = b). */}
              <span className="asset-result-status rack">
                {result.server ? orDash(result.server.category) : 'RACK'}
              </span>
              <span className="asset-result-enter" aria-hidden="true">↵</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="asset-search-empty" role="presentation"><span>⌕</span><strong>검색 결과가 없습니다</strong><small>장비명, 자산코드, IP, 시리얼 또는 랙 이름을 확인하세요.</small></div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 경보 랙 탐색기.
 *
 * 예전에는 **장비 단위** 장애(시드 `status`)를 훑었는데 그 소스는 없어졌다(A6 = b).
 * 대신 **FMS 판정(`RackSummary.severity`)이 NORMAL이 아닌 랙**을 훑는다 — 이건 실데이터다.
 * 장애 티켓(담당자·조치 상태)은 `GET /api/tickets` 연동 후에 붙인다.
 */
function IncidentNavigator({
  active,
  hidden,
  alerts,
  /** 랙 목록 자체를 아직 못 받았으면 true — 개수를 0으로 단언하지 않는다(C6). */
  unavailable,
  currentIndex,
  onToggle,
  onPrevious,
  onNext,
}: {
  active: boolean
  hidden: boolean
  alerts: RackAlertEntry[]
  unavailable: boolean
  currentIndex: number
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  const current = currentIndex >= 0 ? alerts[currentIndex] : alerts[0]
  const tone = current ? severityTones[current.facts.severity] : 'normal'

  return (
    <section
      className={`incident-navigator${active ? ' active' : ''}${hidden ? ' dashboard-open' : ''}`}
      aria-label="경보 랙 탐색 모드"
      aria-hidden={hidden}
      inert={hidden}
    >
      <button
        className="incident-mode-toggle"
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        disabled={alerts.length === 0}
        title="netis-fms 판정이 정상이 아닌 랙을 차례로 확인합니다"
      >
        <span className="incident-mode-icon" aria-hidden="true">!</span>
        <span><small>ALERT RACKS</small><strong>{active ? 'ALERT MODE ACTIVE' : '경보 랙 탐색'}</strong></span>
        <em>{unavailable ? NO_VALUE : String(alerts.length).padStart(2, '0')}</em>
      </button>

      {active && current && (
        <div className="incident-navigator-body" aria-live="polite">
          <div className="incident-navigator-heading">
            <span className={`incident-severity ${tone}`}><i />{severityLabel(current.facts.severity)}</span>
            <strong>{currentIndex + 1} / {alerts.length}</strong>
          </div>
          <div className="incident-navigator-asset">
            <strong>RACK {current.rack.label}</strong>
            <span>{current.facts.code ?? NO_VALUE}</span>
            <small>장착 {current.facts.assetCount} · {current.facts.occupiedUnits} / {current.facts.rackUnits ?? NO_VALUE}U</small>
          </div>
          <div className="incident-navigator-meta">
            <span>TEMP <strong>{current.facts.temp != null ? `${current.facts.temp.toFixed(1)}°C` : NO_VALUE}</strong></span>
            <span>POWER <strong>{current.facts.powerKw != null ? `${current.facts.powerKw.toFixed(2)}kW` : NO_VALUE}</strong></span>
            <span>수신 <strong>{current.facts.collectedAt ? new Date(current.facts.collectedAt).toLocaleTimeString('ko-KR') : NO_VALUE}</strong></span>
          </div>
          <div className="incident-navigator-actions">
            <button type="button" onClick={onPrevious} aria-label="이전 경보 랙으로 이동"><span aria-hidden="true">←</span> PREV</button>
            <button type="button" onClick={onToggle}>EXIT MODE</button>
            <button type="button" onClick={onNext} aria-label="다음 경보 랙으로 이동">NEXT <span aria-hidden="true">→</span></button>
          </div>
        </div>
      )}
    </section>
  )
}

function HeatmapControl({
  mode,
  dataset,
  hidden,
  onChange,
}: {
  mode: HeatmapMode
  dataset: HeatmapDataset
  hidden: boolean
  onChange: (mode: HeatmapMode) => void
}) {
  const [open, setOpen] = useState(false)
  const meta = heatmapModeMeta[mode]
  const activeMode = mode === 'normal' ? null : mode

  return (
    <section
      className={`heatmap-control${activeMode ? ' active' : ''}${open ? ' open' : ''}${hidden ? ' dashboard-open' : ''}`}
      aria-label="3D 히트맵 보기 설정"
      aria-hidden={hidden}
      inert={hidden}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      {open && (
        <div className="heatmap-mode-menu" id="heatmap-mode-menu" role="group" aria-label="히트맵 지표 선택">
          <div className="heatmap-mode-menu-heading"><span>3D DATA LAYERS</span><small>LOW</small><i /><small>HIGH</small></div>
          {heatmapModes.map((option) => {
            const optionMeta = heatmapModeMeta[option]
            return (
              <button
                className={`${mode === option ? 'active' : ''}${optionMeta.available ? '' : ' unavailable'}`}
                type="button"
                aria-pressed={mode === option}
                // netis-fms에 소스가 없는 모드는 고를 수 없게 막는다 —
                // 켜 봐야 전 랙이 같은 값으로 칠해져 실측처럼 오인된다.
                disabled={!optionMeta.available}
                onClick={() => { onChange(option); setOpen(false) }}
                key={option}
              >
                <i aria-hidden="true">{optionMeta.symbol}</i>
                <span><strong>{optionMeta.label}</strong><small>{optionMeta.description}</small></span>
                <em>{optionMeta.available ? (mode === option ? 'ACTIVE' : 'SELECT') : '미연동'}</em>
              </button>
            )
          })}
        </div>
      )}

      <button
        className="heatmap-toggle"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="heatmap-mode-menu"
        aria-label={`히트맵 보기 설정, 현재 ${meta.label}`}
      >
        <span className="heatmap-toggle-icon" aria-hidden="true">{meta.symbol}</span>
        <span className="heatmap-toggle-copy"><small>3D DATA LAYER</small><strong>{meta.label}</strong></span>
        {activeMode ? (
          <span className="heatmap-toggle-scale">
            <i />
            <small><b>{formatHeatmapValue(activeMode, dataset.min)}</b><b>{formatHeatmapValue(activeMode, dataset.max)}</b></small>
          </span>
        ) : (
          <em className="heatmap-toggle-off">OFF</em>
        )}
        <span className="heatmap-toggle-chevron" aria-hidden="true">{open ? '⌄' : '⌃'}</span>
      </button>
    </section>
  )
}

function DataCenterDashboard({
  open,
  onToggle,
  onSelectAlertRack,
  dataCenter,
  zone,
  rackFacts,
  lastUpdatedAt,
  racks,
  alertRacks,
  activeAlertRackId,
}: {
  open: boolean
  onToggle: () => void
  onSelectAlertRack: (rack: RackData) => void
  dataCenter: ZoneSummary
  zone: ZoneAggregate | null
  rackFacts: Map<string, RackSummary>
  lastUpdatedAt: Date | null
  racks: RackData[]
  alertRacks: RackAlertEntry[]
  activeAlertRackId: string | null
}) {
  /** 장비 구성은 `categoryCounts`(랙 내 전체 자산)에서 낸다 — 많은 쪽이 전체 모집단이다. */
  const categoryRows = useMemo(() => {
    const totals = zone?.categoryTotals ?? {}
    return Object.entries(totals).sort((a, b) => b[1] - a[1])
  }, [zone])
  const categoryMax = categoryRows.reduce((largest, [, count]) => Math.max(largest, count), 0)
  // categoryCounts가 비면 합이 0이 되는데 그건 "0대"가 아니라 부재일 수 있다 — 음수 차이를 만들지 않는다.
  const zoneRackAssetCount = zone ? displayRackAssetCount(zone.rackAssetCount, zone.mountedAssetCount) : null
  const zoneUnmountedCount = zone ? unmountedAssetCount(zoneRackAssetCount, zone.mountedAssetCount) : null

  return (
    <>
      <section
        className={open ? 'dashboard-panel open' : 'dashboard-panel'}
        aria-label={`${dataCenter.name} 통합 대시보드`}
        aria-hidden={!open}
        inert={!open}
      >
          <header className="dashboard-header">
            <div>
              <p>{dataCenter.code ?? NO_VALUE} · OPERATIONS OVERVIEW</p>
              <h2>{dataCenter.name} Dashboard</h2>
            </div>
            <div className="dashboard-freshness">
              <i /> NETIS-FMS
              <span>{lastUpdatedAt ? `갱신 ${lastUpdatedAt.toLocaleTimeString('ko-KR')}` : '갱신 대기'}</span>
            </div>
          </header>

          <div className="dashboard-scroll">
            {/*
              KPI는 전부 FMS 랙 집계(RackSummary)에서 파생한다. 장비 단위 지표(FLEET HEALTH)는
              FMS가 IT 장비 텔레메트리를 수집하지 않아(A6 = b) 소스가 없다 — 0이 아니라 `—`다(C6).
            */}
            <section className="dashboard-kpis">
              {/*
                두 자산 수는 정의가 다르다(§11-11 Q1) — 큰 쪽(랙 내 전체)을 대표값으로 두고
                작은 쪽(U 배정)을 캡션에 함께 밝힌다. 하나만 보여주면 사용자가 다른 화면의
                수와 어긋난 이유를 알 수 없다.
              */}
              <article>
                <span>ASSETS IN RACKS</span>
                <strong>{zoneRackAssetCount ?? NO_VALUE}</strong>
                <em>
                  {zone
                    ? `장착(U 배정) ${zone.mountedAssetCount}대`
                      + (zoneUnmountedCount !== null ? ` · U 미배정 ${zoneUnmountedCount}대` : '')
                    : '집계 대기'}
                </em>
              </article>
              <article>
                <span>CAPACITY USED</span>
                <strong>
                  {zone?.occupiedUnits ?? NO_VALUE}
                  <small> / {zone?.totalUnits ?? NO_VALUE}U</small>
                </strong>
                <em>
                  {zone?.occupancyPercent != null ? `${zone.occupancyPercent.toFixed(1)}% occupied` : '랙 크기 미설정'}
                  {zone?.unitsPartial ? ' · 일부 랙 크기 미설정' : ''}
                </em>
              </article>
              <article className={zone && zone.alertRackCount > 0 ? 'danger' : ''}>
                <span>ALERT RACKS</span>
                <strong>{zone ? zone.alertRackCount : NO_VALUE}</strong>
                <em>
                  {zone ? `${zone.criticalRackCount} critical · ${zone.staleRackCount} stale` : '집계 대기'}
                </em>
              </article>
              <article>
                <span>AVAILABLE</span>
                <strong>{zone?.availableUnits ?? NO_VALUE}<small> U</small></strong>
                {/* 여유 U는 **크기가 설정된 랙에서만** 파생된다 — 전체 랙 수를 쓰면 집계 범위를 과장한다. */}
                <em>
                  {zone ? `across ${zone.sizedRackCount} racks` : NO_VALUE}
                  {zone?.unitsPartial ? ` (전체 ${zone.rackCount}대 중 크기 설정분)` : ''}
                </em>
              </article>
            </section>

            {/*
              온습도 추이 — **자리만 남기고 값은 그리지 않는다**(Q5-b 확정).
              예전에는 사인파 생성값을 "샘플 N"으로 라벨링해 그렸는데, °C 축이 달린 곡선은
              라벨보다 **그래프 모양이 먼저 읽힌다** — 관제 화면에서 가장 위험한 형태다(D3·C7).
              생성기(`createTemperatureHistory`)는 제거했다. FMS E19 B4 연동 시 이 자리에 실측이 들어온다.
            */}
            <article className="dashboard-card temperature-history-card">
              <div className="dashboard-card-heading">
                <div><span>ENVIRONMENT · LAST 24H</span><h3>Temperature trend</h3></div>
                <small>미연동 · E19 B4</small>
              </div>
              {/*
                `role="status"`(aria-live)가 아니라 `note`다 — 내용이 영구 정적이라
                대시보드를 열 때마다 스크린리더가 같은 문장을 다시 읽을 이유가 없다.
                aria-live는 값이 바뀌는 것에 쓴다(상단바 LIVE 뱃지 등).
              */}
              <div className="chart-placeholder" role="note">
                <strong>{NO_VALUE}</strong>
                <p>전산실 온습도 시계열은 아직 netis-fms와 연동되지 않았습니다.</p>
                <small>GET /api/performance/series/zone (E19 B4)</small>
              </div>
            </article>

            <section className="dashboard-chart-grid">
              <article className="dashboard-card capacity-chart-card">
                <div className="dashboard-card-heading">
                  <div><span>CAPACITY</span><h3>Rack utilization</h3></div>
                  <small>USED / RACK U · NETIS-FMS</small>
                </div>
                <div className="rack-bars">
                  {racks.map((rack) => {
                    const facts = rackFacts.get(rack.id) ?? null
                    const percent = rackOccupancyPercent(facts)
                    return (
                      <div className="rack-bar-row" key={rack.id}>
                        <strong>{rack.label}</strong>
                        <div><span style={{ width: `${percent ?? 0}%` }} /></div>
                        <em>
                          {facts ? facts.occupiedUnits : NO_VALUE}/{facts?.rackUnits ?? NO_VALUE}U
                        </em>
                      </div>
                    )
                  })}
                </div>
              </article>

              {/*
                장비 단위 상태·모델 구성은 랙 U맵(GET /api/racks/{id}/u-map)이 있어야 나온다.
                지금 그리면 도넛이 "SERVERS 0"으로 채워져 실측처럼 읽힌다 — 값 대신 미연동을 밝힌다(C6).
              */}
              <article className="dashboard-card health-chart-card">
                <div className="dashboard-card-heading">
                  <div><span>HEALTH</span><h3>Server status</h3></div>
                </div>
                <p className="rack-source-note">
                  장비 단위 상태는 netis-fms가 수집하지 않습니다(IT 장비 텔레메트리 미도입).
                </p>
              </article>

              {/*
                카테고리 구성은 FMS `categoryCounts` 실값이다(랙 내 전체 자산 기준).
                예전의 "서버 모델 3종 믹스"는 우리 GLB 이름을 센 것이라 되살리지 않는다 —
                3D 형상은 근사치이고 제조사·모델명은 자산마다 다르다.
              */}
              <article className="dashboard-card model-chart-card">
                <div className="dashboard-card-heading">
                  <div><span>ASSET MIX</span><h3>Category</h3></div>
                  <small>랙 내 자산 · NETIS-FMS</small>
                </div>
                {categoryRows.length === 0 ? (
                  <p className="rack-source-note">
                    {zone ? '이 전산실의 랙에 등록된 활성 자산이 없습니다.' : '집계를 기다리는 중입니다.'}
                  </p>
                ) : (
                  <div className="rack-bars">
                    {categoryRows.map(([category, count]) => (
                      <div className="rack-bar-row" key={category}>
                        <strong>{category}</strong>
                        <div><span style={{ width: `${categoryMax > 0 ? count / categoryMax * 100 : 0}%` }} /></div>
                        <em>{count}</em>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            </section>

            <section className="dashboard-card incident-card">
              <div className="dashboard-card-heading">
                <div><span>OPERATIONS</span><h3>Alert racks</h3></div>
                {/* 장애 티켓(담당자·조치 상태)의 SSOT는 FMS `GET /api/tickets`이며 아직 연동 전이다. */}
                <small>{zone ? `${zone.alertRackCount} RACKS NOT NORMAL` : NO_VALUE}</small>
              </div>
              <div className="incident-table" aria-label="경보 랙 목록">
                <div className="incident-row incident-head" aria-hidden="true">
                  <span>SEVERITY</span><span>RACK</span><span>TEMP</span><span>HUMIDITY</span><span>POWER</span><span>COLLECTED</span>
                </div>
                {alertRacks.map(({ rack, facts }) => (
                  <button
                    className={activeAlertRackId === rack.id ? 'incident-row active' : 'incident-row'}
                    type="button"
                    key={rack.id}
                    onClick={() => onSelectAlertRack(rack)}
                    aria-label={`RACK ${rack.label}, ${severityLabel(facts.severity)}, 상세 보기`}
                  >
                    <span className={`incident-severity ${severityTones[facts.severity]}`}><i />{severityLabel(facts.severity)}</span>
                    <strong>RACK {rack.label}</strong>
                    <span>{facts.temp != null ? `${facts.temp.toFixed(1)} °C` : NO_VALUE}</span>
                    <span>{facts.humidity != null ? `${facts.humidity.toFixed(1)} %` : NO_VALUE}</span>
                    <span>{facts.powerKw != null ? `${facts.powerKw.toFixed(2)} kW` : NO_VALUE}</span>
                    <span>
                      {facts.collectedAt ? new Date(facts.collectedAt).toLocaleTimeString('ko-KR') : NO_VALUE}
                      {facts.stale ? ' · 통신두절' : ''}
                    </span>
                  </button>
                ))}
                {alertRacks.length === 0 && (
                  <div className="incident-empty">
                    {zone
                      ? 'netis-fms 판정이 정상이 아닌 랙이 없습니다.'
                      : '랙 집계를 기다리는 중입니다.'}
                    {' '}장비 단위 장애 목록(담당자·조치 상태)은 FMS 티켓 연동 후 표시됩니다 (GET /api/tickets).
                  </div>
                )}
              </div>
            </section>
          </div>
      </section>

      <button className={open ? 'dashboard-toggle open' : 'dashboard-toggle'} type="button" onClick={onToggle} aria-expanded={open}>
        <span className="dashboard-toggle-icon" aria-hidden="true"><i /><i /><i /><i /></span>
        <span className="dashboard-toggle-copy"><small>SERVER ROOM</small><strong>DASHBOARD</strong></span>
        <span className={zone && zone.alertRackCount > 0 ? 'dashboard-alert-count active' : 'dashboard-alert-count'}>
          <i />{zone ? `${zone.alertRackCount} ALERT RACKS` : `${NO_VALUE} ALERT RACKS`}
        </span>
        <span className="dashboard-chevron" aria-hidden="true">{open ? '⌄' : '⌃'}</span>
      </button>
    </>
  )
}

/**
 * 수동 재시도 버튼.
 *
 * 실제 연타 방어는 `usePolledResource`의 쿨다운이 한다(버튼을 우회해도 막힌다).
 * 여기서는 **왜 안 먹는지 보이게** 한다 — 즉답 실패(404·429)에서는 `loading`이 순식간에
 * 꺼져 버려 그것만으로는 연타를 막지도, 설명하지도 못한다.
 */
function RetryButton({
  onRetry,
  busy,
  className,
  children,
  icon,
  kicker,
}: {
  onRetry: () => void
  busy: boolean
  className?: string
  children: string
  /** 주면 상단바 버튼 형태(아이콘 + 2줄 카피)로 렌더한다. 없으면 글자만. */
  icon?: ReactNode
  kicker?: string
}) {
  const [coolingDown, setCoolingDown] = useState(false)

  useEffect(() => {
    if (!coolingDown) return
    const timer = window.setTimeout(() => setCoolingDown(false), MANUAL_RETRY_COOLDOWN_MS)
    return () => window.clearTimeout(timer)
  }, [coolingDown])

  return (
    <button
      className={className}
      type="button"
      disabled={busy || coolingDown}
      onClick={() => {
        setCoolingDown(true)
        onRetry()
      }}
    >
      {icon ? (
        <>
          <span className="theme-toggle-icon" aria-hidden="true">{icon}</span>
          <span className="theme-toggle-copy">
            <small>{kicker}</small>
            <strong>{coolingDown ? '잠시 후 다시' : children}</strong>
          </span>
        </>
      ) : (
        coolingDown ? '잠시 후 다시 시도' : children
      )}
    </button>
  )
}

type SessionState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'password-change' }
  | { status: 'ready'; me: MeResponse }

/** 부트스트랩은 페이지 로드당 1회 — StrictMode 이중 실행이 리프레시를 두 번 소비하지 않게 한다. */
let bootstrapStarted = false

/**
 * 세션 복원 중/실패 화면. **로그인 폼은 만들지 않는다**(결정 2-a) —
 * 인증은 FMS가 담당하고 rack3d는 넘기기만 한다.
 */
function SessionNotice({
  status,
  theme,
  onToggleTheme,
}: {
  status: 'loading' | 'expired' | 'password-change'
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  return (
    <main className="lobby-shell" data-theme={theme}>
      <div className="lobby-glow lobby-glow-one" />
      <header className="lobby-header">
        <div className="lobby-brand-copy">
          <p className="lobby-brand-kicker">Hamonsoft</p>
          <h1>Rack3D Visualization</h1>
        </div>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} className="lobby-theme-toggle" />
      </header>
      <section className="lobby-content">
        <div className="session-notice" role="status">
          {status === 'loading' ? (
            <>
              <p className="section-index">SESSION</p>
              <h2>세션을 확인하는 중입니다…</h2>
              <p>netis-fms 로그인 상태를 복원하고 있습니다.</p>
            </>
          ) : status === 'password-change' ? (
            <>
              {/* C4 — 비밀번호 변경은 rack3d가 처리하지 않는다. FMS 화면으로 넘긴다. */}
              <p className="section-index">PASSWORD CHANGE REQUIRED</p>
              <h2>비밀번호를 변경해야 합니다</h2>
              <p>netis-fms에서 비밀번호를 변경한 뒤 다시 접속하세요.</p>
              <button className="overview-button" type="button" onClick={goToFmsPasswordChange}>
                netis-fms 비밀번호 변경으로 이동
              </button>
            </>
          ) : (
            <>
              <p className="section-index">SESSION EXPIRED</p>
              <h2>세션이 만료되었습니다</h2>
              <p>netis-fms에 로그인한 뒤 다시 접속하세요.</p>
              <button className="overview-button" type="button" onClick={goToFmsLogin}>
                netis-fms 로그인으로 이동
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  )
}

/**
 * 씬 랙 목록 — **값이 안 바뀐 랙은 이전 객체를 그대로 돌려준다.**
 *
 * 랙 목록 폴링(30초)과 u맵 스윕(랙 1건마다)이 각각 새 배열을 만들기 때문에, 신원을 값에
 * 묶지 않으면 `RackData` 객체가 초당 두 번씩 바뀐다. 그러면 `focusRack`을 의존성으로 쓰는
 * `CameraController`의 effect가 계속 재실행되어 **카메라 전이(0.85초)가 영원히 끝나지 않고
 * 마우스·휠·WASD가 전부 먹히지 않는다**(스윕이 도는 18초 내내 + 300초마다 반복).
 *
 * ref를 렌더 중에 쓰면 `react-hooks/refs`에 걸리므로, 이 저장소가 이미 쓰는
 * "렌더 중 상태 조정" 패턴(`usePolledResource`)으로 캐시를 상태에 둔다.
 */
function useZoneScene(
  zoneRacks: RackSummary[] | null,
  layout: ZoneLayout | null,
  uMaps: RackUMap[] | null,
): { grid: SceneGrid | null; racks: RackData[]; objects: SceneObject[] } {
  const build = (cache: Map<string, RackCacheEntry>) => {
    const scene = buildZoneScene(zoneRacks, layout, uMaps)
    const { racks, cache: nextCache } = reuseUnchangedRacks(cache, scene.racks)
    return { grid: scene.grid, objects: scene.objects, racks, cache: nextCache }
  }

  const [state, setState] = useState(() => {
    const result = build(new Map<string, RackCacheEntry>())
    return { zoneRacks, layout, uMaps, ...result }
  })

  if (state.zoneRacks !== zoneRacks || state.layout !== layout || state.uMaps !== uMaps) {
    const result = build(state.cache)
    setState({ zoneRacks, layout, uMaps, ...result })
  }

  return state
}

function preloadSceneAssets() {
  useGLTF.preload(assetUrl('models/rack-42u.glb'), GLTF_USE_DRACO, GLTF_USE_MESHOPT)
  useGLTF.preload(assetUrl(`models/dell-poweredge-r760.glb?v=${MODEL_VERSION}`), GLTF_USE_DRACO, GLTF_USE_MESHOPT)
  useGLTF.preload(assetUrl(`models/hpe-proliant-dl360-gen11.glb?v=${MODEL_VERSION}`), GLTF_USE_DRACO, GLTF_USE_MESHOPT)
  useGLTF.preload(assetUrl(`models/cisco-ucs-c240-m7.glb?v=${MODEL_VERSION}`), GLTF_USE_DRACO, GLTF_USE_MESHOPT)
}

function App() {
  const [showSplash, setShowSplash] = useState(true)
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const savedTheme = window.localStorage.getItem('rack3d-theme')
      return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark'
    } catch {
      return 'dark'
    }
  })
  const [session, setSession] = useState<SessionState>({ status: 'loading' })
  const [selectedDataCenter, setSelectedDataCenter] = useState<ZoneSummary | null>(null)
  const [focusedRackId, setFocusedRackId] = useState<string | null>(null)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [dashboardOpen, setDashboardOpen] = useState(false)
  const [incidentMode, setIncidentMode] = useState(false)
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>('normal')

  // ── netis-fms 세션·데이터 ─────────────────────────────────────────────────
  const sessionReady = session.status === 'ready'
  const selectedZoneId = selectedDataCenter?.id ?? null

  useEffect(() => {
    // StrictMode(dev)에서 두 번 실행되면 리프레시 토큰을 두 번 소비하게 되므로 1회로 묶는다.
    if (bootstrapStarted) return
    bootstrapStarted = true
    void bootstrapSession({
      onSessionExpired: () => setSession({ status: 'expired' }),
      onPasswordChangeRequired: () => setSession({ status: 'password-change' }),
    }).then((result) => {
      setSession(result.status === 'authenticated' ? { status: 'ready', me: result.me } : { status: result.status === 'password-change' ? 'password-change' : 'expired' })
    })
  }, [])

  const zoneFetcher = useMemo(
    () => (sessionReady ? async () => collectZones((await fetchSidebar()).roots) : null),
    [sessionReady],
  )
  const zonesResource = usePolledResource(zoneFetcher, ZONE_POLL_INTERVAL_MS)

  const rackFetcher = useMemo(
    () => (sessionReady && selectedZoneId !== null ? () => fetchZoneRacks(selectedZoneId) : null),
    [sessionReady, selectedZoneId],
  )
  const racksResource = usePolledResource(rackFetcher, RACK_POLL_INTERVAL_MS)
  const zoneRacks = racksResource.data

  /**
   * 랙 U 배치(구조) — **ZONE 진입 시 1회만** 받는다(`repeat: false`).
   *
   * 텔레메트리(위 `racksResource`, 30초)와 성격이 다르다: 랙 안 자산 구성은 **누가 FMS에서
   * 자산을 등록·이동·해체할 때만** 바뀌고, 관제 화면이 그걸 30초 안에 알아야 할 이유가 없다.
   * 그래서 자동 재수집 경로를 두지 않는다 — 주기 타이머도, 값 비교 트리거도 없다.
   *
   * ⚠️ **트레이드오프(의도된 선택이다)**: 화면을 며칠 켜두면 구조가 낡을 수 있다. 낡는 것은
   * "어떤 장비가 몇 번 U에 있나"뿐이고, 온습도·전력·경보·통신두절은 계속 최신이다.
   * 낡은 구조는 상단바 **"지금 새로고침"**이나 전산실을 나갔다 다시 들어오는 것으로 해소한다.
   * 자동 감지를 넣지 않은 것은 빠뜨린 게 아니라 정한 것이다.
   *
   * `UMAP_RETRY_INTERVAL_MS`는 **실패 재시도 간격**으로만 쓰인다(성공하면 더 안 받는다).
   */
  const uMapFetcher = useMemo(
    () => (sessionReady && selectedZoneId !== null ? () => fetchZoneUMaps(selectedZoneId) : null),
    [sessionReady, selectedZoneId],
  )
  const uMapResource = usePolledResource(uMapFetcher, UMAP_RETRY_INTERVAL_MS, { repeat: false })
  const uMaps = uMapResource.data

  /**
   * ZONE 3D 배치(E18) — u맵과 **같은 규약**이다: 구조 데이터라 ZONE 진입 시 1회만 받고
   * (`repeat: false`) 자동 재수집 경로를 두지 않는다. 갱신은 상단바 "지금 새로고침"이
   * 랙 목록·u맵과 **함께** 한다.
   *
   * ⚠️ 좌표의 SSOT가 여기로 옮겨졌다. 예전에는 `localStorage`에 저장하고 없으면 자동 배치로
   * 채웠는데, 그래서 **FMS 레이아웃 설정에서 랙을 옮겨도 3D가 안 바뀌었다**(E18 계기).
   */
  const layoutFetcher = useMemo(
    () => (sessionReady && selectedZoneId !== null ? () => fetchZoneLayout(selectedZoneId) : null),
    [sessionReady, selectedZoneId],
  )
  const layoutResource = usePolledResource(layoutFetcher, LAYOUT_RETRY_INTERVAL_MS, { repeat: false })
  const layout = layoutResource.data

  /** FMS 랙 목록(SSOT) + ZONE 배치 + ZONE u맵. 값이 안 바뀐 랙은 객체 신원을 유지한다. */
  const { grid, racks, objects: sceneObjects } = useZoneScene(zoneRacks, layout, uMaps)
  /**
   * 배치되지 않은 랙 — 3D에는 없지만 목록·검색·경보에는 있다. 수를 밝히지 않으면
   * "씬에 랙이 몇 대 빠져 있다"를 사용자가 알 방법이 없다.
   */
  const unplacedRacks = useMemo(() => racks.filter((rack) => rack.placement === null), [racks])
  /** 응답은 받았는데 그리드가 없다 = netis-fms 레이아웃 미설정(실측 8 ZONE 중 6개). */
  const layoutUnset = layout !== null && grid === null

  /** 3D 씬의 랙 경보 표시에 쓰는 FMS 판정 맵. */
  const rackSeverities = useMemo(() => {
    const severities = new Map<string, RackSeverity>()
    ;(zoneRacks ?? []).forEach((rack) => severities.set(rackElementId(rack.locationId), rack.severity))
    return severities
  }, [zoneRacks])

  /** ZONE 단위 집계(KPI·알림 수) — 전부 FMS 랙 목록에서 파생. */
  const zoneAggregate = useMemo(() => aggregateZoneRacks(zoneRacks), [zoneRacks])

  /** 랙 상세 패널이 쓰는 FMS 원본 집계(온도·습도·전력·판정). */
  const rackFactsById = useMemo(() => {
    const facts = new Map<string, RackSummary>()
    ;(zoneRacks ?? []).forEach((rack) => facts.set(rackElementId(rack.locationId), rack))
    return facts
  }, [zoneRacks])

  // 포커스는 id로만 들고 있는다 — 폴링으로 랙 목록이 갱신돼도 항상 최신 랙을 가리키고,
  // 랙이 사라지면 자동으로 해제된다.
  const focusedRack = useMemo(
    () => (focusedRackId ? racks.find((rack) => rack.id === focusedRackId) ?? null : null),
    [racks, focusedRackId],
  )
  /**
   * 선택한 장비도 **랙과 같은 규칙**으로 id에서 재조회한다.
   * 객체 스냅샷으로 들고 있으면, 상세를 열어 둔 채 u맵 스윕에서 그 자산이 삭제·이동됐을 때
   * 사라진 자산의 값을 계속 표시하고 카메라도 옛 `startU`로 맞춘다.
   */
  const selectedServer = useMemo(
    () => (focusedRack && selectedServerId
      ? focusedRack.servers.find((server) => server.id === selectedServerId) ?? null
      : null),
    [focusedRack, selectedServerId],
  )

  const heatmapDataset = useMemo(() => getHeatmapDataset(racks, heatmapMode, rackFactsById), [racks, heatmapMode, rackFactsById])
  const activeHeatmapMode = heatmapMode === 'normal' ? null : heatmapMode

  /** FMS 판정이 NORMAL이 아닌 랙 — 경보 탐색기·대시보드 표가 함께 쓴다(같은 소스여야 수가 안 갈린다). */
  const alertRacks = useMemo<RackAlertEntry[]>(() => {
    const entries: RackAlertEntry[] = []
    racks.forEach((rack) => {
      const facts = rackFactsById.get(rack.id)
      if (facts && facts.severity !== 'NORMAL') entries.push({ rack, facts })
    })
    const order: Record<RackSeverity, number> = { CRITICAL: 0, MAJOR: 1, CAUTION: 2, NORMAL: 3 }
    return entries.sort((a, b) => order[a.facts.severity] - order[b.facts.severity])
  }, [racks, rackFactsById])
  const activeIncidentIndex = focusedRackId
    ? alertRacks.findIndex(({ rack }) => rack.id === focusedRackId)
    : -1
  /**
   * 상단 데이터 피드 상태 — 랙 폴링의 실제 결과를 그대로 반영한다.
   * 값이 한 번도 안 들어왔거나 갱신이 실패 중이면 LIVE라고 말하지 않는다.
   */
  // 렌더 중 Date.now()를 읽지 않는다(react-hooks/purity) — 상태만으로 판정한다.
  // 응답이 늦게 오는 경우는 20초 타임아웃이 failure로 바꿔 주므로 여기서 시계를 볼 필요가 없다.
  const feedStatus = ((): { tone: 'live' | 'stale' | 'down'; label: string; detail: string } => {
    const at = racksResource.lastUpdatedAt
    const time = at ? at.toLocaleTimeString('ko-KR') : null
    if (racksResource.failure) {
      return {
        tone: 'down',
        label: '갱신 실패',
        detail: time ? `${racksResource.failure.message} · 마지막 갱신 ${time}` : racksResource.failure.message,
      }
    }
    if (!at) return { tone: 'stale', label: '연결 중', detail: 'netis-fms 응답 대기 중' }
    // 텔레메트리는 최신인데 구조(u맵)만 못 받은 경우도 LIVE라고 단언하지 않는다 —
    // 화면의 장비 목록·U 배치가 실제와 다를 수 있다는 사실은 알려야 한다.
    if (uMapResource.failure || layoutResource.failure) {
      const what = uMapResource.failure && layoutResource.failure
        ? '랙 U 배치와 3D 배치를'
        : uMapResource.failure ? '랙 U 배치를' : '3D 배치를'
      return { tone: 'stale', label: 'LIVE · 구조 미갱신', detail: `${what} 갱신하지 못했습니다 · 측정값 갱신 ${time}` }
    }
    return { tone: 'live', label: 'LIVE', detail: `마지막 갱신 ${time}` }
  })()

  /**
   * 수동 갱신 — **측정값과 구조를 함께** 다시 받는다.
   *
   * 구조(u맵·3D 배치)는 자동 재수집 경로가 없으므로(진입 시 1회), 이 버튼이 사용자가 구조를
   * 갱신할 수 있는 **유일한 수단**이다. 랙 목록만 새로 받으면 "FMS에서 랙을 옮겼는데 화면이
   * 그대로"가 된다 — 그게 정확히 E18을 시작하게 만든 증상이다.
   * 각 자원의 연타 쿨다운(5초)은 폴링 훅이 각각 강제한다.
   */
  const refreshFromFms = () => {
    racksResource.retryNow()
    uMapResource.retryNow()
    layoutResource.retryNow()
  }

  /** 상단바 "IN RACKS" — 랙 내 자산 합(가짜 0 방지 헬퍼 경유). */
  const topbarRackAssetCount = zoneAggregate
    ? displayRackAssetCount(zoneAggregate.rackAssetCount, zoneAggregate.mountedAssetCount)
    : null
  const focusedRackFacts = focusedRack ? rackFactsById.get(focusedRack.id) ?? null : null
  const focusedRackOccupancy = rackOccupancyPercent(focusedRackFacts)
  const focusedRackAvailable = rackAvailableUnits(focusedRackFacts)
  /**
   * 연속 빈 구간(U). **랙 크기를 모르면 null** — 42U를 가정하면 20U 랙에 "22U 여유"가 뜬다(C6).
   * u맵을 아직 못 받았어도 null이다("빈 랙"과 "모름"은 다르다).
   */
  const focusedRackFreeBlock = focusedRack && focusedRack.uMapKnown
    ? largestFreeBlock(focusedRack.servers, focusedRackFacts?.rackUnits ?? null)
    : null
  /**
   * u맵 응답을 한 번이라도 받았는가 — 배치 엔드포인트는 전량 성공/실패라, 랙 단위 "부분 실패"
   * 개념이 없어졌다. 대신 갈라야 할 것은 셋이다:
   * ① 아직 못 받음(로딩/실패) ② 받았는데 이 랙이 응답에 없음 ③ 받았고 갱신만 실패(옛값 표시).
   */
  const uMapReceived = uMaps !== null
  /** 랙 내 전체 자산 수(`categoryCounts` 합) — `assetCount`(U 배정분)와 정의가 다르다. */
  const focusedRackAssetCount = focusedRackFacts
    ? displayRackAssetCount(
        Object.values(focusedRackFacts.categoryCounts ?? {}).reduce((total, count) => total + count, 0),
        focusedRackFacts.assetCount,
      )
    : null
  const focusedRackUnmounted = focusedRackFacts
    ? unmountedAssetCount(focusedRackAssetCount, focusedRackFacts.assetCount)
    : null
  const focusedRackCategories = focusedRackFacts
    ? Object.entries(focusedRackFacts.categoryCounts ?? {}).sort((a, b) => b[1] - a[1])
    : []

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    try {
      window.localStorage.setItem('rack3d-theme', theme)
    } catch {
      // The selected theme still applies for this session when storage is unavailable.
    }
  }, [theme])

  const toggleTheme = () => setTheme((current) => current === 'dark' ? 'light' : 'dark')

  const handleSelectDataCenter = (zone: ZoneSummary) => {
    // 랙 목록은 폴링 훅이 FMS에서 가져온다 — 여기서는 선택만 바꾼다.
    setSelectedDataCenter(zone)
  }
  const clearFocus = () => {
    setFocusedRackId(null)
    setSelectedServerId(null)
    setIncidentMode(false)
  }
  const handleFocusRack = (rack: RackData) => {
    setFocusedRackId(rack.id)
    setSelectedServerId(null)
    setDashboardOpen(false)
    setIncidentMode(false)
  }
  const handleSelectServer = (rack: RackData, server: ServerData) => {
    setFocusedRackId(rack.id)
    setSelectedServerId(server.id)
    setDashboardOpen(false)
  }
  /** 경보 랙 탐색 — 대상은 FMS 판정이 정상이 아닌 랙이다. */
  const focusAlertRack = (index: number) => {
    if (alertRacks.length === 0) {
      setIncidentMode(false)
      return
    }
    const normalizedIndex = (index % alertRacks.length + alertRacks.length) % alertRacks.length
    setFocusedRackId(alertRacks[normalizedIndex].rack.id)
    setSelectedServerId(null)
    setDashboardOpen(false)
    setIncidentMode(true)
  }
  const toggleIncidentMode = () => {
    if (incidentMode) {
      setIncidentMode(false)
      return
    }
    focusAlertRack(activeIncidentIndex >= 0 ? activeIncidentIndex : 0)
  }

  if (showSplash) {
    return <SplashScreen onComplete={() => setShowSplash(false)} theme={theme} onToggleTheme={toggleTheme} />
  }

  if (session.status !== 'ready') {
    return <SessionNotice status={session.status} theme={theme} onToggleTheme={toggleTheme} />
  }

  if (!selectedDataCenter) {
    return (
      <DataCenterLobby
        zones={zonesResource.data}
        loading={zonesResource.loading}
        failure={zonesResource.failure?.message ?? null}
        onRetry={zonesResource.retryNow}
        onSelect={handleSelectDataCenter}
        userName={session.me.name}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <button
          className="back-button"
          type="button"
          onClick={() => { clearFocus(); setDashboardOpen(false); setHeatmapMode('normal'); setSelectedDataCenter(null) }}
          aria-label="전산실 목록으로 돌아가기"
        >
          <span aria-hidden="true">←</span>
        </button>
        <div className="scene-heading">
          <p className="eyebrow">BURUNET INFRASTRUCTURE</p>
          <h1>{selectedDataCenter.name}</h1>
          <span>{selectedDataCenter.code ?? NO_VALUE} · 3D RACK VISUALIZATION</span>
        </div>
        <AssetSearch rackData={racks} rackFacts={rackFactsById} onSelectRack={handleFocusRack} onSelectServer={handleSelectServer} />
        {/*
          ⚠️ 여기 있던 **LAYOUT EDIT 버튼(2D 배치 에디터 진입)은 제거했다**(E18 ①).
          3D 좌표는 netis-fms 레이아웃 설정이 SSOT이고 rack3d는 읽기 전용이다 —
          편집 지점이 두 곳이면 어느 쪽이 정답인지 흐려진다. `src/LayoutEditor.tsx`도 함께 삭제했다.
        */}
        {/*
          구조(u맵)는 진입 시 1회만 받으므로 **상시 노출되는 갱신 수단이 필요하다.**
          예전에는 실패 화면 안에만 재시도 버튼이 있어, 정상 상태에서 자산 배치가 바뀌면
          페이지를 새로 여는 것 말고 방법이 없었다.
        */}
        <RetryButton
          className="theme-toggle refresh-button"
          onRetry={refreshFromFms}
          busy={racksResource.loading || uMapResource.loading}
          kicker="NETIS-FMS"
          icon={(
            <svg viewBox="0 0 24 24">
              <path d="M20 12a8 8 0 1 1-2.34-5.66" />
              <path d="M20 4v5h-5" />
            </svg>
          )}
        >
          지금 새로고침
        </RetryButton>
        <ThemeToggle theme={theme} onToggle={toggleTheme} className="rack-theme-toggle" />
        <div className="summary">
          {/* 랙 수도 미수신 상태에서는 0을 단언하지 않는다 — 옆 칸과 같은 규칙(C6). */}
          <span><strong>{zoneRacks ? racks.length : NO_VALUE}</strong> RACKS</span>
          {/*
            자산 수 두 개는 정의가 다르다(§11-11 Q1) — 라벨을 나눠 함께 띄운다.
            ASSETS = 랙 내 활성 자산 전체(categoryCounts 합), MOUNTED = U가 배정된 자산(assetCount 합).
            하나만 띄우면 랙 상세의 수와 어긋난 이유를 사용자가 알 수 없다.
          */}
          <span title="랙 내 활성 자산 전체 (U 미배정 문짝 센서·PDU 포함). 랙 밖에 놓인 CRAC·UPS 등은 여기 없다 — 로비의 ZONE ASSETS가 그쪽까지 포함한 수다">
            <strong>{topbarRackAssetCount ?? NO_VALUE}</strong> IN RACKS
          </span>
          <span title="U가 배정되어 랙에 장착된 자산">
            <strong>{zoneAggregate ? zoneAggregate.mountedAssetCount : NO_VALUE}</strong> MOUNTED
          </span>
          {/*
            N-3: 예전엔 하드코딩 'LIVE'라 타임아웃·429 정지·권한없음 상태에서도 초록불이 켜져 있었다.
            "가짜 정상"은 가짜 0과 같은 계열의 사고다(C6) — 실제 폴링 상태에 묶는다.
          */}
          <span className={`live ${feedStatus.tone}`} title={feedStatus.detail}>
            <i /> {feedStatus.label}
          </span>
        </div>
      </header>

      <section className="viewport-wrap">
        <div
          id="viewport"
          className="viewport"
          title="마우스로 시점을 조작할 수 있습니다"
          onPointerDownCapture={(event) => {
            if (event.button !== 2 || !focusedRack) return
            event.preventDefault()
            event.stopPropagation()
            clearFocus()
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <Canvas
            shadows
            camera={{ position: [5.4, 2.2, 9.5], fov: 62, near: 0.05, far: 80 }}
            dpr={[1, 1.7]}
            gl={{ antialias: true, alpha: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.18 }}
            onPointerMissed={clearFocus}
          >
            <DataCenterScene
              grid={grid}
              racks={racks}
              objects={sceneObjects}
              focusedRack={focusedRack}
              selectedServer={selectedServer}
              heatmapVisuals={heatmapDataset.visuals}
              rackSeverities={rackSeverities}
              theme={theme}
              onFocusRack={handleFocusRack}
              onSelectServer={handleSelectServer}
            />
          </Canvas>
          <div className="crosshair" aria-hidden="true" />

          {/*
            랙 목록의 로딩·권한·실패 상태를 씬 위에 명시한다.
            FMS는 위치 스코프 밖 요청을 엔드포인트마다 다르게 돌려준다(racks는 404,
            overview는 200 + 빈 집계). 두 경우 모두 "권한 없음"으로 수렴시켜야
            빈 씬을 "랙이 0대인 정상 상태"로 오인하지 않는다(R7).
          */}
          {racksResource.loading && !zoneRacks ? (
            <p className="scene-state" role="status">랙 목록을 불러오는 중…</p>
          ) : racksResource.failure ? (
            <div className={`scene-state ${racksResource.failure.kind}`} role="alert">
              <span>{racksResource.failure.message}</span>
              {/*
                백오프가 길게 잡히면(프록시가 큰 Retry-After를 흘리는 등) 자동 갱신만으로는
                화면이 오래 멈춘다. 다음 예정 시각을 밝히고 **즉시 재시도 수단**을 준다 —
                F5 말고는 복구할 방법이 없는 상태를 만들지 않는다.
              */}
              {racksResource.nextAttemptAt && (
                <small>다음 자동 갱신 {racksResource.nextAttemptAt.toLocaleTimeString('ko-KR')}</small>
              )}
              <RetryButton onRetry={refreshFromFms} busy={racksResource.loading}>
                지금 새로고침
              </RetryButton>
            </div>
          ) : !layout && layoutResource.failure ? (
            /* 배치를 한 번도 못 받았다 — 좌표가 없으므로 씬이 비어 있는 이유를 밝힌다. */
            <div className={`scene-state ${layoutResource.failure.kind}`} role="alert">
              <span>3D 배치를 불러오지 못했습니다. {layoutResource.failure.message}</span>
              {layoutResource.nextAttemptAt && (
                <small>다음 자동 갱신 {layoutResource.nextAttemptAt.toLocaleTimeString('ko-KR')}</small>
              )}
              <RetryButton onRetry={refreshFromFms} busy={layoutResource.loading}>
                지금 새로고침
              </RetryButton>
            </div>
          ) : !layout ? (
            <p className="scene-state" role="status">3D 배치를 불러오는 중…</p>
          ) : layoutUnset ? (
            /*
              **자동 배치로 채우지 않는다**(E18 ⑤ 확정). 실측 8개 ZONE 중 6개가 미설정이라
              임의 배치를 보여주면 "표시를 붙여도 실제 배치로 오인"되는 화면이 6개 생긴다 —
              가짜 온도 그래프를 걷어낸 것과 같은 이유다.
            */
            <div className="scene-state layout-unset" role="status">
              <strong>3D 배치가 설정되지 않았습니다</strong>
              <span>netis-fms 환경설정 &gt; 레이아웃 설정에서 이 전산실의 배치를 지정하세요.</span>
              <small>배치를 지정한 뒤 상단 "지금 새로고침"을 누르면 반영됩니다.</small>
            </div>
          ) : zoneRacks && zoneRacks.length === 0 && sceneObjects.length === 0 ? (
            <p className="scene-state" role="status">이 전산실에 등록된 랙이 없습니다.</p>
          ) : unplacedRacks.length > 0 ? (
            /*
              배치되지 않은 랙은 좌표가 없어 3D에 그릴 수 없다. **조용히 빼면 안 된다** —
              경보 중인 랙이 씬에서 사라진 것을 사용자가 알 방법이 없어진다.
            */
            <div className="scene-state layout-unset" role="status">
              <strong>랙 {unplacedRacks.length}대가 3D 배치에 없습니다</strong>
              <span>
                {unplacedRacks.slice(0, 4).map((rack) => rack.label).join(' · ')}
                {unplacedRacks.length > 4 ? ` 외 ${unplacedRacks.length - 4}대` : ''}
              </span>
              <small>netis-fms 레이아웃 설정에서 배치하면 3D에 표시됩니다. 목록·검색·경보에는 그대로 있습니다.</small>
            </div>
          ) : null}
        </div>

        <IncidentNavigator
          active={incidentMode}
          hidden={dashboardOpen}
          alerts={alertRacks}
          unavailable={zoneRacks === null}
          currentIndex={activeIncidentIndex}
          onToggle={toggleIncidentMode}
          onPrevious={() => focusAlertRack((activeIncidentIndex >= 0 ? activeIncidentIndex : 0) - 1)}
          onNext={() => focusAlertRack((activeIncidentIndex >= 0 ? activeIncidentIndex : -1) + 1)}
        />

        <HeatmapControl
          mode={heatmapMode}
          dataset={heatmapDataset}
          hidden={dashboardOpen}
          onChange={setHeatmapMode}
        />

        <aside
          key={selectedServer?.id ?? focusedRack?.id ?? 'navigation'}
          className={focusedRack ? `controls-panel detail${selectedServer ? ' server-detail-panel' : ''}` : 'controls-panel'}
        >
          {focusedRack && selectedServer ? (
            <ServerDetailPanel
              rack={focusedRack}
              server={selectedServer}
              onBackToRack={() => setSelectedServerId(null)}
              onOverview={clearFocus}
            />
          ) : focusedRack ? (
            <>
              <p className="panel-title">RACK DETAIL</p>
              <div className="rack-focus-heading">
                <strong className="rack-focus-name">RACK {focusedRack.label}</strong>
                {/* 판정은 FMS 원값(severity)이 SSOT다. 로컬 서버 상태는 u맵 미연동이라 항상 0이었다. */}
                <span className={focusedRackFacts && focusedRackFacts.severity !== 'NORMAL' ? 'rack-state attention' : 'rack-state healthy'}>
                  <i /> {focusedRackFacts
                    ? (focusedRackFacts.severity === 'NORMAL' ? 'HEALTHY' : severityLabel(focusedRackFacts.severity))
                    : NO_VALUE}
                </span>
              </div>
              <span className="rack-focus-meta">
                {focusedRack.placement
                  ? `FRONT · ${focusedRack.placement.dir} · X ${focusedRack.placement.tileX} / Z ${focusedRack.placement.tileZ}`
                  : 'FRONT · LEVEL VIEW'}
              </span>
              {/*
                배치가 없으면 3D에 랙이 없다. 패널만 열려 있고 씬에는 아무것도 없는 상태를
                설명 없이 두면 "랙이 사라졌다"로 읽힌다 — 사실(FMS 배치도에 없음)만 밝힌다.
              */}
              {!focusedRack.placement && (
                <p className="rack-source-note warn">
                  ⚠ netis-fms 3D 배치에 이 랙이 없어 씬에 표시되지 않습니다. 레이아웃 설정에서 배치하세요.
                </p>
              )}

              {/*
                **점유·여유 U는 FMS 집계(RackSummary)에서만 파생한다.** 같은 수치를 u맵에서
                다시 세면 두 소스가 갈릴 때 한 화면에 다른 숫자가 뜬다. u맵은 FMS 집계로 낼 수
                없는 것(연속 빈 구간·U별 배치)에만 쓴다.
                크기(rackUnits) 미설정이면 분모가 없으므로 지어내지 않고 `—`로 둔다(C6).
              */}
              <section className="rack-capacity">
                <div className="rack-section-heading">
                  <span>CAPACITY</span>
                  <strong>
                    {focusedRackFacts ? focusedRackFacts.occupiedUnits : NO_VALUE}
                    {' / '}{focusedRackFacts?.rackUnits ?? NO_VALUE}<small> U USED</small>
                  </strong>
                </div>
                {focusedRackOccupancy === null ? (
                  <p className="rack-source-note">netis-fms에 랙 크기(U)가 설정되어 있지 않아 점유율을 낼 수 없습니다.</p>
                ) : (
                  <>
                    <div className="capacity-track">
                      <span style={{ width: `${focusedRackOccupancy}%` }} />
                    </div>
                    <div className="capacity-scale">
                      <span>U01</span>
                      <strong>{focusedRackOccupancy.toFixed(1)}%</strong>
                      <span>U{focusedRackFacts?.rackUnits ?? NO_VALUE}</span>
                    </div>
                  </>
                )}
              </section>

              {/*
                ⚠️ **자산 수 두 개는 정의가 다르다**(§11-11 Q1, FMS 확정):
                - MOUNTED = `RackSummary.assetCount` = U가 배정된 활성 자산(= u맵 목록과 같은 모집단)
                - IN RACK = `categoryCounts` 합 = 랙 내 활성 자산 전체(문짝 온습도센서·PDU 등 U 미배정 포함)
                둘 중 하나만 "ASSETS"로 띄우면 다른 화면의 수와 어긋난 이유를 알 수 없다 —
                라벨을 나누고 아래 캡션에서 차이를 밝힌다.
              */}
              <div className="rack-stat-grid">
                <div title="U가 배정되어 랙에 장착된 자산 수 (netis-fms assetCount)">
                  <span>MOUNTED</span>
                  <strong>{focusedRackFacts ? focusedRackFacts.assetCount : NO_VALUE}<small> 대</small></strong>
                </div>
                <div title="U 미배정(문짝 센서·PDU 등)을 포함한 랙 내 활성 자산 전체 (netis-fms categoryCounts)">
                  <span>IN RACK</span>
                  <strong>{focusedRackAssetCount ?? NO_VALUE}<small> 대</small></strong>
                </div>
                <div>
                  <span>OCCUPIED</span>
                  <strong>{focusedRackFacts ? focusedRackFacts.occupiedUnits : NO_VALUE}<small> U</small></strong>
                </div>
                <div>
                  <span>AVAILABLE</span>
                  <strong>{focusedRackAvailable ?? NO_VALUE}<small> U</small></strong>
                </div>
                <div>
                  <span>RACK SIZE</span>
                  <strong>{focusedRackFacts?.rackUnits ?? NO_VALUE}<small> U</small></strong>
                </div>
                <div>
                  {/* 연속 빈 구간은 U별 배치(u맵) + 랙 크기를 둘 다 알아야 계산된다. */}
                  <span>MAX BLOCK</span>
                  <strong>{focusedRackFreeBlock ?? NO_VALUE}<small> U</small></strong>
                </div>
              </div>
              <p className="rack-source-note">
                MOUNTED는 U가 배정된 자산 수, IN RACK은 U 미배정(문짝 센서·PDU 등)까지 포함한
                랙 내 활성 자산 전체입니다 — 두 수가 다를 수 있습니다.
                {focusedRackUnmounted !== null ? ` 이 랙은 U 미배정 자산 ${focusedRackUnmounted}대가 있습니다.` : ''}
              </p>

              {/*
                netis-fms 랙 집계(E19 B1). 랙에 TH/DPM 센서가 없으면 값이 null로 온다 —
                **0으로 치환하지 않고 `—`로 표시한다.** 관제 화면에서 가짜 0은 사고다(C6).
              */}
              <section className="rack-environment">
                <p className="rack-subtitle">ENVIRONMENT · NETIS-FMS</p>
                <div className="rack-stat-grid">
                  <div>
                    <span>TEMP</span>
                    <strong>
                      {focusedRackFacts?.temp != null ? focusedRackFacts.temp.toFixed(1) : NO_VALUE}
                      <small> °C</small>
                    </strong>
                  </div>
                  <div>
                    <span>HUMIDITY</span>
                    <strong>
                      {focusedRackFacts?.humidity != null ? focusedRackFacts.humidity.toFixed(1) : NO_VALUE}
                      <small> %</small>
                    </strong>
                  </div>
                  <div>
                    <span>POWER</span>
                    <strong>
                      {focusedRackFacts?.powerKw != null ? focusedRackFacts.powerKw.toFixed(2) : NO_VALUE}
                      <small> kW</small>
                    </strong>
                  </div>
                  <div className={focusedRackFacts && focusedRackFacts.severity !== 'NORMAL' ? 'alert' : ''}>
                    <span>SEVERITY</span>
                    <strong>{focusedRackFacts ? severityLabel(focusedRackFacts.severity) : NO_VALUE}</strong>
                  </div>
                </div>
                <p className="rack-source-note">
                  {focusedRackFacts?.collectedAt
                    ? `수신 ${new Date(focusedRackFacts.collectedAt).toLocaleString('ko-KR')}`
                    : '수신 시각 없음'}
                  {focusedRackFacts?.stale ? ' · 통신두절 센서 있음' : ''}
                </p>
              </section>

              {/*
                랙 내 자산 구성 — `categoryCounts` 실값(랙 내 전체 자산 기준).
                예전 이 자리에는 장비 상태 4분류(healthy/warning/critical/offline) 집계가 있었는데
                그 값은 시드 데이터였고 netis-fms에 대체 소스가 없다(A6 = b) — 되살리지 않는다.
              */}
              <section className="rack-health">
                <p className="rack-subtitle">RACK CONTENTS · 카테고리</p>
                {focusedRackCategories.length > 0 ? (
                  <div className="rack-health-grid">
                    {focusedRackCategories.map(([category, count]) => (
                      <span key={category}>
                        <i style={{ background: '#4acdf8', boxShadow: '0 0 8px #4acdf8' }} />
                        {category}<strong>{count}</strong>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="rack-source-note">
                    {focusedRackFacts ? '이 랙에 등록된 활성 자산이 없습니다.' : '랙 집계를 기다리는 중입니다.'}
                  </p>
                )}
                <p className="rack-source-note">
                  장비 단위 상태(정상·경고·장애)는 netis-fms가 수집하지 않습니다(IT 장비 텔레메트리 미도입).
                </p>
              </section>

              <section className="rack-equipment">
                <p className="rack-subtitle">INSTALLED EQUIPMENT</p>
                {/*
                  u맵을 아직 못 받은 랙은 **"0대"가 아니라 "모름"** 이다(C6) —
                  `uMapKnown`으로 구분한다. 빈 목록을 장비 없음으로 표시하면 가짜 0과 같다.
                */}
                {/*
                  받아 둔 값이 있는데 갱신이 실패한 경우 — **옛 목록을 지우지 않되 낡았다고 밝힌다.**
                  관제 화면에서 목록이 통째로 사라지는 편이 더 나쁘고(3D 씬의 장비도 함께 사라진다),
                  가짜 0도 아니다. 다만 실패를 숨긴 채 옛값을 보여주는 것은 별개의 문제라 표시한다.
                */}
                {focusedRack.uMapKnown && uMapResource.failure && (
                  <p className="rack-source-note warn">
                    ⚠ 갱신 실패 — 아래는 마지막으로 받은 U 배치입니다.
                    {uMapResource.lastUpdatedAt
                      ? ` (수신 ${uMapResource.lastUpdatedAt.toLocaleTimeString('ko-KR')})`
                      : ''}
                  </p>
                )}
                {!focusedRack.uMapKnown ? (
                  <p className="rack-source-note">
                    {!uMapReceived
                      ? (uMapResource.failure
                          ? '랙 U 배치를 불러오지 못했습니다. 상단 "지금 새로고침"으로 다시 시도하세요.'
                          : '랙 U 배치를 불러오는 중입니다…')
                      /*
                        응답은 왔는데 이 랙이 그 응답에 없다. u맵은 진입 시 1회만 받고 랙 목록은
                        30초마다 갱신되므로, **진입 후 netis-fms에 새로 등록된 랙**이면 정상적으로
                        여기 온다 — 우리가 그 뒤로 다시 묻지 않았을 뿐이다. FMS 이상으로 단정하지
                        않는다(모르는 원인을 아는 척하지 않는다). "장비 0대"로도 단정하지 않는다(C6).
                      */
                      : '이 랙의 U 배치를 아직 받지 못했습니다(진입 후 추가된 랙일 수 있습니다). 상단 "지금 새로고침"으로 다시 받아보세요.'}
                  </p>
                ) : focusedRack.servers.length === 0 ? (
                  <p className="rack-source-note">
                    U가 배정된 장비가 없습니다.
                    {focusedRackUnmounted !== null
                      ? ` (U 미배정 자산 ${focusedRackUnmounted}대는 위 RACK CONTENTS에 있습니다.)`
                      : ''}
                  </p>
                ) : (
                  <div className="equipment-list">
                    {focusedRack.servers.map((server) => (
                      <button
                        className="equipment-item"
                        key={server.id}
                        type="button"
                        onClick={() => handleSelectServer(focusedRack, server)}
                        aria-label={`${server.name} 상세 보기`}
                      >
                        <span className="equipment-unit">{formatUnitRange(server)}</span>
                        <span className="equipment-copy">
                          {/* 표시 문구는 전부 FMS 원값이다. 없는 제조사·모델명을 지어내지 않는다. */}
                          <strong>{server.name}</strong>
                          <small>{[server.manufacturer, server.modelName].filter(Boolean).join(' ') || NO_VALUE}</small>
                        </span>
                        <span className="equipment-status" title={`${server.units}U · ${server.assetCode}`}>
                          {server.units}U
                        </span>
                        <span className="equipment-open" aria-hidden="true">›</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {/*
                U 배치도는 **랙 크기(rackUnits)를 알 때만** 그린다.
                미설정 랙에서 지오메트리용 폴백 42U로 그리면 "1U–42U RACK MAP"이 지어낸 값이 된다(C6).
              */}
              {focusedRack.uMapKnown && focusedRackFacts?.rackUnits
                ? (
                  <RackUnitMap
                    rack={focusedRack}
                    rackUnits={focusedRackFacts.rackUnits}
                    onSelectServer={(server) => handleSelectServer(focusedRack, server)}
                  />
                )
                : focusedRack.uMapKnown && (
                  <section className="rack-health">
                    <p className="rack-subtitle">U MAP</p>
                    <p className="rack-source-note">
                      netis-fms에 랙 크기(U)가 설정되어 있지 않아 U 배치도를 그리지 않습니다.
                    </p>
                  </section>
                )}

              <button className="overview-button" type="button" onClick={clearFocus}>
                <span aria-hidden="true">←</span> 전체 보기
              </button>
              <div className="mouse-tip">다른 랙 클릭: 정면 이동 · 오른쪽 클릭: 전체 보기</div>
            </>
          ) : (
            <>
              <p className="panel-title">NAVIGATION</p>
              <div className="key-row"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>이동</span></div>
              <div className="key-row"><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd><span>이동</span></div>
              <div className="key-row"><kbd>Q</kbd><kbd>E</kbd><span>하강 / 상승</span></div>
              <div className="key-row"><kbd>⇧</kbd><span>빠른 이동</span></div>
              <div className="mouse-tip"><span className="mouse-icon" /> 드래그: 회전 · 우클릭: 이동 · 휠: 줌</div>
            </>
          )}
        </aside>

        {activeHeatmapMode ? (
          <div
            className={`legend heatmap-legend${dashboardOpen ? ' dashboard-open' : ''}`}
            role="img"
            aria-label={`${heatmapModeMeta[activeHeatmapMode].label} 히트맵 범례, ${formatHeatmapValue(activeHeatmapMode, heatmapDataset.min)} 낮음부터 ${formatHeatmapValue(activeHeatmapMode, heatmapDataset.max)} 높음`}
            aria-hidden={dashboardOpen}
          >
            <span className="heatmap-legend-title"><strong>{heatmapModeMeta[activeHeatmapMode].shortLabel}</strong><small>LOW → HIGH</small></span>
            <span className="heatmap-legend-scale">
              <b aria-hidden="true" />
              <small><em>{formatHeatmapValue(activeHeatmapMode, heatmapDataset.min)}</em><em>{formatHeatmapValue(activeHeatmapMode, heatmapDataset.max)}</em></small>
            </span>
          </div>
        ) : (
          <div className={`legend${dashboardOpen ? ' dashboard-open' : ''}`} aria-hidden={dashboardOpen}>
            {/*
              범례의 소스는 FMS 랙 판정(severity)이다. 예전 장비 상태 4분류는 시드 값이었다.
              등급 3단계 → 화면 2톤 매핑은 E19 C1 합의를 따른다(MAJOR·CAUTION → WARNING).
            */}
            {(['normal', 'warning', 'critical'] as SeverityTone[]).map((tone) => (
              <span key={tone}>
                <i style={{ background: severityToneColors[tone], boxShadow: `0 0 10px ${severityToneColors[tone]}` }} />
                {tone === 'normal' ? '정상' : tone === 'warning' ? '주의·경고' : '심각'}
              </span>
            ))}
          </div>
        )}

        <DataCenterDashboard
          open={dashboardOpen}
          onToggle={() => setDashboardOpen((current) => !current)}
          onSelectAlertRack={handleFocusRack}
          dataCenter={selectedDataCenter}
          zone={zoneAggregate}
          rackFacts={rackFactsById}
          lastUpdatedAt={racksResource.lastUpdatedAt}
          racks={racks}
          alertRacks={alertRacks}
          activeAlertRackId={focusedRackId}
        />
      </section>
    </main>
  )
}

export default App
