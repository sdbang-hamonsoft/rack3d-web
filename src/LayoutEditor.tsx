import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  GRID_COLUMNS,
  GRID_ROWS,
  cloneRackList,
  degreesToRadians,
  getSeedRacks,
  radiansToDegrees,
  saveRacksForDataCenter,
} from './rackLayouts'
import type { RackData } from './rackLayouts'

const ARMED_TIMEOUT = 3000
const SNAPBACK_FLASH_DURATION = 500
const SAVED_FLASH_DURATION = 1200
const COMPACT_CELL_SIZE = 40

type ThemeMode = 'dark' | 'light'
type RackFacing = 'bottom' | 'right' | 'top' | 'left'
type ArmedAction = 'delete' | 'reset' | 'cancel'

type DragState = {
  rackId: string
  originX: number
  originZ: number
  currentX: number
  currentZ: number
  moved: boolean
}

type SnapbackState = {
  rackId: string
  offsetX: number
  offsetZ: number
  settling: boolean
}

const facingGlyphs: Record<RackFacing, string> = { bottom: '▼', right: '▶', top: '▲', left: '◀' }

function getRackFacing(rotation: number): RackFacing {
  const degrees = radiansToDegrees(rotation)
  if (degrees >= 45 && degrees < 135) return 'right'
  if (degrees >= 135 && degrees < 225) return 'top'
  if (degrees >= 225 && degrees < 315) return 'left'
  return 'bottom'
}

function createRackLabel(racks: RackData[]) {
  const usedLabels = new Set(racks.map((rack) => rack.label.trim().toUpperCase()))
  let sequence = 1
  while (usedLabels.has(`R-${String(sequence).padStart(2, '0')}`)) sequence += 1
  return `R-${String(sequence).padStart(2, '0')}`
}

function createRackId(dataCenterId: string, racks: RackData[]) {
  const shortName = dataCenterId.split('-')[0] || dataCenterId
  const usedIds = new Set(racks.map((rack) => rack.id))
  let sequence = racks.length + 1
  while (usedIds.has(`rack-${shortName}-${String(sequence).padStart(2, '0')}`)) sequence += 1
  return `rack-${shortName}-${String(sequence).padStart(2, '0')}`
}

function LayoutEditor({
  dataCenter,
  initialRacks,
  theme,
  onSave,
  onCancel,
}: {
  dataCenter: { id: string; code: string; name: string }
  initialRacks: RackData[]
  theme: ThemeMode
  onSave: (racks: RackData[]) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<RackData[]>(() => cloneRackList(initialRacks))
  const [selectedRackId, setSelectedRackId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [ghostCell, setGhostCell] = useState<{ x: number; z: number } | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [snapback, setSnapback] = useState<SnapbackState | null>(null)
  const [armedAction, setArmedAction] = useState<ArmedAction | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [cellSize, setCellSize] = useState(48)
  const boardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const armedTimer = useRef<number | null>(null)
  const snapbackTimer = useRef<number | null>(null)
  const savedTimer = useRef<number | null>(null)
  const suppressBoardClick = useRef(false)

  const selectedRack = useMemo(
    () => draft.find((rack) => rack.id === selectedRackId) ?? null,
    [draft, selectedRackId],
  )
  const occupiedTiles = useMemo(() => {
    const tiles = new Map<string, string>()
    draft.forEach((rack) => tiles.set(`${rack.tileX}:${rack.tileZ}`, rack.id))
    return tiles
  }, [draft])
  const duplicateLabel = useMemo(() => {
    if (!selectedRack) return false
    const normalized = selectedRack.label.trim().toUpperCase()
    return normalized.length > 0
      && draft.some((rack) => rack.id !== selectedRack.id && rack.label.trim().toUpperCase() === normalized)
  }, [draft, selectedRack])

  useEffect(() => {
    dragRef.current = drag
  }, [drag])

  useEffect(() => () => {
    if (armedTimer.current !== null) window.clearTimeout(armedTimer.current)
    if (snapbackTimer.current !== null) window.clearTimeout(snapbackTimer.current)
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current)
  }, [])

  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    const observer = new ResizeObserver(() => setCellSize(board.clientWidth / GRID_COLUMNS))
    observer.observe(board)
    return () => observer.disconnect()
  }, [])

  const disarm = () => {
    if (armedTimer.current !== null) window.clearTimeout(armedTimer.current)
    armedTimer.current = null
    setArmedAction(null)
  }
  const arm = (action: ArmedAction) => {
    if (armedTimer.current !== null) window.clearTimeout(armedTimer.current)
    setArmedAction(action)
    armedTimer.current = window.setTimeout(() => {
      armedTimer.current = null
      setArmedAction(null)
    }, ARMED_TIMEOUT)
  }

  const selectRack = (rackId: string | null) => {
    disarm()
    setSelectedRackId(rackId)
  }

  const mutateDraft = (updater: (current: RackData[]) => RackData[]) => {
    setDraft(updater)
    setDirty(true)
  }

  const isTileFree = (x: number, z: number, ignoreRackId?: string) => {
    const owner = occupiedTiles.get(`${x}:${z}`)
    return owner === undefined || owner === ignoreRackId
  }

  const tileFromPointer = (clientX: number, clientY: number) => {
    const board = boardRef.current
    if (!board) return null
    const rect = board.getBoundingClientRect()
    const x = Math.min(GRID_COLUMNS - 1, Math.max(0, Math.floor((clientX - rect.left) / rect.width * GRID_COLUMNS)))
    const z = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((clientY - rect.top) / rect.height * GRID_ROWS)))
    return { x, z }
  }

  const placeNewRack = (x: number, z: number) => {
    const id = createRackId(dataCenter.id, draft)
    const label = createRackLabel(draft)
    mutateDraft((current) => [
      ...current,
      { id, label, totalUnits: 42, tileX: x, tileZ: z, rotation: 0, servers: [] },
    ])
    setPlacing(false)
    setGhostCell(null)
    selectRack(id)
  }

  const moveSelectedRack = (deltaX: number, deltaZ: number) => {
    if (!selectedRack) return
    const nextX = selectedRack.tileX + deltaX
    const nextZ = selectedRack.tileZ + deltaZ
    if (nextX < 0 || nextX >= GRID_COLUMNS || nextZ < 0 || nextZ >= GRID_ROWS) return
    if (!isTileFree(nextX, nextZ, selectedRack.id)) return
    mutateDraft((current) => current.map((rack) => (
      rack.id === selectedRack.id ? { ...rack, tileX: nextX, tileZ: nextZ } : rack
    )))
  }

  const rotateSelectedRack = () => {
    if (!selectedRack || saved) return
    mutateDraft((current) => current.map((rack) => (
      rack.id === selectedRack.id
        ? { ...rack, rotation: degreesToRadians(radiansToDegrees(rack.rotation) + 90) }
        : rack
    )))
  }

  const deleteRack = (rackId: string) => {
    mutateDraft((current) => current.filter((rack) => rack.id !== rackId))
    selectRack(null)
  }

  const requestDeleteSelectedRack = () => {
    if (!selectedRack || saved) return
    if (selectedRack.servers.length === 0) {
      deleteRack(selectedRack.id)
      return
    }
    if (armedAction === 'delete') {
      deleteRack(selectedRack.id)
      return
    }
    arm('delete')
  }

  const requestReset = () => {
    if (saved) return
    if (armedAction !== 'reset') {
      arm('reset')
      return
    }
    disarm()
    setDraft(getSeedRacks(dataCenter.id))
    setDirty(true)
    setSelectedRackId(null)
    setPlacing(false)
    setGhostCell(null)
  }

  const requestCancel = () => {
    if (saved) return
    if (!dirty) {
      onCancel()
      return
    }
    if (armedAction !== 'cancel') {
      arm('cancel')
      return
    }
    disarm()
    onCancel()
  }

  const handleSave = () => {
    if (!dirty || saved) return
    disarm()
    setPlacing(false)
    setGhostCell(null)
    if (!saveRacksForDataCenter(dataCenter.id, draft)) {
      // 영속화 실패 — 성공으로 위장하지 않고 UNSAVED 상태를 유지한 채 경고를 띄운다.
      setSaveFailed(true)
      return
    }
    setSaveFailed(false)
    setDirty(false)
    setSaved(true)
    savedTimer.current = window.setTimeout(() => {
      savedTimer.current = null
      onSave(draft)
    }, SAVED_FLASH_DURATION)
  }

  const togglePlacing = () => {
    if (saved) return
    selectRack(null)
    setGhostCell(null)
    setPlacing((current) => !current)
  }

  const startDrag = (rack: RackData, clientX: number, clientY: number) => {
    if (saved || placing || snapback) return
    const tile = tileFromPointer(clientX, clientY)
    if (!tile) return
    selectRack(rack.id)
    setDrag({ rackId: rack.id, originX: rack.tileX, originZ: rack.tileZ, currentX: rack.tileX, currentZ: rack.tileZ, moved: false })
  }

  useEffect(() => {
    if (!drag) return

    const handleMove = (event: PointerEvent) => {
      const tile = tileFromPointer(event.clientX, event.clientY)
      if (!tile) return
      setDrag((current) => {
        if (!current) return current
        if (current.currentX === tile.x && current.currentZ === tile.z) return current
        return {
          ...current,
          currentX: tile.x,
          currentZ: tile.z,
          moved: current.moved || tile.x !== current.originX || tile.z !== current.originZ,
        }
      })
    }
    const handleUp = () => {
      const current = dragRef.current
      setDrag(null)
      if (!current) return
      suppressBoardClick.current = current.moved
      if (current.moved) {
        // 클릭 이벤트가 오지 않는 경로(pointercancel, 보드 밖 릴리스)에서 플래그가 남지 않도록 같은 틱 이후 해제
        window.setTimeout(() => { suppressBoardClick.current = false }, 0)
      }
      const changed = current.currentX !== current.originX || current.currentZ !== current.originZ
      if (!changed) return
      if (isTileFree(current.currentX, current.currentZ, current.rackId)) {
        mutateDraft((racks) => racks.map((rack) => (
          rack.id === current.rackId ? { ...rack, tileX: current.currentX, tileZ: current.currentZ } : rack
        )))
        return
      }
      setSnapback({
        rackId: current.rackId,
        offsetX: current.currentX - current.originX,
        offsetZ: current.currentZ - current.originZ,
        settling: false,
      })
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, occupiedTiles])

  useEffect(() => {
    if (!snapback || snapback.settling) return
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setSnapback((current) => (current ? { ...current, settling: true } : current))
        snapbackTimer.current = window.setTimeout(() => {
          snapbackTimer.current = null
          setSnapback(null)
        }, SNAPBACK_FLASH_DURATION)
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [snapback])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return
      if (saved) return

      if (event.key === 'Escape') {
        if (placing) {
          setPlacing(false)
          setGhostCell(null)
        } else if (armedAction) {
          disarm()
        } else if (selectedRackId) {
          selectRack(null)
        }
        return
      }
      if (event.key === 'r' || event.key === 'R') {
        rotateSelectedRack()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedRackId) {
          event.preventDefault()
          requestDeleteSelectedRack()
        }
        return
      }
      if (!selectedRackId || drag) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelectedRack(-1, 0) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); moveSelectedRack(1, 0) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelectedRack(0, -1) }
      else if (event.key === 'ArrowDown') { event.preventDefault(); moveSelectedRack(0, 1) }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  const handleBoardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!placing) return
    setGhostCell(tileFromPointer(event.clientX, event.clientY))
  }

  const handleBoardClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (saved) return
    if (suppressBoardClick.current) {
      suppressBoardClick.current = false
      return
    }
    const tile = tileFromPointer(event.clientX, event.clientY)
    if (!tile) return
    if (placing) {
      if (isTileFree(tile.x, tile.z)) placeNewRack(tile.x, tile.z)
      return
    }
    if (isTileFree(tile.x, tile.z)) selectRack(null)
  }

  const ghostInvalid = ghostCell ? !isTileFree(ghostCell.x, ghostCell.z) : false
  const compactBoard = cellSize < COMPACT_CELL_SIZE
  const cells = useMemo(() => Array.from({ length: GRID_COLUMNS * GRID_ROWS }, (_, index) => ({
    x: index % GRID_COLUMNS,
    z: Math.floor(index / GRID_COLUMNS),
  })), [])

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <button
          className="back-button"
          type="button"
          onClick={requestCancel}
          aria-label="편집을 종료하고 3D 모니터링으로 돌아가기"
        >
          <span aria-hidden="true">←</span>
        </button>
        <div className="scene-heading">
          <p className="eyebrow">BURUNET INFRASTRUCTURE</p>
          <h1>{dataCenter.name}</h1>
          <span>{dataCenter.code} · LAYOUT EDITOR</span>
        </div>
        <div className="layout-editor-actions">
          {saveFailed && dirty && !saved ? (
            <span className="layout-editor-unsaved layout-editor-save-failed" role="alert">
              <i /> SAVE FAILED · 브라우저 저장 불가
            </span>
          ) : (
            dirty && !saved && <span className="layout-editor-unsaved"><i /> UNSAVED</span>
          )}
          <button
            className={`overview-button layout-editor-cancel layout-editor-warn${armedAction === 'cancel' ? ' armed' : ''}`}
            type="button"
            onClick={requestCancel}
          >
            {armedAction === 'cancel' ? '변경 사항이 사라집니다 · CONFIRM' : 'CANCEL'}
          </button>
          <button
            className={`layout-editor-save${saved ? ' saved' : ''}`}
            type="button"
            onClick={handleSave}
            disabled={!dirty && !saved}
          >
            {saved ? 'SAVED ✓' : 'SAVE'}
          </button>
        </div>
      </header>

      <div className="layout-editor-body">
        <section className="layout-editor-stage" aria-label={`${dataCenter.name} 랙 배치 편집 영역`}>
          <div className="layout-editor-board-wrap">
            <span className="layout-editor-axis-title x" aria-hidden="true">GRID X →</span>
            <div className="layout-editor-axis-x" aria-hidden="true">
              {Array.from({ length: GRID_COLUMNS }, (_, index) => <span key={index}>{index}</span>)}
            </div>
            <span className="layout-editor-axis-title z" aria-hidden="true">GRID Z ↓</span>
            <div className="layout-editor-axis-z" aria-hidden="true">
              {Array.from({ length: GRID_ROWS }, (_, index) => <span key={index}>{index}</span>)}
            </div>
            <div
              ref={boardRef}
              className={`layout-editor-board${compactBoard ? ' compact' : ''}${placing ? ' placing' : ''}`}
              role="group"
              aria-label="18 × 14 랙 배치 그리드"
              onPointerMove={handleBoardPointerMove}
              onPointerLeave={() => setGhostCell(null)}
              onClick={handleBoardClick}
            >
              {cells.map(({ x, z }) => (
                <div className={(x + z) % 2 ? 'layout-editor-cell alt' : 'layout-editor-cell'} key={`${x}-${z}`} />
              ))}
              {drag && drag.moved && (
                <span
                  className="layout-editor-rack-placeholder"
                  style={{ gridColumn: drag.originX + 1, gridRow: drag.originZ + 1 }}
                  aria-hidden="true"
                />
              )}
              {draft.map((rack) => {
                const facing = getRackFacing(rack.rotation)
                const isDragging = drag?.rackId === rack.id
                const dragCollision = isDragging && drag !== null && drag.moved
                  && !isTileFree(drag.currentX, drag.currentZ, rack.id)
                const isSnapback = snapback?.rackId === rack.id
                const classes = ['layout-editor-rack']
                if (rack.servers.length === 0) classes.push('empty')
                if (selectedRackId === rack.id) classes.push('selected')
                if (isDragging && drag.moved) classes.push('dragging')
                if (dragCollision) classes.push('collision')
                if (isSnapback) classes.push('snapback')
                const transform = isDragging && drag.moved
                  ? `translate(${(drag.currentX - drag.originX) * cellSize}px, ${(drag.currentZ - drag.originZ) * cellSize}px) scale(1.06)`
                  : isSnapback && !snapback.settling
                    ? `translate(${snapback.offsetX * cellSize}px, ${snapback.offsetZ * cellSize}px)`
                    : undefined

                return (
                  <button
                    className={classes.join(' ')}
                    style={{
                      gridColumn: rack.tileX + 1,
                      gridRow: rack.tileZ + 1,
                      transform,
                      transition: isSnapback && !snapback.settling ? 'none' : undefined,
                    }}
                    type="button"
                    key={rack.id}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      event.preventDefault()
                      startDrag(rack, event.clientX, event.clientY)
                    }}
                    onClick={() => { if (!placing && !saved) selectRack(rack.id) }}
                    aria-pressed={selectedRackId === rack.id}
                    aria-label={`랙 ${rack.label}, X ${rack.tileX}, Z ${rack.tileZ}, 서버 ${rack.servers.length}대, 선택`}
                    title={`${rack.label} · X ${rack.tileX} / Z ${rack.tileZ}`}
                  >
                    <span className="layout-editor-rack-name">{rack.label}</span>
                    <span className="layout-editor-rack-sub">
                      {rack.servers.length > 0 ? `${rack.servers.length} SRV` : 'EMPTY'}
                    </span>
                    <span className={`layout-editor-rack-front ${facing}`} aria-hidden="true" />
                  </button>
                )
              })}
              {placing && ghostCell && (
                <div
                  className={`layout-editor-rack ghost${ghostInvalid ? ' invalid' : ''}`}
                  style={{ gridColumn: ghostCell.x + 1, gridRow: ghostCell.z + 1 }}
                  aria-hidden="true"
                >
                  <span className="layout-editor-rack-name">NEW</span>
                </div>
              )}
            </div>
          </div>

          <div className="legend layout-editor-legend" aria-hidden="true">
            <span><i className="layout-editor-legend-servers" /> SERVERS</span>
            <span><i className="layout-editor-legend-empty" /> EMPTY</span>
            <span><i className="layout-editor-legend-collision" /> COLLISION</span>
            <span><i className="layout-editor-legend-front" /> FRONT</span>
          </div>
        </section>

        <aside className="layout-editor-panel">
          {selectedRack ? (
            <>
              <p className="panel-title">RACK PROPERTIES</p>
              <label className="incident-field layout-editor-label-field">
                <span>
                  LABEL
                  {duplicateLabel && <small className="layout-editor-label-warn">중복 라벨</small>}
                </span>
                <input
                  value={selectedRack.label}
                  type="text"
                  maxLength={12}
                  onChange={(event) => {
                    if (saved) return
                    const nextLabel = event.target.value
                    mutateDraft((current) => current.map((rack) => (
                      rack.id === selectedRack.id ? { ...rack, label: nextLabel } : rack
                    )))
                  }}
                  aria-label="랙 라벨 편집"
                />
              </label>

              <section className="server-location-grid" aria-label="랙 배치 좌표">
                <div><span>GRID X</span><strong>{selectedRack.tileX}</strong></div>
                <div><span>GRID Z</span><strong>{selectedRack.tileZ}</strong></div>
                <div><span>FACING</span><strong>{facingGlyphs[getRackFacing(selectedRack.rotation)]} {radiansToDegrees(selectedRack.rotation)}°</strong></div>
              </section>

              <span className="layout-editor-rack-meta">
                SERVERS {selectedRack.servers.length} INSTALLED · {selectedRack.totalUnits}U
              </span>

              <button className="overview-button layout-editor-rotate" type="button" onClick={rotateSelectedRack}>
                <span aria-hidden="true">⟳</span> ROTATE 90°
              </button>

              <div className="layout-editor-divider" aria-hidden="true" />

              <button
                className={`incident-acknowledge layout-editor-danger${armedAction === 'delete' ? ' armed' : ''}`}
                type="button"
                onClick={requestDeleteSelectedRack}
              >
                {armedAction === 'delete' ? '정말 삭제합니까? · CONFIRM' : '✕ 랙 삭제'}
              </button>

              <div className="mouse-tip">드래그: 이동 · 화살표: 1타일 이동 · 빈 타일 클릭: 선택 해제</div>
            </>
          ) : (
            <>
              <p className="panel-title">LAYOUT EDITOR</p>
              <div className="mouse-tip layout-editor-help">
                랙을 클릭해 선택하고, 드래그해 다른 타일로 이동할 수 있습니다.
                {placing ? ' 빈 타일을 클릭하면 새 랙이 배치됩니다.' : ' 새 랙은 아래 버튼으로 추가하세요.'}
              </div>
              <div className="key-row"><kbd>Esc</kbd><span>선택 해제 / 취소</span></div>
              <div className="key-row"><kbd>R</kbd><span>90° 회전</span></div>
              <div className="key-row"><kbd>Del</kbd><span>랙 삭제</span></div>
              <div className="key-row"><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd><span>1타일 이동</span></div>

              <button
                className={`layout-editor-add${placing ? ' active' : ''}`}
                type="button"
                onClick={togglePlacing}
                aria-pressed={placing}
              >
                {placing ? '배치할 타일을 클릭하세요 · 취소' : '+ 랙 추가'}
              </button>
              <button
                className={`overview-button layout-editor-warn${armedAction === 'reset' ? ' armed' : ''}`}
                type="button"
                onClick={requestReset}
              >
                {armedAction === 'reset' ? '현재 배치를 버립니다 · CONFIRM' : '⟲ 기본 배치로 초기화'}
              </button>

              <span className="layout-editor-grid-caption">18 × 14 GRID · TILE 0.6m</span>
            </>
          )}
        </aside>
      </div>
    </main>
  )
}

export default LayoutEditor
