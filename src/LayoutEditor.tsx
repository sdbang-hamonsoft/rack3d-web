import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  GRID_COLUMNS,
  GRID_ROWS,
  cloneRackList,
  degreesToRadians,
  autoArrangeRacks,
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
type ArmedAction = 'reset' | 'cancel'

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
  onSave: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<RackData[]>(() => cloneRackList(initialRacks))
  const [selectedRackId, setSelectedRackId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
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

  const requestReset = () => {
    if (saved) return
    if (armedAction !== 'reset') {
      arm('reset')
      return
    }
    disarm()
    // 랙 목록은 netis-fms가 SSOT다 — 초기화는 "랙을 지우는 것"이 아니라
    // 현재 랙을 기본 격자에 다시 놓는 것이다.
    setDraft(autoArrangeRacks(draft))
    setDirty(true)
    setSelectedRackId(null)
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
      onSave()
    }, SAVED_FLASH_DURATION)
  }

  const startDrag = (rack: RackData, clientX: number, clientY: number) => {
    if (saved || snapback) return
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
        if (armedAction) disarm()
        else if (selectedRackId) selectRack(null)
        return
      }
      if (event.key === 'r' || event.key === 'R') {
        rotateSelectedRack()
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

  const handleBoardClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (saved) return
    if (suppressBoardClick.current) {
      suppressBoardClick.current = false
      return
    }
    const tile = tileFromPointer(event.clientX, event.clientY)
    if (!tile) return
    if (isTileFree(tile.x, tile.z)) selectRack(null)
  }

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
              className={`layout-editor-board${compactBoard ? ' compact' : ''}`}
              role="group"
              aria-label="18 × 14 랙 배치 그리드"
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
                    onClick={() => { if (!saved) selectRack(rack.id) }}
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
              {/*
                랙 이름은 netis-fms `locations.name`이 SSOT다(D1).
                여기서 고쳐 저장해도 3D 씬은 FMS 목록으로 라벨을 다시 채우므로 조용히 버려졌다 —
                입력 → 저장 → 무시의 dead path였고 UI만 "SAVED"라고 말했다.
                추가·삭제를 뺀 것과 같은 이유로 **읽기 전용**으로 바꾼다.
              */}
              <div className="incident-field layout-editor-label-field">
                <span>LABEL</span>
                <output aria-label="랙 라벨">{selectedRack.label}</output>
              </div>
              <p className="layout-editor-source-note">
                랙 이름은 netis-fms에서 관리합니다. 여기서는 배치(이동·회전)만 바꿉니다.
              </p>

              <section className="server-location-grid" aria-label="랙 배치 좌표">
                <div><span>GRID X</span><strong>{selectedRack.tileX}</strong></div>
                <div><span>GRID Z</span><strong>{selectedRack.tileZ}</strong></div>
                <div><span>FACING</span><strong>{facingGlyphs[getRackFacing(selectedRack.rotation)]} {radiansToDegrees(selectedRack.rotation)}°</strong></div>
              </section>

              {/*
                랙 크기·장착 수는 netis-fms가 SSOT다.
                `totalUnits`는 3D 지오메트리용 폴백(미설정 시 42U)이라 여기 그대로 쓰면
                크기 미설정 랙에 42U를 지어내게 된다 — 원값 `rackUnits`를 쓰고 없으면 `—`(C6).
                장착 장비 수도 랙 U맵 미연동이라 항상 0이므로 표시하지 않는다.
              */}
              <span className="layout-editor-rack-meta">
                RACK SIZE {selectedRack.rackUnits ?? '—'}U
              </span>

              <button className="overview-button layout-editor-rotate" type="button" onClick={rotateSelectedRack}>
                <span aria-hidden="true">⟳</span> ROTATE 90°
              </button>

              <div className="mouse-tip">드래그: 이동 · 화살표: 1타일 이동 · 빈 타일 클릭: 선택 해제</div>
            </>
          ) : (
            <>
              <p className="panel-title">LAYOUT EDITOR</p>
              <div className="mouse-tip layout-editor-help">
                랙을 클릭해 선택하고, 드래그해 다른 타일로 이동할 수 있습니다.
              </div>
              {/*
                랙 집합의 SSOT는 netis-fms다(D1) — 여기서 추가한 랙은 저장해도 3D 씬이
                FMS 목록만 신뢰하므로 나타나지 않는다. 그래서 추가·삭제 경로를 걷어내고
                **좌표 편집(이동·회전·라벨)만** 남겼다. 좌표는 E18 연동 전까지 rack3d가
                로컬로 관리하는 유일한 데이터다.
              */}
              <p className="layout-editor-source-note">
                랙 추가·삭제는 netis-fms 자산 관리에서 합니다. 여기서는 배치(이동·회전)만 바꿉니다.
              </p>
              <div className="key-row"><kbd>Esc</kbd><span>선택 해제 / 취소</span></div>
              <div className="key-row"><kbd>R</kbd><span>90° 회전</span></div>
              <div className="key-row"><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd><span>1타일 이동</span></div>

              <button
                className={`overview-button layout-editor-warn${armedAction === 'reset' ? ' armed' : ''}`}
                type="button"
                onClick={requestReset}
              >
                {armedAction === 'reset' ? '현재 배치를 버립니다 · CONFIRM' : '⟲ 자동 배치로 초기화'}
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
