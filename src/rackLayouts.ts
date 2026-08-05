export type ServerStatus = 'healthy' | 'warning' | 'critical' | 'offline'
export type ServerModel = 'dell-poweredge-r760' | 'hpe-proliant-dl360-gen11' | 'cisco-ucs-c240-m7'

export type ServerData = {
  id: string
  name: string
  model: ServerModel
  startU: number
  units: 1 | 2
  status: ServerStatus
}

export type RackData = {
  id: string
  label: string
  totalUnits: number
  tileX: number
  tileZ: number
  rotation: number
  servers: ServerData[]
}

export const GRID_COLUMNS = 18
export const GRID_ROWS = 14
export const LAYOUT_STORAGE_VERSION = 1

export type StoredRack = {
  id: string
  label: string
  totalUnits: number
  gridX: number
  gridZ: number
  rotationDegrees: number
  servers: ServerData[]
}

export type StoredRackLayout = {
  version: number
  updatedAt: string
  racks: StoredRack[]
}

const layoutStorageKey = (dataCenterId: string) => `rack3d-layout:${dataCenterId}`

export function normalizeDegrees(degrees: number) {
  return ((Math.round(degrees) % 360) + 360) % 360
}

export function degreesToRadians(degrees: number) {
  return normalizeDegrees(degrees) * Math.PI / 180
}

export function radiansToDegrees(radians: number) {
  return normalizeDegrees(radians / Math.PI * 180)
}

const seedLayouts: Record<string, RackData[]> = {
  'seoul-main': [
    {
      id: 'rack-a01', label: 'A-01', totalUnits: 42, tileX: 4, tileZ: 4, rotation: 0,
      servers: [
        { id: 'srv-001', name: 'Core API 01', model: 'hpe-proliant-dl360-gen11', startU: 2, units: 1, status: 'healthy' },
        { id: 'srv-002', name: 'Database 01', model: 'dell-poweredge-r760', startU: 5, units: 2, status: 'healthy' },
      ],
    },
    {
      id: 'rack-a02', label: 'A-02', totalUnits: 42, tileX: 7, tileZ: 4, rotation: 0,
      servers: [
        { id: 'srv-004', name: 'Web 01', model: 'hpe-proliant-dl360-gen11', startU: 1, units: 1, status: 'healthy' },
        { id: 'srv-005', name: 'Web 02', model: 'hpe-proliant-dl360-gen11', startU: 3, units: 1, status: 'critical' },
        { id: 'srv-006', name: 'Compute 01', model: 'dell-poweredge-r760', startU: 8, units: 2, status: 'healthy' },
      ],
    },
    {
      id: 'rack-b01', label: 'B-01', totalUnits: 42, tileX: 4, tileZ: 9, rotation: Math.PI,
      servers: [
        { id: 'srv-007', name: 'Backup 01', model: 'cisco-ucs-c240-m7', startU: 4, units: 2, status: 'offline' },
        { id: 'srv-008', name: 'Monitoring 01', model: 'hpe-proliant-dl360-gen11', startU: 12, units: 1, status: 'healthy' },
      ],
    },
    {
      id: 'rack-b02', label: 'B-02', totalUnits: 42, tileX: 7, tileZ: 9, rotation: Math.PI,
      servers: [
        { id: 'srv-009', name: 'GPU Worker 01', model: 'dell-poweredge-r760', startU: 2, units: 2, status: 'warning' },
        { id: 'srv-010', name: 'Network 01', model: 'hpe-proliant-dl360-gen11', startU: 7, units: 1, status: 'healthy' },
        { id: 'srv-011', name: 'Storage 02', model: 'cisco-ucs-c240-m7', startU: 14, units: 2, status: 'healthy' },
      ],
    },
  ],
  'pangyo-edge': [],
  'busan-dr': [],
}

export function cloneRackList(racks: RackData[]): RackData[] {
  return racks.map((rack) => ({ ...rack, servers: rack.servers.map((server) => ({ ...server })) }))
}

export function getSeedRacks(dataCenterId: string): RackData[] {
  return cloneRackList(seedLayouts[dataCenterId] ?? [])
}

function toRackData(stored: StoredRack): RackData {
  return {
    id: stored.id,
    label: stored.label,
    totalUnits: stored.totalUnits,
    tileX: stored.gridX,
    tileZ: stored.gridZ,
    rotation: degreesToRadians(stored.rotationDegrees),
    servers: Array.isArray(stored.servers) ? stored.servers.map((server) => ({ ...server })) : [],
  }
}

export function getRacksForDataCenter(dataCenterId: string): RackData[] {
  try {
    const raw = window.localStorage.getItem(layoutStorageKey(dataCenterId))
    if (!raw) return getSeedRacks(dataCenterId)
    const parsed = JSON.parse(raw) as StoredRackLayout
    if (parsed?.version !== LAYOUT_STORAGE_VERSION || !Array.isArray(parsed.racks)) return getSeedRacks(dataCenterId)
    return parsed.racks.map(toRackData)
  } catch {
    return getSeedRacks(dataCenterId)
  }
}

export function saveRacksForDataCenter(dataCenterId: string, racks: RackData[]): boolean {
  const payload: StoredRackLayout = {
    version: LAYOUT_STORAGE_VERSION,
    updatedAt: new Date().toISOString(),
    racks: racks.map((rack) => ({
      id: rack.id,
      label: rack.label,
      totalUnits: rack.totalUnits,
      gridX: rack.tileX,
      gridZ: rack.tileZ,
      rotationDegrees: radiansToDegrees(rack.rotation),
      servers: rack.servers.map((server) => ({ ...server })),
    })),
  }
  try {
    window.localStorage.setItem(layoutStorageKey(dataCenterId), JSON.stringify(payload))
    return true
  } catch {
    // 쿼터 초과나 프라이빗 모드 등으로 영속화에 실패한 경우 — 호출부가 사용자에게 알린다.
    return false
  }
}
