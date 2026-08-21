import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, Html, Lightformer, OrbitControls, useCursor, useGLTF } from '@react-three/drei'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import * as THREE from 'three'
import type { Group } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import LayoutEditor from './LayoutEditor'
import { buildRacksFromZone, loadRackPlacements, rackElementId } from './rackLayouts'
import type { RackPlacement } from './rackLayouts'
import type { RackData, ServerData, ServerModel, ServerStatus } from './rackLayouts'
import { collectZones, fetchSidebar, fetchZoneRacks, type ZoneSummary } from './api/fms'
import type { MeResponse, RackSummary, RackSeverity } from './api/types'
import { bootstrapSession, goToFmsLogin, goToFmsPasswordChange } from './api/session'
import { MANUAL_RETRY_COOLDOWN_MS, usePolledResource } from './hooks/usePolledResource'
import {
  NO_VALUE,
  aggregateZoneRacks,
  formatHeatmapValue,
  getHeatmapDataset,
  heatmapModeMeta,
  heatmapModes,
  rackAvailableUnits,
  rackOccupancyPercent,
} from './rackFigures'
import type { HeatmapDataset, HeatmapMode, RackHeatmapVisual, ZoneAggregate } from './rackFigures'
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


const TILE_SIZE = 0.6
const UNIT_HEIGHT = 0.04445
const RACK_INNER_BOTTOM = 0.06655
const MODEL_VERSION = '11'
const SPLASH_DURATION = 3600
const RACK_FOCUS_HEIGHT = 1.06
const RACK_FOCUS_DISTANCE = 1.15
const OVERVIEW_CAMERA_POSITION = new THREE.Vector3(5.4, 2.2, 9.5)
const OVERVIEW_CAMERA_TARGET = new THREE.Vector3(3.3, 0.9, 4.2)

echarts.use([LineChart, AriaComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

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

const statusColors: Record<ServerStatus, string> = {
  healthy: '#21e878', warning: '#ffc247', critical: '#ff3c56', offline: '#566174',
}

const serverModelLabels: Record<ServerModel, string> = {
  'dell-poweredge-r760': 'Dell PowerEdge R760',
  'hpe-proliant-dl360-gen11': 'HPE ProLiant DL360 Gen11',
  'cisco-ucs-c240-m7': 'Cisco UCS C240 M7',
}

type ServerActivityTone = 'normal' | 'warning' | 'critical'

type ServerProfile = {
  role: string
  serialNumber: string
  ipAddress: string
  operatingSystem: string
  cpuPercent: number
  memoryPercent: number
  storagePercent: number
  temperatureCelsius: number
  powerWatts: number
  networkMbps: number
  uptime: string
  lastSync: string
  activities: { time: string; message: string; tone: ServerActivityTone }[]
}

type IncidentRecord = {
  detectedAt: string
  duration: string
  acknowledged: boolean
  assignee: string
  note: string
}


const serverProfiles: Record<string, ServerProfile> = {
  'srv-001': {
    role: 'Core API Gateway', serialNumber: 'HPE-SN-7A31K2', ipAddress: '10.24.11.21', operatingSystem: 'Ubuntu Server 24.04 LTS',
    cpuPercent: 42, memoryPercent: 61, storagePercent: 48, temperatureCelsius: 39, powerWatts: 182, networkMbps: 684, uptime: '128d 07h', lastSync: '12 sec ago',
    activities: [{ time: '10:42', message: 'Health check completed', tone: 'normal' }, { time: '08:15', message: 'Security patches verified', tone: 'normal' }],
  },
  'srv-002': {
    role: 'Primary Database', serialNumber: 'DLL-SN-93R7M8', ipAddress: '10.24.11.31', operatingSystem: 'Rocky Linux 9.4',
    cpuPercent: 58, memoryPercent: 74, storagePercent: 67, temperatureCelsius: 43, powerWatts: 421, networkMbps: 426, uptime: '214d 19h', lastSync: '9 sec ago',
    activities: [{ time: '11:02', message: 'Replication lag 18 ms', tone: 'normal' }, { time: '06:30', message: 'Daily backup completed', tone: 'normal' }],
  },
  'srv-004': {
    role: 'Web Frontend', serialNumber: 'HPE-SN-4F82P1', ipAddress: '10.24.12.41', operatingSystem: 'Ubuntu Server 22.04 LTS',
    cpuPercent: 28, memoryPercent: 46, storagePercent: 39, temperatureCelsius: 36, powerWatts: 146, networkMbps: 812, uptime: '83d 04h', lastSync: '11 sec ago',
    activities: [{ time: '10:58', message: 'Load balancer probe passed', tone: 'normal' }, { time: '09:21', message: 'Application deployment completed', tone: 'normal' }],
  },
  'srv-005': {
    role: 'Web Frontend', serialNumber: 'HPE-SN-4F82P2', ipAddress: '10.24.12.42', operatingSystem: 'Ubuntu Server 22.04 LTS',
    cpuPercent: 96, memoryPercent: 88, storagePercent: 72, temperatureCelsius: 72, powerWatts: 238, networkMbps: 1260, uptime: '2h 14m', lastSync: '4 sec ago',
    activities: [{ time: '11:14', message: 'CPU temperature exceeded threshold', tone: 'critical' }, { time: '11:12', message: 'Application health check failed', tone: 'warning' }],
  },
  'srv-006': {
    role: 'Compute Worker', serialNumber: 'DLL-SN-62W9C4', ipAddress: '10.24.12.61', operatingSystem: 'Ubuntu Server 24.04 LTS',
    cpuPercent: 71, memoryPercent: 68, storagePercent: 52, temperatureCelsius: 51, powerWatts: 468, networkMbps: 536, uptime: '46d 12h', lastSync: '15 sec ago',
    activities: [{ time: '10:50', message: 'Batch workload completed', tone: 'normal' }, { time: '07:40', message: 'Container image synchronized', tone: 'normal' }],
  },
  'srv-007': {
    role: 'Backup Repository', serialNumber: 'CSC-SN-2Q18B7', ipAddress: '10.24.21.71', operatingSystem: 'VMware ESXi 8.0 U3',
    cpuPercent: 0, memoryPercent: 0, storagePercent: 81, temperatureCelsius: 24, powerWatts: 0, networkMbps: 0, uptime: 'OFFLINE · 18m', lastSync: '18 min ago',
    activities: [{ time: '10:56', message: 'Management connection lost', tone: 'critical' }, { time: '10:55', message: 'Power feed telemetry unavailable', tone: 'warning' }],
  },
  'srv-008': {
    role: 'Monitoring Collector', serialNumber: 'HPE-SN-8M44D6', ipAddress: '10.24.21.81', operatingSystem: 'Debian 12',
    cpuPercent: 34, memoryPercent: 53, storagePercent: 44, temperatureCelsius: 37, powerWatts: 158, networkMbps: 278, uptime: '167d 02h', lastSync: '6 sec ago',
    activities: [{ time: '11:10', message: 'Metrics batch ingested', tone: 'normal' }, { time: '10:00', message: 'Alert rules synchronized', tone: 'normal' }],
  },
  'srv-009': {
    role: 'GPU Compute Worker', serialNumber: 'DLL-SN-77G2X9', ipAddress: '10.24.22.91', operatingSystem: 'Ubuntu Server 22.04 · CUDA 12.5',
    cpuPercent: 88, memoryPercent: 82, storagePercent: 63, temperatureCelsius: 68, powerWatts: 612, networkMbps: 940, uptime: '31d 09h', lastSync: '7 sec ago',
    activities: [{ time: '11:08', message: 'GPU temperature approaching limit', tone: 'warning' }, { time: '10:44', message: 'Training workload started', tone: 'normal' }],
  },
  'srv-010': {
    role: 'Network Services', serialNumber: 'HPE-SN-5N61T3', ipAddress: '10.24.22.10', operatingSystem: 'Rocky Linux 9.4',
    cpuPercent: 19, memoryPercent: 41, storagePercent: 33, temperatureCelsius: 35, powerWatts: 139, networkMbps: 142, uptime: '302d 17h', lastSync: '10 sec ago',
    activities: [{ time: '11:00', message: 'Routing table verified', tone: 'normal' }, { time: '09:30', message: 'DNS cache refreshed', tone: 'normal' }],
  },
  'srv-011': {
    role: 'Object Storage', serialNumber: 'CSC-SN-9C53L8', ipAddress: '10.24.22.111', operatingSystem: 'Red Hat Enterprise Linux 9.4',
    cpuPercent: 47, memoryPercent: 66, storagePercent: 78, temperatureCelsius: 45, powerWatts: 386, networkMbps: 615, uptime: '96d 21h', lastSync: '13 sec ago',
    activities: [{ time: '10:48', message: 'Storage scrub completed', tone: 'normal' }, { time: '05:15', message: 'Capacity report generated', tone: 'normal' }],
  },
}

const initialIncidentRecords: Record<string, IncidentRecord> = {
  'srv-005': {
    detectedAt: '11:12', duration: '18m', acknowledged: false, assignee: 'UNASSIGNED',
    note: 'CPU 온도 임계치 초과. 애플리케이션 상태 점검이 필요합니다.',
  },
  'srv-007': {
    detectedAt: '10:56', duration: '18m', acknowledged: true, assignee: 'NOC L1',
    note: '관리 네트워크 연결과 전원 텔레메트리를 확인 중입니다.',
  },
  'srv-009': {
    detectedAt: '11:08', duration: '22m', acknowledged: true, assignee: 'PLATFORM',
    note: 'GPU 온도 상승 추세를 관찰하고 워크로드 분산을 검토합니다.',
  },
}

type RackMetrics = {
  usedUnits: number
  availableUnits: number
  occupancyPercent: number
  largestFreeBlock: number
  alertCount: number
  statusCounts: Record<ServerStatus, number>
  orderedServers: ServerData[]
}

type DashboardRackMetric = {
  rack: RackData
  metrics: RackMetrics
}

type DashboardAlert = {
  rack: RackData
  server: ServerData
  type: string
}

type DashboardMetrics = {
  totalServers: number
  totalUnits: number
  usedUnits: number
  availableUnits: number
  occupancyPercent: number
  alertCount: number
  healthyPercent: number
  statusCounts: Record<ServerStatus, number>
  modelCounts: Record<ServerModel, number>
  rackMetrics: DashboardRackMetric[]
  alerts: DashboardAlert[]
}

type TemperatureHistoryPoint = {
  time: string
  roomAverageCelsius: number
  rackCelsius: Record<string, number>
}

function getRackMetrics(rack: RackData): RackMetrics {
  const occupied = Array.from({ length: rack.totalUnits }, () => false)
  const statusCounts: Record<ServerStatus, number> = { healthy: 0, warning: 0, critical: 0, offline: 0 }

  rack.servers.forEach((server) => {
    const firstUnit = Math.max(1, server.startU)
    const lastUnit = Math.min(rack.totalUnits, server.startU + server.units - 1)
    for (let unit = firstUnit; unit <= lastUnit; unit += 1) occupied[unit - 1] = true
    statusCounts[server.status] += 1
  })

  const usedUnits = occupied.filter(Boolean).length
  let largestFreeBlock = 0
  let currentFreeBlock = 0
  occupied.forEach((isOccupied) => {
    currentFreeBlock = isOccupied ? 0 : currentFreeBlock + 1
    largestFreeBlock = Math.max(largestFreeBlock, currentFreeBlock)
  })

  return {
    usedUnits,
    availableUnits: rack.totalUnits - usedUnits,
    occupancyPercent: rack.totalUnits > 0 ? usedUnits / rack.totalUnits * 100 : 0,
    largestFreeBlock,
    alertCount: rack.servers.length - statusCounts.healthy,
    statusCounts,
    orderedServers: [...rack.servers].sort((a, b) => b.startU - a.startU),
  }
}

function formatUnitRange(server: ServerData) {
  const first = `U${String(server.startU).padStart(2, '0')}`
  const lastU = server.startU + server.units - 1
  return server.units === 1 ? first : `${first}–U${String(lastU).padStart(2, '0')}`
}

function getFreeUnitBlocks(rack: RackData) {
  const occupied = new Set<number>()
  rack.servers.forEach((server) => {
    for (let unit = server.startU; unit < server.startU + server.units; unit += 1) occupied.add(unit)
  })

  const blocks: { startU: number; units: number }[] = []
  let startU: number | null = null
  for (let unit = 1; unit <= rack.totalUnits + 1; unit += 1) {
    const isFree = unit <= rack.totalUnits && !occupied.has(unit)
    if (isFree && startU === null) startU = unit
    if (!isFree && startU !== null) {
      blocks.push({ startU, units: unit - startU })
      startU = null
    }
  }
  return blocks.sort((a, b) => b.startU - a.startU)
}

function RackUnitMap({
  rack,
  onSelectServer,
}: {
  rack: RackData
  onSelectServer: (server: ServerData) => void
}) {
  const units = useMemo(() => Array.from({ length: rack.totalUnits }, (_, index) => rack.totalUnits - index), [rack.totalUnits])
  const freeBlocks = useMemo(() => getFreeUnitBlocks(rack), [rack])
  const orderedServers = useMemo(() => [...rack.servers].sort((a, b) => b.startU - a.startU), [rack.servers])
  const rowForBlock = (startU: number, height: number) => rack.totalUnits - startU - height + 2

  return (
    <section className="rack-unit-map" aria-labelledby={`rack-unit-map-${rack.id}`}>
      <div className="rack-unit-map-heading">
        {/*
          ⚠️ **다음 단계 처리 필요**: `totalUnits`는 FMS `rackUnits` 미설정 시 42로 대체된 폴백이다.
          지금은 이 컴포넌트가 `orderedServers.length > 0` 게이트 뒤에 있어 렌더되지 않지만,
          u맵(`GET /api/racks/{id}/u-map`)이 붙는 순간 크기 미설정 랙에서 "1U–42U"로 새어 나간다.
          그때 rackUnits 원값을 받아 미설정이면 U맵 자체를 그리지 않도록 바꿀 것.
        */}
        <div><span>PHYSICAL LAYOUT</span><strong id={`rack-unit-map-${rack.id}`}>1U–{rack.totalUnits}U RACK MAP</strong></div>
        <small>FRONT VIEW</small>
      </div>
      <div
        className="rack-unit-map-grid"
        style={{ gridTemplateRows: `repeat(${rack.totalUnits}, 15px)` }}
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
        {orderedServers.map((server) => (
          <button
            className={`rack-unit-device ${server.status}`}
            style={{ gridColumn: 2, gridRow: `${rowForBlock(server.startU, server.units)} / span ${server.units}` }}
            data-units={server.units}
            type="button"
            key={server.id}
            onClick={() => onSelectServer(server)}
            aria-label={`${server.name}, ${formatUnitRange(server)}, ${serverModelLabels[server.model]}, 상태 ${server.status}, 상세 보기`}
            title={`${server.name} · ${formatUnitRange(server)} · ${server.status}`}
          >
            <span><strong>{server.name}</strong><small>{serverModelLabels[server.model]}</small></span>
            <em>{server.status}</em>
          </button>
        ))}
      </div>
      <div className="rack-unit-map-legend"><span><i /> INSTALLED</span><span><i /> AVAILABLE</span></div>
    </section>
  )
}

function getDashboardMetrics(rackData: RackData[]): DashboardMetrics {
  const statusCounts: Record<ServerStatus, number> = { healthy: 0, warning: 0, critical: 0, offline: 0 }
  const modelCounts: Record<ServerModel, number> = {
    'dell-poweredge-r760': 0,
    'hpe-proliant-dl360-gen11': 0,
    'cisco-ucs-c240-m7': 0,
  }
  const incidentTypes: Record<Exclude<ServerStatus, 'healthy'>, string> = {
    warning: 'HEALTH WARNING',
    critical: 'SERVER FAULT',
    offline: 'CONNECTION LOST',
  }
  const rackMetrics = rackData.map((rack) => ({ rack, metrics: getRackMetrics(rack) }))
  const alerts: DashboardAlert[] = []

  rackData.forEach((rack) => {
    rack.servers.forEach((server) => {
      statusCounts[server.status] += 1
      modelCounts[server.model] += 1
      if (server.status !== 'healthy') alerts.push({ rack, server, type: incidentTypes[server.status] })
    })
  })

  const severityOrder: Record<ServerStatus, number> = { critical: 0, offline: 1, warning: 2, healthy: 3 }
  alerts.sort((a, b) => severityOrder[a.server.status] - severityOrder[b.server.status])

  const totalServers = rackData.reduce((total, rack) => total + rack.servers.length, 0)
  const totalUnits = rackData.reduce((total, rack) => total + rack.totalUnits, 0)
  const usedUnits = rackMetrics.reduce((total, item) => total + item.metrics.usedUnits, 0)

  return {
    totalServers,
    totalUnits,
    usedUnits,
    availableUnits: totalUnits - usedUnits,
    occupancyPercent: totalUnits > 0 ? usedUnits / totalUnits * 100 : 0,
    alertCount: alerts.length,
    healthyPercent: totalServers > 0 ? statusCounts.healthy / totalServers * 100 : 0,
    statusCounts,
    modelCounts,
    rackMetrics,
    alerts,
  }
}

/**
 * ⚠️ 생성값(가짜) 기준 온도. 예전 하드코딩 전산실의 평균온도(21.4℃)를 그대로 옮겨 둔 것이며
 *    **실측이 아니다.** `createTemperatureHistory`와 함께 다음 단계에서 제거하고
 *    FMS `GET /api/performance/series/zone`(E19 B4)으로 대체한다.
 */
const PLACEHOLDER_BASE_TEMPERATURE_C = 21.4

/** 생성 차트가 그리는 익명 계열 수 — 생성기의 서로 다른 오프셋 프로파일 수와 같다. */
const SAMPLE_SERIES_COUNT = 4

/** ⚠️ 가짜 시계열 생성기 — D3 제거 대상. 화면에서 실측처럼 보이지 않게 하는 것이 다음 단계 과제. */
function createTemperatureHistory(baseTemperatureCelsius: number, rackData: RackData[]): TemperatureHistoryPoint[] {
  const now = new Date()
  const lastDailyWave = Math.sin((23 - 7) / 24 * Math.PI * 2) * 0.65 + Math.cos(23 / 3) * 0.14
  const baseOffsets = [-0.5, 0.8, -0.4, 0.1]
  const waveWeights = [1, -0.5, -0.3, -0.2]

  return Array.from({ length: 24 }, (_, index) => {
    const timestamp = new Date(now)
    timestamp.setMinutes(0, 0, 0)
    timestamp.setHours(now.getHours() - (23 - index))
    const dailyWave = Math.sin((index - 7) / 24 * Math.PI * 2) * 0.65 + Math.cos(index / 3) * 0.14
    const targetAverage = baseTemperatureCelsius + dailyWave - lastDailyWave
    const oscillation = Math.sin(index * 0.62) * 0.2
    const rawOffsets = rackData.map((_, rackIndex) => (
      (baseOffsets[rackIndex] ?? 0) + oscillation * (waveWeights[rackIndex] ?? 0)
    ))
    const offsetAverage = rawOffsets.length > 0
      ? rawOffsets.reduce((sum, value) => sum + value, 0) / rawOffsets.length
      : 0
    const rackCelsius = Object.fromEntries(rackData.map((rack, rackIndex) => [
      rack.id,
      Number((targetAverage + rawOffsets[rackIndex] - offsetAverage).toFixed(1)),
    ]))
    const roomAverageCelsius = rackData.length > 0
      ? Number((Object.values(rackCelsius).reduce((sum, value) => sum + value, 0) / rackData.length).toFixed(1))
      : Number(targetAverage.toFixed(1))

    return {
      time: `${String(timestamp.getHours()).padStart(2, '0')}:00`,
      roomAverageCelsius,
      rackCelsius,
    }
  })
}

function cloneModel(scene: Group, status?: ServerStatus) {
  const clone = scene.clone(true)
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.castShadow = true
    child.receiveShadow = true
    child.material = child.material.clone()
    if (status && child.name === 'Status_LED') {
      const material = child.material as THREE.MeshStandardMaterial
      material.color.set(statusColors[status])
      material.emissive.set(statusColors[status])
      material.emissiveIntensity = status === 'offline' ? 0.15 : 3
    }
  })
  return clone
}

function Server({
  server,
  showAlert,
  selected,
  interactive,
  onSelect,
}: {
  server: ServerData
  showAlert: boolean
  selected: boolean
  interactive: boolean
  onSelect: (server: ServerData) => void
}) {
  const modelUrl = assetUrl(`models/${server.model}.glb?v=${MODEL_VERSION}`)
  const { scene } = useGLTF(modelUrl, GLTF_USE_DRACO, GLTF_USE_MESHOPT)
  const model = useMemo(() => cloneModel(scene, server.status), [scene, server.status])
  const ledMaterials = useMemo(() => {
    const materials: THREE.MeshStandardMaterial[] = []
    model.traverse((child) => {
      if (child instanceof THREE.Mesh && child.name === 'Status_LED') {
        materials.push(child.material as THREE.MeshStandardMaterial)
      }
    })
    return materials
  }, [model])
  const alertMaterial = useRef<THREE.MeshBasicMaterial>(null)
  const y = RACK_INNER_BOTTOM + (server.startU - 1 + server.units / 2) * UNIT_HEIGHT
  const hasError = showAlert && server.status !== 'healthy'
  const [hovered, setHovered] = useState(false)
  useCursor(hovered)

  useFrame(({ clock }) => {
    if (!hasError) return
    const pulse = 0.45 + (Math.sin(clock.elapsedTime * (server.status === 'critical' ? 7 : 4)) + 1) * 0.275
    ledMaterials.forEach((material) => {
      material.emissiveIntensity = 2 + pulse * 6
    })
    if (alertMaterial.current) alertMaterial.current.opacity = 0.3 + pulse * 0.65
  })

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
      <primitive object={model} />
      <Html position={[0, 0, 0.63]} center distanceFactor={interactive ? 0.75 : 3.2} zIndexRange={[2, 1]}>
        <button
          className="server-click-target"
          type="button"
          style={{ width: 180, height: server.units === 2 ? 56 : 32 }}
          onClick={(event) => { event.stopPropagation(); onSelect(server) }}
          aria-label={`${server.name} 3D 서버 상세 보기`}
          title={`${server.name} 상세 보기`}
        />
      </Html>
      {(selected || hovered) && (
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.53, server.units * UNIT_HEIGHT + 0.025, 0.76]} />
          <meshBasicMaterial color="#47d4ff" wireframe transparent opacity={selected ? 0.9 : 0.45} toneMapped={false} />
        </mesh>
      )}
      {hasError && (
        <>
          <mesh position={[0, 0, -0.365]}>
            <boxGeometry args={[0.47, server.units * UNIT_HEIGHT + 0.014, 0.012]} />
            <meshBasicMaterial
              ref={alertMaterial}
              color={statusColors[server.status]}
              transparent
              opacity={0.8}
              toneMapped={false}
            />
          </mesh>
          <pointLight
            position={[0, 0, -0.42]}
            color={statusColors[server.status]}
            intensity={server.status === 'critical' ? 2.8 : 1.6}
            distance={0.8}
            decay={2}
          />
          <Html position={[0.31, 0, -0.43]} center distanceFactor={5} occlude>
            <div className={`server-alert ${server.status}`}>
              <i />
              <span><strong>{server.name}</strong>U{server.startU} · {server.status.toUpperCase()}</span>
            </div>
          </Html>
        </>
      )}
    </group>
  )
}

function RackAlert({
  label,
  showLabel = true,
  offsetX = 0,
  offsetY = 0,
}: {
  label: string
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
        <meshBasicMaterial ref={shellMaterial} color="#ff2945" wireframe transparent opacity={0.18} toneMapped={false} />
      </mesh>
      <mesh position={[0, 2.08, -0.46]}>
        <sphereGeometry args={[0.045, 20, 12]} />
        <meshStandardMaterial ref={beaconMaterial} color="#ff1738" emissive="#ff1738" emissiveIntensity={6} />
      </mesh>
      <pointLight ref={beaconLight} position={[0, 2.08, -0.46]} color="#ff1738" intensity={4} distance={2.2} decay={2} />
      {showLabel && (
        <Html position={[0, 2.26, -0.46]} center distanceFactor={7}>
          <div className="rack-alert-badge" style={{ transform: `translate(${offsetX}px, ${offsetY}px)` }}><i /> RACK {label} ATTENTION</div>
        </Html>
      )}
    </group>
  )
}

function Rack({
  rack,
  /** FMS 판정(E19 B1). 랙 경보 표시의 SSOT — 장비 상태(u맵)는 아직 오지 않는다. */
  severity,
  selected,
  selectedServerId,
  heatmap,
  onSelect,
  onSelectServer,
}: {
  rack: RackData
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
  // 예전에는 rack.servers(로컬 상태)로 판단해, u맵 미연동인 지금은 CRITICAL 랙도
  // 정상 랙과 똑같이 그려졌다. FMS 판정을 쓴다.
  const hasIncident = severity !== 'NORMAL'

  return (
    <group
      position={[rack.tileX * TILE_SIZE, 0.06, rack.tileZ * TILE_SIZE]}
      rotation={[0, rack.rotation, 0]}
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
                transform: `translate(${rack.tileX < 6 ? -22 : 22}px, ${rack.tileZ < 7 ? 7 : -7}px)`,
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
          showAlert={hasIncident}
          selected={selectedServerId === server.id}
          interactive={selected}
          onSelect={(selectedServer) => onSelectServer(rack, selectedServer)}
        />
      ))}
      {hasIncident && (
        <RackAlert
          label={rack.label}
          showLabel={!heatmap}
          offsetX={rack.tileX < 6 ? -34 : 34}
          offsetY={rack.tileZ < 7 ? 10 : -10}
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

function FloorTiles({ columns = 18, rows = 14, theme }: { columns?: number; rows?: number; theme: ThemeMode }) {
  const tiles = useMemo(() => Array.from({ length: columns * rows }, (_, index) => ({
    x: index % columns,
    z: Math.floor(index / columns),
  })), [columns, rows])
  const lightTheme = theme === 'light'

  return (
    <group>
      {tiles.map(({ x, z }) => (
        <mesh key={`${x}-${z}`} position={[x * TILE_SIZE, 0, z * TILE_SIZE]} receiveShadow>
          <boxGeometry args={[TILE_SIZE - 0.012, 0.08, TILE_SIZE - 0.012]} />
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
          Math.max(columns, rows) * TILE_SIZE,
          Math.max(columns, rows),
          lightTheme ? '#718598' : '#52637a',
          lightTheme ? '#95a5b2' : '#354256',
        ]}
        position={[(columns - 1) * TILE_SIZE / 2, 0.045, (rows - 1) * TILE_SIZE / 2]}
      />
    </group>
  )
}

function CameraController({ focusRack, focusServer }: { focusRack: RackData | null; focusServer: ServerData | null }) {
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

  useEffect(() => {
    fromPosition.current.copy(camera.position)
    fromTarget.current.copy(controls.current?.target ?? OVERVIEW_CAMERA_TARGET)

    if (focusRack) {
      const rackX = focusRack.tileX * TILE_SIZE
      const rackZ = focusRack.tileZ * TILE_SIZE
      const focusHeight = focusServer
        ? Math.max(0.2, 0.06 + RACK_INNER_BOTTOM + (focusServer.startU - 1 + focusServer.units / 2) * UNIT_HEIGHT)
        : RACK_FOCUS_HEIGHT
      rackForward.current.set(Math.sin(focusRack.rotation), 0, Math.cos(focusRack.rotation))
      toTarget.current.set(rackX, focusHeight, rackZ)
      toPosition.current.copy(toTarget.current).addScaledVector(rackForward.current, RACK_FOCUS_DISTANCE)
    } else {
      toPosition.current.copy(OVERVIEW_CAMERA_POSITION)
      toTarget.current.copy(OVERVIEW_CAMERA_TARGET)
    }

    transition.current = 0
  }, [camera, focusRack, focusServer])

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
  racks,
  focusedRack,
  selectedServer,
  heatmapVisuals,
  rackSeverities,
  theme,
  onFocusRack,
  onSelectServer,
}: {
  racks: RackData[]
  focusedRack: RackData | null
  selectedServer: ServerData | null
  heatmapVisuals: Map<string, RackHeatmapVisual>
  rackSeverities: Map<string, RackSeverity>
  theme: ThemeMode
  onFocusRack: (rack: RackData) => void
  onSelectServer: (rack: RackData, server: ServerData) => void
}) {
  const lightTheme = theme === 'light'

  return (
    <>
      <color attach="background" args={[lightTheme ? '#d5e0e9' : '#071019']} />
      <fog attach="fog" args={[lightTheme ? '#d5e0e9' : '#071019', 12, 28]} />
      <ambientLight intensity={lightTheme ? 1.45 : 1.7} color="#b9d8f3" />
      <hemisphereLight args={['#e5f4ff', lightTheme ? '#728191' : '#425269', lightTheme ? 1.8 : 2.1]} />
      <directionalLight
        position={[6, 10, 7]}
        intensity={3.2}
        color="#e8f4ff"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
      />
      <rectAreaLight position={[3.3, 4.8, 4.2]} rotation={[-Math.PI / 2, 0, 0]} width={8} height={7} intensity={9} color="#d8efff" />
      <pointLight position={[3.3, 2.6, 8.5]} intensity={16} distance={14} decay={1.6} color="#d5edff" />
      <pointLight position={[0.5, 2.2, 4]} intensity={8} distance={10} decay={1.7} color="#6bc8ff" />
      <pointLight position={[7.5, 2.2, 4]} intensity={8} distance={10} decay={1.7} color="#8dd8ff" />
      <Environment resolution={256}>
        <Lightformer intensity={2.2} color="#dceeff" position={[0, 5, -4]} scale={[10, 4, 1]} />
        <Lightformer intensity={1.8} color="#8dccff" position={[-5, 2, 2]} rotation={[0, Math.PI / 2, 0]} scale={[6, 3, 1]} />
        <Lightformer intensity={1.6} color="#ffffff" position={[6, 1, 4]} rotation={[0, -Math.PI / 2, 0]} scale={[5, 2, 1]} />
      </Environment>
      <Suspense fallback={<Loading />}>
        <FloorTiles theme={theme} />
        {racks.map((rack) => (
          <Rack
            key={rack.id}
            rack={rack}
            severity={rackSeverities.get(rack.id) ?? 'NORMAL'}
            selected={focusedRack?.id === rack.id}
            selectedServerId={selectedServer?.id ?? null}
            heatmap={heatmapVisuals.get(rack.id)}
            onSelect={onFocusRack}
            onSelectServer={onSelectServer}
          />
        ))}
        <ContactShadows position={[5.1, 0.055, 3.9]} scale={14} opacity={lightTheme ? 0.25 : 0.38} blur={2.4} far={5} resolution={1024} />
      </Suspense>
      <CameraController focusRack={focusedRack} focusServer={selectedServer} />
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
            <div><dt>TOTAL ASSETS</dt><dd>{totalAssets ?? NO_VALUE}</dd></div>
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
                  <span>
                    <small>ASSETS</small>
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

function ServerDetailPanel({
  rack,
  server,
  incident,
  onBackToRack,
  onOverview,
  onUpdateIncident,
}: {
  rack: RackData
  server: ServerData
  incident?: IncidentRecord
  onBackToRack: () => void
  onOverview: () => void
  onUpdateIncident: (patch: Partial<IncidentRecord>) => void
}) {
  const profile = serverProfiles[server.id]
  const telemetry = [
    { label: 'CPU', value: profile.cpuPercent, suffix: '%', progress: profile.cpuPercent },
    { label: 'MEMORY', value: profile.memoryPercent, suffix: '%', progress: profile.memoryPercent },
    { label: 'STORAGE', value: profile.storagePercent, suffix: '%', progress: profile.storagePercent },
    { label: 'TEMPERATURE', value: profile.temperatureCelsius, suffix: '°C', progress: Math.min(profile.temperatureCelsius / 85 * 100, 100) },
  ]

  return (
    <>
      <div className="server-panel-toolbar">
        <button type="button" onClick={onBackToRack}><span aria-hidden="true">←</span> RACK {rack.label}</button>
        <span><i /> {profile.lastSync}</span>
      </div>

      <p className="panel-title">SERVER DETAIL</p>
      <div className="server-focus-heading">
        <div>
          <strong>{server.name}</strong>
          <span>{profile.role}</span>
        </div>
        <span className={`server-state ${server.status}`}><i />{server.status}</span>
      </div>
      <span className="server-model-name">{serverModelLabels[server.model]}</span>

      <section className="server-location-grid" aria-label="서버 설치 위치">
        <div><span>RACK</span><strong>{rack.label}</strong></div>
        <div><span>POSITION</span><strong>{formatUnitRange(server)}</strong></div>
        <div><span>HEIGHT</span><strong>{server.units}<small> U</small></strong></div>
      </section>

      <section className="server-telemetry">
        <div className="server-section-heading">
          <span>LIVE TELEMETRY</span>
          <small>DEMO SNAPSHOT</small>
        </div>
        <div className="server-metric-grid">
          {telemetry.map((metric) => (
            <article className={metric.progress >= 85 ? 'hot' : ''} key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}<small>{metric.suffix}</small></strong>
              <div><i style={{ width: `${metric.progress}%` }} /></div>
            </article>
          ))}
        </div>
      </section>

      <section className="server-system-info">
        <div className="server-section-heading"><span>SYSTEM INFORMATION</span></div>
        <dl>
          <div><dt>IP ADDRESS</dt><dd>{profile.ipAddress}</dd></div>
          <div><dt>OPERATING SYSTEM</dt><dd>{profile.operatingSystem}</dd></div>
          <div><dt>SERIAL NUMBER</dt><dd>{profile.serialNumber}</dd></div>
          <div><dt>POWER DRAW</dt><dd>{profile.powerWatts} W</dd></div>
          <div><dt>UPTIME</dt><dd>{profile.uptime}</dd></div>
        </dl>
      </section>

      {incident && (
        <section className={`server-incident-workflow ${server.status}`}>
          <div className="server-section-heading">
            <span>INCIDENT RESPONSE</span>
            <small>DEMO WORKFLOW</small>
          </div>
          <div className="incident-response-meta">
            <div><span>DETECTED</span><strong>{incident.detectedAt}</strong></div>
            <div><span>DURATION</span><strong>{incident.duration}</strong></div>
            <div><span>STATE</span><strong>{incident.acknowledged ? 'ACK' : 'OPEN'}</strong></div>
          </div>
          <label className="incident-field">
            <span>ASSIGNEE</span>
            <select value={incident.assignee} onChange={(event) => onUpdateIncident({ assignee: event.target.value })}>
              <option>UNASSIGNED</option>
              <option>NOC L1</option>
              <option>PLATFORM</option>
              <option>DATABASE</option>
              <option>NETWORK</option>
            </select>
          </label>
          <label className="incident-field">
            <span>OPERATOR NOTE <small>AUTO-SAVED</small></span>
            <textarea
              rows={3}
              value={incident.note}
              onChange={(event) => onUpdateIncident({ note: event.target.value })}
              placeholder="장애 조치 메모를 입력하세요."
            />
          </label>
          <button
            className={incident.acknowledged ? 'incident-acknowledge acknowledged' : 'incident-acknowledge'}
            type="button"
            onClick={() => onUpdateIncident({ acknowledged: !incident.acknowledged })}
          >
            <i /> {incident.acknowledged ? '확인 완료 · 다시 열기' : '장애 확인 완료로 표시'}
          </button>
        </section>
      )}

      <section className="server-activity">
        <div className="server-section-heading"><span>RECENT ACTIVITY</span><small>LAST 24H</small></div>
        <div className="server-activity-list">
          {profile.activities.map((activity) => (
            <div className={activity.tone} key={`${activity.time}-${activity.message}`}>
              <time>{activity.time}</time><i /><span>{activity.message}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="server-panel-actions">
        <button type="button" onClick={onBackToRack}><span aria-hidden="true">←</span> 랙 상세</button>
        <button type="button" onClick={onOverview}>전체 보기</button>
      </div>
      <div className="mouse-tip">3D 서버 또는 장비 목록을 클릭해 상세 정보를 확인할 수 있습니다.</div>
    </>
  )
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
    // 랙 요약은 FMS 집계만 쓴다. rack.servers/totalUnits(기본 42U)로 만들면
    // 같은 랙의 상세 패널과 다른 숫자가 나온다 — 한 화면 안의 모순(C6).
    const facts = rackFacts.get(rack.id) ?? null
    const rackResult: AssetSearchResult = {
      id: rack.id,
      kind: 'rack',
      label: `RACK ${rack.label}`,
      subtitle: `${facts ? facts.assetCount : NO_VALUE} ASSETS · `
        + `${facts ? facts.occupiedUnits : NO_VALUE} / ${facts?.rackUnits ?? NO_VALUE}U USED`,
      keywords: `${rack.id} rack ${rack.label} ${facts?.code ?? ''} ${rack.servers.map((server) => server.name).join(' ')}`.toLowerCase(),
      rack,
    }
    const serverResults = rack.servers.map<AssetSearchResult>((server) => {
      const profile = serverProfiles[server.id]
      return {
        id: server.id,
        kind: 'server',
        label: server.name,
        subtitle: `RACK ${rack.label} · ${formatUnitRange(server)} · ${profile?.ipAddress ?? 'IP 미등록'}`,
        keywords: [
          server.id,
          server.name,
          server.model,
          serverModelLabels[server.model],
          server.status,
          rack.id,
          rack.label,
          profile?.role,
          profile?.ipAddress,
          profile?.serialNumber,
          profile?.operatingSystem,
        ].join(' ').toLowerCase(),
        rack,
        server,
      }
    })
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
          placeholder="서버 · IP · 시리얼 · 랙 검색"
          aria-label="서버, IP, 시리얼 또는 랙 검색"
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
              {result.server ? (
                <span className={`asset-result-status ${result.server.status}`}><i />{result.server.status}</span>
              ) : (
                <span className="asset-result-status rack">RACK</span>
              )}
              <span className="asset-result-enter" aria-hidden="true">↵</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="asset-search-empty" role="presentation"><span>⌕</span><strong>검색 결과가 없습니다</strong><small>서버명, IP, 시리얼 또는 랙 이름을 확인하세요.</small></div>
          )}
        </div>
      )}
    </div>
  )
}

function IncidentNavigator({
  active,
  hidden,
  alerts,
  /** 장비 단위 장애 소스(u맵)가 아직 없으면 true — 개수를 0으로 단언하지 않는다(C6). */
  unavailable,
  currentIndex,
  records,
  onToggle,
  onPrevious,
  onNext,
}: {
  active: boolean
  hidden: boolean
  alerts: DashboardAlert[]
  unavailable: boolean
  currentIndex: number
  records: Record<string, IncidentRecord>
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  const current = currentIndex >= 0 ? alerts[currentIndex] : alerts[0]
  const record = current ? records[current.server.id] : undefined

  return (
    <section
      className={`incident-navigator${active ? ' active' : ''}${hidden ? ' dashboard-open' : ''}`}
      aria-label="장애 탐색 모드"
      aria-hidden={hidden}
      inert={hidden}
    >
      <button
        className="incident-mode-toggle"
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        disabled={alerts.length === 0}
      >
        <span className="incident-mode-icon" aria-hidden="true">!</span>
        <span><small>ISSUE NAVIGATOR</small><strong>{active ? 'INCIDENT MODE ACTIVE' : '장애 탐색 모드'}</strong></span>
        <em>{unavailable ? NO_VALUE : String(alerts.length).padStart(2, '0')}</em>
      </button>

      {active && current && (
        <div className="incident-navigator-body" aria-live="polite">
          <div className="incident-navigator-heading">
            <span className={`incident-severity ${current.server.status}`}><i />{current.server.status}</span>
            <strong>{currentIndex + 1} / {alerts.length}</strong>
          </div>
          <div className="incident-navigator-asset">
            <strong>{current.server.name}</strong>
            <span>RACK {current.rack.label} · {formatUnitRange(current.server)}</span>
            <small>{current.type}</small>
          </div>
          <div className="incident-navigator-meta">
            <span>DETECTED <strong>{record?.detectedAt ?? '—'}</strong></span>
            <span>DURATION <strong>{record?.duration ?? '—'}</strong></span>
            <span>OWNER <strong>{record?.assignee ?? 'UNASSIGNED'}</strong></span>
          </div>
          <div className="incident-navigator-actions">
            <button type="button" onClick={onPrevious} aria-label="이전 장애로 이동"><span aria-hidden="true">←</span> PREV</button>
            <button type="button" onClick={onToggle}>EXIT MODE</button>
            <button type="button" onClick={onNext} aria-label="다음 장애로 이동">NEXT <span aria-hidden="true">→</span></button>
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

/**
 * ⚠️ 생성 데이터 차트 — FMS `GET /api/performance/series/zone`(E19 B4) 연동 전까지의 임시물이다.
 *
 * **실제 랙 라벨을 계열 이름으로 쓰지 않는다.** 실 자산 식별자에 가짜 측정값이 붙으면,
 * 같은 랙의 상세 패널이 TEMP `—`라고 말하는 것과 한 화면에서 정면으로 모순된다.
 * 계열은 익명(`샘플 N`)이고, 생성기가 만드는 서로 다른 프로파일 수(4)만큼만 그린다.
 */
function TemperatureHistoryChart({
  points,
  theme,
  active,
}: {
  points: TemperatureHistoryPoint[]
  theme: ThemeMode
  active: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !active) return

    const sampleKeys = Object.keys(points[0]?.rackCelsius ?? {}).slice(0, SAMPLE_SERIES_COUNT)

    const lightTheme = theme === 'light'
    const rackColors = ['#ff9f43', '#7d8cff', '#35c98f', '#c379ef']
    const averageColor = lightTheme ? '#087fa8' : '#63d7ff'
    const axisColor = lightTheme ? '#6a7d8d' : '#60798d'
    const splitLineColor = lightTheme ? '#c9d4dc' : '#223b4d'
    const allValues = points.flatMap((point) => [
      point.roomAverageCelsius,
      ...sampleKeys.map((key) => point.rackCelsius[key]),
    ])
    const yMin = Math.floor(Math.min(...allValues) - 0.8)
    const yMax = Math.ceil(Math.max(...allValues) + 0.8)
    const chart = echarts.init(container, undefined, { renderer: 'canvas' })
    const option: EChartsCoreOption = {
      animationDuration: 650,
      aria: { enabled: true },
      color: [averageColor, ...rackColors],
      tooltip: {
        trigger: 'axis',
        backgroundColor: lightTheme ? '#ffffff' : '#081722f5',
        borderColor: lightTheme ? '#9fb4c3' : '#35556c',
        textStyle: { color: lightTheme ? '#1a2e3e' : '#dce9f5', fontSize: 11 },
        valueFormatter: (value: unknown) => `${Number(value).toFixed(1)} °C`,
      },
      legend: {
        type: 'scroll',
        top: 0,
        left: 0,
        right: 0,
        itemWidth: 16,
        itemHeight: 3,
        itemGap: 16,
        textStyle: { color: axisColor, fontSize: 10, fontFamily: 'ui-monospace, monospace' },
        pageIconColor: averageColor,
        pageIconInactiveColor: lightTheme ? '#aab9c4' : '#3d5668',
        pageTextStyle: { color: axisColor, fontSize: 9 },
      },
      grid: { top: 45, right: 18, bottom: 32, left: 48 },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map((point) => point.time),
        axisLine: { lineStyle: { color: splitLineColor } },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 9, interval: 3 },
      },
      yAxis: {
        type: 'value',
        min: yMin,
        max: yMax,
        splitNumber: 4,
        axisLabel: { color: axisColor, fontSize: 9, formatter: '{value}°' },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: splitLineColor, type: 'dashed' } },
      },
      series: [
        {
          name: '샘플 평균 (생성)',
          type: 'line',
          data: points.map((point) => point.roomAverageCelsius),
          showSymbol: false,
          smooth: 0.32,
          lineStyle: { width: 3, color: averageColor },
          areaStyle: { color: lightTheme ? '#1299c31f' : '#43cfff1a' },
          emphasis: { focus: 'series' },
          z: 5,
        },
        ...sampleKeys.map((key, sampleIndex) => ({
          name: `샘플 ${sampleIndex + 1}`,
          type: 'line' as const,
          data: points.map((point) => point.rackCelsius[key]),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { width: 1.5, color: rackColors[sampleIndex % rackColors.length], opacity: 0.86 },
          emphasis: { focus: 'series' as const, lineStyle: { width: 3 } },
        })),
      ],
    }

    chart.setOption(option)
    const resizeObserver = new ResizeObserver(() => chart.resize())
    resizeObserver.observe(container)
    const resizeFrame = window.requestAnimationFrame(() => chart.resize())

    return () => {
      window.cancelAnimationFrame(resizeFrame)
      resizeObserver.disconnect()
      chart.dispose()
    }
  }, [active, points, theme])

  return (
    <div
      ref={containerRef}
      className="temperature-history-chart"
      role="img"
      aria-label="생성 샘플 온도 추이 그래프 — netis-fms 실측 시계열 미연동"
    />
  )
}

function DataCenterDashboard({
  open,
  onToggle,
  onSelectIncident,
  dataCenter,
  zone,
  rackFacts,
  lastUpdatedAt,
  racks,
  metrics,
  incidentRecords,
  activeIncidentServerId,
  theme,
}: {
  open: boolean
  onToggle: () => void
  onSelectIncident: (rack: RackData, server: ServerData) => void
  dataCenter: ZoneSummary
  zone: ZoneAggregate | null
  rackFacts: Map<string, RackSummary>
  lastUpdatedAt: Date | null
  racks: RackData[]
  metrics: DashboardMetrics
  incidentRecords: Record<string, IncidentRecord>
  activeIncidentServerId: string | null
  theme: ThemeMode
}) {
  // 서버 상태 도넛·모델 믹스는 소스(u맵)가 붙을 때 함께 되살린다 —
  // 지금은 0으로 계산된 그래프를 그리지 않는다.
  const temperatureHistory = useMemo(() => createTemperatureHistory(PLACEHOLDER_BASE_TEMPERATURE_C, racks), [racks])

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
              <article>
                <span>FLEET HEALTH</span>
                <strong>{NO_VALUE}</strong>
                <em>장비 단위 상태 미연동</em>
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

            <article className="dashboard-card temperature-history-card">
              <div className="dashboard-card-heading">
                <div><span>ENVIRONMENT · LAST 24H</span><h3>Temperature trend</h3></div>
                <small>생성 데이터 · FMS 온습도 시계열(E19 B4) 미연동</small>
              </div>
              <TemperatureHistoryChart points={temperatureHistory} theme={theme} active={open} />
              <p className="temperature-history-note"><i /> DEMO TELEMETRY · 실측이 아니다. GET /api/performance/series/zone 연동 시 대체</p>
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

              <article className="dashboard-card model-chart-card">
                <div className="dashboard-card-heading">
                  <div><span>HARDWARE MIX</span><h3>Server models</h3></div>
                </div>
                <p className="rack-source-note">
                  장비 구성은 랙 U맵 연동 후 표시됩니다. 현재 FMS 등록 자산
                  {' '}{zone ? `${zone.assetCount}대` : NO_VALUE}.
                </p>
              </article>
            </section>

            <section className="dashboard-card incident-card">
              <div className="dashboard-card-heading">
                <div><span>OPERATIONS</span><h3>Active incidents</h3></div>
                {/* 장애 목록의 SSOT는 FMS 티켓(GET /api/tickets)이며 아직 연동 전이다. */}
                <small>{zone ? `${zone.alertRackCount} RACKS NOT NORMAL` : NO_VALUE}</small>
              </div>
              <div className="incident-table" aria-label="활성 장애 목록">
                <div className="incident-row incident-head" aria-hidden="true">
                  <span>SEVERITY</span><span>TYPE</span><span>ASSET</span><span>LOCATION</span><span>DETECTED / AGE</span><span>MODEL</span>
                </div>
                {metrics.alerts.map(({ rack, server, type }) => {
                  const incident = incidentRecords[server.id]
                  return (
                    <button
                      className={activeIncidentServerId === server.id ? 'incident-row active' : 'incident-row'}
                      type="button"
                      key={server.id}
                      onClick={() => onSelectIncident(rack, server)}
                      aria-label={`${server.name}, RACK ${rack.label}, ${server.status}, 상세 보기`}
                    >
                      <span className={`incident-severity ${server.status}`}><i />{server.status}</span>
                      <strong>{type}</strong>
                      <span>{server.name}</span>
                      <span>RACK {rack.label} · {formatUnitRange(server)}</span>
                      <span>{incident ? `${incident.detectedAt} · ${incident.duration}` : '—'}</span>
                      <span>{serverModelLabels[server.model]}</span>
                    </button>
                  )
                })}
                {metrics.alerts.length === 0 && (
                  <div className="incident-empty">
                    장애 목록은 아직 netis-fms와 연동되지 않았습니다 (GET /api/tickets).
                    {zone && zone.alertRackCount > 0
                      ? ` 현재 판정이 정상이 아닌 랙 ${zone.alertRackCount}대 — 랙을 클릭해 상세를 확인하세요.`
                      : ''}
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
          <i />{zone ? `${zone.alertRackCount} ALERT RACKS` : `${NO_VALUE} ALERTS`}
        </span>
        <span className="dashboard-chevron" aria-hidden="true">{open ? '⌄' : '⌃'}</span>
      </button>
    </>
  )
}

/**
 * 저장된 3D 배치를 읽는다.
 * `revision`은 값을 쓰지 않고 재조회 시점만 정하는 키다(localStorage는 React 상태가 아니라
 * 값이 바뀌어도 리렌더가 걸리지 않으므로, 에디터 저장 후 이 값을 올려 다시 읽게 한다).
 */
function readPlacements(zoneId: number | null, revision: number): Map<string, RackPlacement> {
  void revision
  if (zoneId === null) return new Map<string, RackPlacement>()
  return loadRackPlacements(String(zoneId))
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
}: {
  onRetry: () => void
  busy: boolean
  className?: string
  children: string
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
      {coolingDown ? '잠시 후 다시 시도' : children}
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
  const [view, setView] = useState<'monitor' | 'editor'>('monitor')
  /** 저장된 3D 배치를 다시 읽어야 할 때 올린다(에디터 저장 직후). */
  const [placementVersion, setPlacementVersion] = useState(0)
  const [focusedRackId, setFocusedRackId] = useState<string | null>(null)
  const [selectedServer, setSelectedServer] = useState<ServerData | null>(null)
  const [dashboardOpen, setDashboardOpen] = useState(false)
  const [incidentMode, setIncidentMode] = useState(false)
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>('normal')
  const [incidentRecords, setIncidentRecords] = useState<Record<string, IncidentRecord>>(() => ({ ...initialIncidentRecords }))

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

  /** 저장된 3D 배치(에디터 저장 시 placementVersion이 올라가 다시 읽는다). */
  const placements = useMemo(
    () => readPlacements(selectedZoneId, placementVersion),
    [selectedZoneId, placementVersion],
  )

  /** FMS 랙 목록(SSOT) + 로컬 3D 배치. 랙 내부 장비(U맵)는 S1 범위 밖이라 비어 있다. */
  const racks = useMemo(
    () => (zoneRacks ? buildRacksFromZone(zoneRacks, placements) : []),
    [zoneRacks, placements],
  )

  /**
   * 장비 단위(u맵) 데이터가 아직 없는 상태인가.
   * 랙은 있는데 servers가 전부 비어 있으면 "장애 0건"이 아니라 "모르는 상태"다.
   */
  const serverDataUnavailable = racks.length > 0 && racks.every((rack) => rack.servers.length === 0)

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

  const focusedRackMetrics = useMemo(() => focusedRack ? getRackMetrics(focusedRack) : null, [focusedRack])
  const dashboardMetrics = useMemo(() => getDashboardMetrics(racks), [racks])
  const heatmapDataset = useMemo(() => getHeatmapDataset(racks, heatmapMode, rackFactsById), [racks, heatmapMode, rackFactsById])
  const activeHeatmapMode = heatmapMode === 'normal' ? null : heatmapMode
  const activeIncidentIndex = selectedServer
    ? dashboardMetrics.alerts.findIndex(({ server }) => server.id === selectedServer.id)
    : -1
  const selectedIncidentRecord = selectedServer && selectedServer.status !== 'healthy' ? incidentRecords[selectedServer.id] : undefined
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
    return { tone: 'live', label: 'LIVE', detail: `마지막 갱신 ${time}` }
  })()

  const focusedRackFacts = focusedRack ? rackFactsById.get(focusedRack.id) ?? null : null
  const focusedRackOccupancy = rackOccupancyPercent(focusedRackFacts)
  const focusedRackAvailable = rackAvailableUnits(focusedRackFacts)

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
  /** 에디터는 localStorage 배치만 바꾼다. 랙 자체는 FMS가 SSOT라 다시 읽어 반영한다. */
  const handleEditorSave = () => {
    setPlacementVersion((current) => current + 1)
    setSelectedServer(null)
    setIncidentMode(false)
    setView('monitor')
  }

  const clearFocus = () => {
    setFocusedRackId(null)
    setSelectedServer(null)
    setIncidentMode(false)
  }
  const handleFocusRack = (rack: RackData) => {
    setFocusedRackId(rack.id)
    setSelectedServer(null)
    setDashboardOpen(false)
    setIncidentMode(false)
  }
  const handleSelectServer = (rack: RackData, server: ServerData) => {
    setFocusedRackId(rack.id)
    setSelectedServer(server)
    setDashboardOpen(false)
    setIncidentMode(server.status !== 'healthy')
  }
  const focusIncident = (index: number) => {
    if (dashboardMetrics.alerts.length === 0) {
      setIncidentMode(false)
      return
    }
    const normalizedIndex = (index % dashboardMetrics.alerts.length + dashboardMetrics.alerts.length) % dashboardMetrics.alerts.length
    const incident = dashboardMetrics.alerts[normalizedIndex]
    handleSelectServer(incident.rack, incident.server)
  }
  const toggleIncidentMode = () => {
    if (incidentMode) {
      setIncidentMode(false)
      return
    }
    focusIncident(activeIncidentIndex >= 0 ? activeIncidentIndex : 0)
  }
  const updateSelectedIncident = (patch: Partial<IncidentRecord>) => {
    if (!selectedServer) return
    setIncidentRecords((current) => {
      const existing = current[selectedServer.id] ?? {
        detectedAt: '—', duration: '—', acknowledged: false, assignee: 'UNASSIGNED', note: '',
      }
      return { ...current, [selectedServer.id]: { ...existing, ...patch } }
    })
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

  if (view === 'editor') {
    return (
      <LayoutEditor
        dataCenter={{
          id: String(selectedDataCenter.id),
          code: selectedDataCenter.code ?? NO_VALUE,
          name: selectedDataCenter.name,
        }}
        initialRacks={racks}
        theme={theme}
        onSave={handleEditorSave}
        onCancel={() => setView('monitor')}
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
          랙 목록을 아직 못 받은 상태(로딩·실패·권한 없음)에서 에디터에 들어가면 빈 배치를
          저장해 그 전산실의 저장된 좌표가 전부 지워진다. 랙이 0대일 때도 마찬가지다 —
          `200 + []`는 null이 아니라 통과해 버리므로 길이도 함께 본다(배치할 랙이 없으면 열 이유도 없다).
        */}
        <button
          className="theme-toggle layout-edit-button"
          type="button"
          onClick={() => setView('editor')}
          disabled={zoneRacks === null || zoneRacks.length === 0}
          aria-label="랙 배치 에디터 열기"
          title={
            zoneRacks === null
              ? '랙 목록을 불러온 뒤 사용할 수 있습니다'
              : zoneRacks.length === 0
                ? '이 전산실에 배치할 랙이 없습니다'
                : '랙 배치 에디터 열기'
          }
        >
          <span className="theme-toggle-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <rect x="4" y="4" width="6.6" height="6.6" rx="1.3" />
              <rect x="13.4" y="4" width="6.6" height="6.6" rx="1.3" />
              <rect x="4" y="13.4" width="6.6" height="6.6" rx="1.3" />
              <path d="m14.6 19.9 5.3-5.3 1.6 1.6-5.3 5.3-2.2.6Z" />
            </svg>
          </span>
          <span className="theme-toggle-copy"><small>FLOOR PLAN</small><strong>LAYOUT EDIT</strong></span>
        </button>
        <ThemeToggle theme={theme} onToggle={toggleTheme} className="rack-theme-toggle" />
        <div className="summary">
          <span><strong>{racks.length}</strong> RACKS</span>
          {/* 장비 수는 FMS 랙 집계의 assetCount 합. 3D 씬의 servers(u맵 미연동)를 세지 않는다. */}
          <span><strong>{zoneAggregate ? zoneAggregate.assetCount : NO_VALUE}</strong> ASSETS</span>
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
              racks={racks}
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
              <RetryButton onRetry={racksResource.retryNow} busy={racksResource.loading}>
                지금 새로고침
              </RetryButton>
            </div>
          ) : zoneRacks && zoneRacks.length === 0 ? (
            <p className="scene-state" role="status">이 전산실에 등록된 랙이 없습니다.</p>
          ) : null}
        </div>

        <IncidentNavigator
          active={incidentMode}
          hidden={dashboardOpen}
          alerts={dashboardMetrics.alerts}
          unavailable={serverDataUnavailable}
          currentIndex={activeIncidentIndex}
          records={incidentRecords}
          onToggle={toggleIncidentMode}
          onPrevious={() => focusIncident((activeIncidentIndex >= 0 ? activeIncidentIndex : 0) - 1)}
          onNext={() => focusIncident((activeIncidentIndex >= 0 ? activeIncidentIndex : -1) + 1)}
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
              incident={selectedIncidentRecord}
              onBackToRack={() => { setSelectedServer(null); setIncidentMode(false) }}
              onOverview={clearFocus}
              onUpdateIncident={updateSelectedIncident}
            />
          ) : focusedRack && focusedRackMetrics ? (
            <>
              <p className="panel-title">RACK DETAIL</p>
              <div className="rack-focus-heading">
                <strong className="rack-focus-name">RACK {focusedRack.label}</strong>
                {/* 판정은 FMS 원값(severity)이 SSOT다. 로컬 서버 상태는 u맵 미연동이라 항상 0이었다. */}
                <span className={focusedRackFacts && focusedRackFacts.severity !== 'NORMAL' ? 'rack-state attention' : 'rack-state healthy'}>
                  <i /> {focusedRackFacts
                    ? (focusedRackFacts.severity === 'NORMAL' ? 'HEALTHY' : severityLabels[focusedRackFacts.severity] ?? focusedRackFacts.severity)
                    : NO_VALUE}
                </span>
              </div>
              <span className="rack-focus-meta">FRONT · LEVEL VIEW</span>

              {/*
                **이 패널의 U 수치는 전부 FMS 집계에서만 파생한다.**
                로컬 계산값(getRackMetrics)은 u맵 미연동이라 servers가 비어 있어
                "OCCUPIED 20U / AVAILABLE 42U"처럼 한 화면에서 모순된 숫자를 낸다.
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

              <div className="rack-stat-grid">
                <div>
                  <span>ASSETS</span>
                  <strong>{focusedRackFacts ? focusedRackFacts.assetCount : NO_VALUE}</strong>
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
                  {/* 연속 빈 구간은 U별 배치(u맵)를 알아야 계산된다 — 점유 U 합계로는 낼 수 없다. */}
                  <span>MAX BLOCK</span>
                  <strong>{NO_VALUE}</strong>
                </div>
              </div>
              <p className="rack-source-note">MAX BLOCK(연속 빈 구간)은 랙 U맵 연동 후 표시됩니다.</p>

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
                    <strong>{focusedRackFacts ? severityLabels[focusedRackFacts.severity] ?? focusedRackFacts.severity : NO_VALUE}</strong>
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
                장비 단위 상태(healthy/warning/critical/offline)와 U별 배치도는 둘 다 u맵이 있어야
                나온다. servers가 비어 있는 지금 그대로 그리면 "전 장비 정상 0대"·"전 U 비어 있음"이라는
                거짓 화면이 된다 — 소스가 붙기 전까지는 그리지 않고 미연동임을 밝힌다(C6).
              */}
              {focusedRackMetrics.orderedServers.length > 0 ? (
                <>
                  <section className="rack-health">
                    <p className="rack-subtitle">HEALTH</p>
                    <div className="rack-health-grid">
                      {(Object.keys(statusColors) as ServerStatus[]).map((status) => (
                        <span key={status}>
                          <i style={{ background: statusColors[status], boxShadow: `0 0 8px ${statusColors[status]}` }} />
                          {status}<strong>{focusedRackMetrics.statusCounts[status]}</strong>
                        </span>
                      ))}
                    </div>
                  </section>

                  <RackUnitMap rack={focusedRack} onSelectServer={(server) => handleSelectServer(focusedRack, server)} />
                </>
              ) : (
                <section className="rack-health">
                  <p className="rack-subtitle">U MAP · HEALTH</p>
                  <p className="rack-source-note">
                    랙 U 배치도와 장비 상태는 아직 netis-fms와 연동되지 않았습니다
                    (GET /api/racks/&#123;id&#125;/u-map).
                  </p>
                </section>
              )}

              <section className="rack-equipment">
                <p className="rack-subtitle">INSTALLED EQUIPMENT</p>
                {/*
                  랙 내부 장비(U맵)는 `GET /api/racks/{id}/u-map`으로 가져와야 하며 S1 범위 밖이다.
                  값이 없을 때 0대·빈 목록처럼 보이지 않도록 미연동임을 밝힌다(C6·C7).
                */}
                {focusedRackMetrics.orderedServers.length === 0 && (
                  <p className="rack-source-note">
                    장착 장비 목록은 아직 netis-fms와 연동되지 않았습니다
                    {focusedRackFacts ? ` (FMS 등록 자산 ${focusedRackFacts.assetCount}대).` : '.'}
                  </p>
                )}
                <div className="equipment-list">
                  {focusedRackMetrics.orderedServers.map((server) => (
                    <button
                      className="equipment-item"
                      key={server.id}
                      type="button"
                      onClick={() => handleSelectServer(focusedRack, server)}
                      aria-label={`${server.name} 상세 보기`}
                    >
                      <span className="equipment-unit">{formatUnitRange(server)}</span>
                      <span className="equipment-copy">
                        <strong>{server.name}</strong>
                        <small>{serverModelLabels[server.model]}</small>
                      </span>
                      <span className="equipment-status" title={server.status}>
                        <i style={{ background: statusColors[server.status], boxShadow: `0 0 8px ${statusColors[server.status]}` }} />
                        {server.units}U
                      </span>
                      <span className="equipment-open" aria-hidden="true">›</span>
                    </button>
                  ))}
                </div>
              </section>

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
            {(Object.entries(statusColors) as [ServerStatus, string][]).map(([status, color]) => (
              <span key={status}><i style={{ background: color, boxShadow: `0 0 10px ${color}` }} />{status}</span>
            ))}
          </div>
        )}

        <DataCenterDashboard
          open={dashboardOpen}
          onToggle={() => setDashboardOpen((current) => !current)}
          onSelectIncident={handleSelectServer}
          dataCenter={selectedDataCenter}
          zone={zoneAggregate}
          rackFacts={rackFactsById}
          lastUpdatedAt={racksResource.lastUpdatedAt}
          racks={racks}
          metrics={dashboardMetrics}
          incidentRecords={incidentRecords}
          activeIncidentServerId={incidentMode ? selectedServer?.id ?? null : null}
          theme={theme}
        />
      </section>
    </main>
  )
}

export default App
